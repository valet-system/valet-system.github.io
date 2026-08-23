// @ts-nocheck — Deno file. See supabase/functions/README.md for why.
/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: supabase/functions/valet-report/index.ts                      │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   A read-only HTTP API over the valet analytics, for ANOTHER APP on  │
 * │   another Supabase project — Ambria Admin (ambria-workforce).        │
 * │                                                                     │
 * │     /properties   the four sites, for a picker                       │
 * │     /summary      everything one analytics screen draws              │
 * │     /operators    per-operator workload                              │
 * │     /by-property  the four sites compared                            │
 * │     /records      the rows behind the spreadsheet export (PAGED)     │
 * │                                                                     │
 * │   Nothing in THIS app calls it. The valet admin and system admin    │
 * │   screens call the RPCs directly with the signed-in user's JWT,      │
 * │   which is scoped by the database. This exists only because a        │
 * │   different project's JWT means nothing here.                       │
 * │                                                                     │
 * │ ── WHY AN API AND NOT "JUST SHARE THE ANON KEY" ─────────────────────│
 * │   Ambria Admin's users have no row in this project's user_roles, so  │
 * │   auth.uid() is null and every reporting function refuses them.      │
 * │   Handing over an anon key would not help: the anon key grants       │
 * │   nothing without a user, and the functions are revoked from anon.   │
 * │                                                                     │
 * │   The alternative — giving their users accounts HERE too — means a   │
 * │   second login and two places to deactivate someone who leaves.      │
 * │   A server-to-server key is one secret, held by one server.          │
 * │                                                                     │
 * │ ── WHY THERE ARE NO CORS HEADERS, DELIBERATELY ──────────────────────│
 * │   This must NOT be callable from a browser, because a browser cannot │
 * │   hold a secret — anything in a Vite bundle is public, and this key  │
 * │   reads every property's figures.                                    │
 * │                                                                     │
 * │   Omitting Access-Control-Allow-Origin is what enforces that. A      │
 * │   fetch() from their frontend fails on the CORS check before the     │
 * │   response is readable, so the wrong integration breaks loudly at    │
 * │   once instead of shipping a leaked key quietly.                      │
 * │                                                                     │
 * │   Their frontend calls THEIR OWN Edge Function; that function holds  │
 * │   the key and calls this. See VALET_REPORT_API.md.                    │
 * │                                                                     │
 * │ ── WHY IT RE-EXPOSES RPCs INSTEAD OF QUERYING TABLES ────────────────│
 * │   Because the aggregation must stay in Postgres. A quarter is tens   │
 * │   of thousands of rows per property, and PostgREST returns a SHORT   │
 * │   LIST WITH NO ERROR when a row ceiling is hit — the caller would    │
 * │   draw a confident, wrong chart. Migration 0011 exists for that      │
 * │   reason and this endpoint does not undo it.                          │
 * │                                                                     │
 * │ SECRETS (Supabase dashboard → Edge Functions → Secrets)              │
 * │   REPORT_API_KEY             the shared key callers must present     │
 * │   SUPABASE_URL               auto-injected                            │
 * │   SUPABASE_SERVICE_ROLE_KEY  auto-injected                            │
 * │                                                                     │
 * │ DEPENDS ON migration 0037 (report_api) — without it every read       │
 * │ returns FORBIDDEN, because analytics_scope has no service branch.    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Responses. Local rather than imported from ../_shared/http.ts, for the two
 * reasons wa-dispatch gives: that helper attaches CORS headers, which this
 * function must not have, and the dashboard editor deploys only the file you
 * paste, so a sibling import fails to bundle.
 */
const HEADERS = { 'Content-Type': 'application/json' }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS })
}

function fail(status: number, code: string, message: string) {
  return json({ ok: false, code, error: message }, status)
}

/**
 * Constant-time key comparison.
 *
 * A plain `a === b` on strings returns as soon as two bytes differ, so the time
 * it takes leaks how much of the key was right. That is a real attack against a
 * static secret an attacker can probe: guess a byte, keep whichever guess was
 * measurably slower, repeat.
 *
 * Comparing SHA-256 digests instead means every comparison is the same 32-byte
 * walk regardless of where — or whether — the inputs diverge. Digests also make
 * the lengths equal, so length alone stops being a hint.
 */
async function keyMatches(presented: string, expected: string) {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))

  const [a, b] = await Promise.all([digest(presented), digest(expected)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** YYYY-MM-DD, and a real date — 2026-02-31 parses as March 3 if you let it. */
function readDate(value: string | null, name: string) {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequest(`${name} must look like 2026-08-23`)
  }
  const [y, m, d] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(y, m - 1, d))
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    throw new BadRequest(`${name} is not a real date`)
  }
  return value
}

/**
 * A uuid, or null for "every property".
 *
 * Validated here rather than left to Postgres because an invalid uuid reaches
 * it as a 22P02 cast error, which surfaces to the caller as an opaque database
 * message about invalid input syntax for type uuid. Cheaper to say which
 * parameter was wrong.
 */
function readUuid(value: string | null, name: string) {
  if (!value) return null
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequest(`${name} must be a uuid`)
  }
  return value
}

/**
 * A whole number in range, or the default.
 *
 * Bounded here as well as in the RPC because a caller that asks for 100000 and
 * silently receives 1000 has no way to tell it was clamped — it looks like the
 * data ran out. Refusing says which parameter was wrong.
 */
function readInt(value: string | null, name: string, def: number, min: number, max: number) {
  if (value === null || value === '') return def
  if (!/^\d+$/.test(value)) throw new BadRequest(`${name} must be a whole number`)
  const n = Number(value)
  if (n < min || n > max) throw new BadRequest(`${name} must be between ${min} and ${max}`)
  return n
}

class BadRequest extends Error {}

Deno.serve(async (req) => {
  // No OPTIONS handler on purpose — see the header. A preflight gets the same
  // 405 as any other unsupported method, which is what makes a browser call
  // fail rather than succeed.
  if (req.method !== 'GET') {
    return fail(405, 'METHOD', 'Use GET.')
  }

  // ── AUTH ──────────────────────────────────────────────────────────────
  const expected = Deno.env.get('REPORT_API_KEY') ?? ''

  // An unset secret must refuse everything. Treating "no key configured" as
  // "no key required" is how a staging deploy ends up world-readable.
  if (expected.length < 32) {
    console.error('[valet-report] REPORT_API_KEY is missing or too short (<32 chars)')
    return fail(503, 'NOT_CONFIGURED', 'This endpoint is not configured.')
  }

  const presented = req.headers.get('X-API-Key') ?? ''
  if (!(await keyMatches(presented, expected))) {
    // Deliberately vague to the caller, specific in the log. Which of "no key"
    // and "wrong key" it was is useful to us and a probing aid to anyone else.
    console.warn('[valet-report] rejected a call:', presented ? 'wrong key' : 'no key')
    return fail(401, 'UNAUTHORISED', 'Bad or missing X-API-Key.')
  }

  const url = new URL(req.url)
  // Everything after the function name, so both /valet-report/summary and a
  // bare /valet-report?report=summary style deployment behave the same.
  const endpoint = url.pathname.split('/').filter(Boolean).pop() ?? ''
  const q = url.searchParams

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  )

  try {
    const from = readDate(q.get('from'), 'from')
    const to = readDate(q.get('to'), 'to')
    const propertyId = readUuid(q.get('property_id'), 'property_id')

    if (from && to && from > to) {
      return fail(400, 'BAD_RANGE', 'from is after to.')
    }

    switch (endpoint) {
      /**
       * The four properties, so the caller can build a picker instead of
       * hardcoding uuids — they differ between this project and any other.
       */
      case 'properties': {
        const { data, error } = await supabase
          .from('properties')
          .select('id, name, is_active')
          .order('name')
        if (error) return dbFail('properties', error)
        return json({ ok: true, properties: data ?? [] })
      }

      /**
       * Everything the analytics page draws, in one object. Shape is
       * analytics_summary's jsonb, passed through untouched — see
       * VALET_REPORT_API.md for the fields.
       */
      case 'summary': {
        const { data, error } = await supabase.rpc('analytics_summary', {
          p_property_id: propertyId,
          p_from: from,
          p_to: to,
        })
        if (error) return dbFail('analytics_summary', error)
        return json({ ok: true, summary: data })
      }

      /** Per-operator workload over the range. */
      case 'operators': {
        const { data, error } = await supabase.rpc('analytics_by_operator', {
          p_from: from,
          p_to: to,
          p_property_id: propertyId,
        })
        if (error) return dbFail('analytics_by_operator', error)
        return json({ ok: true, operators: data ?? [] })
      }

      /**
       * The four properties side by side. Takes no property_id — comparing one
       * property with itself is what /summary is for.
       */
      case 'by-property': {
        const { data, error } = await supabase.rpc('analytics_by_property', {
          p_from: from,
          p_to: to,
        })
        if (error) return dbFail('analytics_by_property', error)
        return json({ ok: true, properties: data ?? [] })
      }

      /**
       * The rows behind the spreadsheet export — one per car.
       *
       * PAGED, and the caller must loop. The RPC clamps p_limit to 1000, so a
       * quarter at a busy property is several calls. `total` is returned on
       * every page so the caller knows when to stop; it comes off the rows'
       * own total_count, which the RPC computes before the limit is applied.
       *
       * Why paging is not hidden inside this function: a single call that
       * looped internally would hold one HTTP request open for the length of
       * five heavy queries, and Edge Functions have a wall-clock ceiling. A
       * caller that pages can also stop early, show progress, and retry one
       * page instead of the whole export.
       */
      case 'records': {
        const limit = readInt(q.get('limit'), 'limit', 1000, 1, 1000)
        const offset = readInt(q.get('offset'), 'offset', 0, 0, 1_000_000)
        const search = q.get('query')

        const { data, error } = await supabase.rpc('vehicle_records', {
          p_from: from,
          p_to: to,
          p_property_id: propertyId,
          p_query: search && search.trim() !== '' ? search : null,
          p_limit: limit,
          p_offset: offset,
        })
        if (error) return dbFail('vehicle_records', error)

        const rows = data ?? []
        return json({
          ok: true,
          // total_count is repeated on every row; lift it out so the caller is
          // not reading a per-row field to learn a per-query fact. Zero rows
          // means zero total — there is no row to read it from.
          total: rows.length ? Number(rows[0].total_count ?? 0) : 0,
          limit,
          offset,
          records: rows,
        })
      }

      default:
        return fail(
          404,
          'NO_SUCH_REPORT',
          'Unknown report. Try properties, summary, operators, by-property or records.',
        )
    }
  } catch (thrown) {
    if (thrown instanceof BadRequest) return fail(400, 'BAD_REQUEST', thrown.message)
    console.error('[valet-report] threw:', thrown)
    return fail(500, 'UNEXPECTED', 'Something went wrong.')
  }
})

/**
 * Database errors: logged in full, summarised to the caller.
 *
 * PGRST202 is worth naming separately because it means the migration has not
 * been run, and that is the one failure the caller can neither cause nor fix by
 * retrying — it should read as "tell the valet team", not as a transient fault.
 */
function dbFail(fn: string, error: { code?: string; message?: string }) {
  console.error(`[valet-report] ${fn} failed:`, error.code, error.message)

  if (error.code === 'PGRST202' || (error.message ?? '').includes('Could not find the function')) {
    return fail(
      503,
      'NOT_MIGRATED',
      'The reporting functions are not installed. Migration 0037 (report_api) has not been run.',
    )
  }
  if ((error.message ?? '').includes('FORBIDDEN')) {
    return fail(
      503,
      'NOT_MIGRATED',
      'The database refused a server read. Migration 0037 (report_api) has not been run.',
    )
  }
  return fail(502, 'DB_ERROR', 'Could not read the figures.')
}
