// @ts-nocheck — Deno file. See supabase/functions/README.md for why.
/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: supabase/functions/ambria-bookings/index.ts                   │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The one door between this app and Ambria Admin's valet feed. The   │
 * │   browser asks this function; this function holds the shared secret  │
 * │   and asks Ambria.                                                   │
 * │                                                                     │
 * │     POST { from, to, property?, events? }                            │
 * │       -> whatever Ambria answered, passed through untouched          │
 * │                                                                     │
 * │ WHY THIS FILE IS SELF-CONTAINED                                      │
 * │   It imports nothing from ../_shared, unlike every other function     │
 * │   here, and that is deliberate: this one is deployed FROM THE         │
 * │   SUPABASE DASHBOARD, which bundles only the function's own folder.   │
 * │   A `../_shared/http.ts` import fails there with a module-not-found   │
 * │   at deploy time, so the CORS helpers and the caller check are        │
 * │   copied in below.                                                   │
 * │                                                                     │
 * │   The copy is a real cost. If the rule in _shared/caller.ts ever      │
 * │   changes — the "never trust a role from the request body" rule       │
 * │   especially — this file does not inherit the change and has to be    │
 * │   edited too. Deploying with the CLI instead would let it import the  │
 * │   shared version and remove that trap.                                │
 * │                                                                     │
 * │ WHY A PROXY AND NOT A DIRECT CALL                                    │
 * │   Ambria's feed is gated by a header, `x-feed-key`. A key in a Vite   │
 * │   bundle is not a secret — view-source is the whole attack — so the   │
 * │   key lives here as an Edge Function secret and never leaves the      │
 * │   server. This is the mirror image of what Ambria already does to     │
 * │   read our report API, so neither codebase is learning a new shape.   │
 * │                                                                     │
 * │   The alternative that keeps being suggested is Ambria's anon key in  │
 * │   our browser. It must never be accepted: every table on that project │
 * │   carries a permissive "Allow all" policy, so their anon key is full  │
 * │   read AND WRITE on staff, attendance, tasks and repair requests. A   │
 * │   secret that unlocks exactly one read is the right blast radius.     │
 * │                                                                     │
 * │ WHY THE RESPONSE IS PASSED THROUGH RATHER THAN RESHAPED              │
 * │   Ambria owns the meaning of these fields — the staffing snapshot,    │
 * │   the event-matching rule, the venue colours, and `events_error`,     │
 * │   which is a WARNING that rides alongside ok:true. Re-deriving any of │
 * │   it here would put a second opinion in the middle of the wire, and   │
 * │   the two would drift without either side noticing.                  │
 * │                                                                     │
 * │ READ-ONLY, PERMANENTLY                                               │
 * │   Bookings are created, edited and deleted in Ambria Admin only. That │
 * │   app owns the UNIQUE (property, event_date) constraint, the staffing │
 * │   matrix and the event matching; a second writer breaks all three     │
 * │   quietly. There is no write path here and adding one is a decision,  │
 * │   not a patch.                                                       │
 * │                                                                     │
 * │ SECRETS (Supabase dashboard → Edge Functions → Secrets)              │
 * │   AMBRIA_FEED_URL   e.g. https://<ambria-ref>.supabase.co            │
 * │   AMBRIA_FEED_KEY   the shared secret Ambria set as VALET_FEED_KEY    │
 * │                                                                     │
 * │   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the      │
 * │   platform. Never add them by hand.                                   │
 * │                                                                     │
 * │ DEPLOY                                                              │
 * │   Dashboard → Edge Functions → Deploy a new function → paste this.    │
 * │   Name it exactly `ambria-bookings`, and leave JWT verification ON —  │
 * │   the caller must be a signed-in system admin, valet admin or valet   │
 * │   vendor.                                                             │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4'

// ═══════════════════════════════════════════════════════════════════════
// CORS — copied from _shared/http.ts. See the header for why.
//
// Get this wrong and the symptom is genuinely misleading: the browser blocks
// the response before any code here runs, so the app reports that it could not
// send the request at all, while the server log shows a perfectly normal 200.
// ═══════════════════════════════════════════════════════════════════════
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-application-name',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/**
 * Two fields on purpose: `code` is the stable string the frontend switches on,
 * `error` is the sentence shown to the admin. Matching on message text instead
 * is how error handling silently breaks the day somebody rewords a message.
 */
function fail(code: string, error: string, status = 400): Response {
  return json({ ok: false, code, error }, status)
}

const ROLES = {
  SYSTEM_ADMIN: 'system_admin',
  VALET_ADMIN: 'valet_admin',
  OPERATOR: 'operator',
  /** An outside staffing supplier. This screen is their whole account. */
  VALET_VENDOR: 'valet_vendor',
}

/**
 * Who is calling, from the database rather than the request.
 *
 * Copied from _shared/caller.ts, and the rule it exists to enforce is the most
 * important line in this file: THE ROLE IS NEVER READ FROM THE REQUEST BODY.
 * It is looked up by the user id inside the caller's cryptographically-signed
 * JWT. This function holds the service_role key, which bypasses Row Level
 * Security completely — inside here the database has no opinion about who may
 * read what, so every guard has to be written by hand.
 *
 * Custom JWT claims are not trusted either: they can be set, and they go stale
 * the moment somebody's role changes.
 */
async function identifyCaller(req: Request) {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!jwt) {
    return { ok: false, code: 'NO_TOKEN', error: 'Not signed in.', status: 401 }
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  // Signature verification happens server-side inside GoTrue.
  const { data: userData, error: userError } = await admin.auth.getUser(jwt)
  if (userError || !userData?.user) {
    return {
      ok: false,
      code: 'BAD_TOKEN',
      error: 'Your session has expired. Sign in again.',
      status: 401,
    }
  }

  const { data: roleRow, error: roleError } = await admin
    .from('user_roles')
    .select('id, role, property_id, name, phone, is_active')
    .eq('user_id', userData.user.id)
    .maybeSingle()

  if (roleError) {
    console.error('[ambria-bookings] role lookup failed:', roleError.message)
    return {
      ok: false,
      code: 'ROLE_LOOKUP_FAILED',
      error: 'Could not verify your account.',
      status: 500,
    }
  }
  if (!roleRow) {
    return {
      ok: false,
      code: 'NO_ROLE',
      error: 'No role is assigned to your account.',
      status: 403,
    }
  }
  if (roleRow.is_active === false) {
    return { ok: false, code: 'INACTIVE', error: 'Your account has been deactivated.', status: 403 }
  }

  return {
    ok: true,
    caller: { role: roleRow.role, propertyId: roleRow.property_id, phone: roleRow.phone },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// THE FEED
// ═══════════════════════════════════════════════════════════════════════

/**
 * A phone number as its last ten digits.
 *
 * The feed says `valet_phone` arrives "already normalised — bare digits, and
 * the last 10 of them", and tells you to do the same to your own side before
 * comparing. Worth doing rather than trusting: the numbers on file were typed
 * by hand as `9818971578`, `+91 88604 58280` and `86849 50936`, and a compare
 * on raw strings fails on most of those while looking perfectly correct in the
 * code.
 */
function digits10(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '').slice(-10)
}

/**
 * A vendor's own bookings, and nothing else.
 *
 * ── WHY THIS IS HERE AND NOT IN THE BROWSER ───────────────────────────
 * Because filtering in the page would still SEND every vendor every other
 * vendor's bookings — customer names, guest counts, staffing, and each rival
 * firm's contact number — and leave them one DevTools tab away. The rows have
 * to be gone before the response leaves the server.
 *
 * ── MATCHED ON PHONE, PER THE FEED'S OWN INSTRUCTION ──────────────────
 * Not on valet_vendor_id: the two systems keep separate logins, so an Ambria
 * vendor id means nothing on this side. The phone is the one identifier the
 * same person carries into both, and it is the number their account here was
 * created with.
 *
 * ── AN UNASSIGNED BOOKING IS NOT ANYBODY'S ────────────────────────────
 * All four valet_* fields are null both when nobody is assigned and when the
 * assigned firm has been deleted in Ambria. Either way there is no vendor it
 * belongs to, so it is not shown to any vendor — an admin sees it and puts
 * somebody on it, which is what those rows are for.
 *
 * `count` is recomputed. Left alone it would still say 24 beside three rows,
 * and the tiles on the screen read it.
 */
function onlyMine(payload: any, phone: string) {
  const mine = digits10(phone)
  const bookings = Array.isArray(payload?.bookings)
    ? payload.bookings.filter((b: any) => mine && digits10(b?.valet_phone) === mine)
    : []

  return {
    ...payload,
    bookings,
    count: bookings.length,
    // A vendor has no business in the "needs a booking" queue either: those are
    // Ambria's to hand out. Emptied rather than passed through — this function
    // does not request the CRM leg today, and if that changes the answer for a
    // vendor should not silently change with it.
    events: [],
    events_count: 0,
  }
}

/** Ambria's own path. Spelled exactly, or the gateway answers NOT_FOUND. */
const FEED_PATH = '/functions/v1/valet-bookings-feed'

/**
 * Sixty seconds, and it is not generous padding.
 *
 * Measured on the Ambria side: the CRM sweep takes 14–16 seconds every time.
 * Ambria caches it for ten minutes, so most calls skip it — but the call that
 * refreshes the cache pays the full fifteen, and a ten-second timeout turns
 * that into an intermittent error that looks like a network fault and gets
 * chased for an hour. The long timeout is the cheap side of that trade.
 */
const TIMEOUT_MS = 60_000

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return fail('METHOD_NOT_ALLOWED', 'Use POST.', 405)
  }

  // ── 1. WHO IS ASKING ────────────────────────────────────────────────
  // Before the secret is touched.
  const who = await identifyCaller(req)
  if (!who.ok) return fail(who.code, who.error, who.status)

  // AN ALLOW-LIST, not a denial. Written this way the day a fourth role was
  // added it was one entry here rather than an audit of everything that should
  // have been excluded and was not.
  const ALLOWED = [ROLES.SYSTEM_ADMIN, ROLES.VALET_ADMIN, ROLES.VALET_VENDOR]
  if (!ALLOWED.includes(who.caller.role)) {
    // ROLE_NOT_ALLOWED, not FORBIDDEN. This function reports two failures that
    // have nothing to do with each other:
    //
    //   the CALLER's role is not on the list   -> nothing to configure; this
    //                                             person simply has the wrong
    //                                             account for this screen
    //   AMBRIA rejected OUR feed key           -> a secret is wrong and
    //                                             somebody must go and fix it
    //
    // Both were 'FORBIDDEN', which is the same string for "you are the wrong
    // person" and "our credentials are broken" — and the second one is passed
    // through from Ambria's own reply, so the collision was not even ours to
    // control. Anything switching on the code could not tell them apart.
    return fail('ROLE_NOT_ALLOWED', 'This screen is not part of your account.', 403)
  }

  // NOT SCOPED TO THE CALLER'S PROPERTY, deliberately. This feed mirrors what
  // Ambria shows its own valet role, which is every venue — staffing a week is
  // a cross-venue job, and Ambria's five venue codes do not map one-to-one
  // onto this project's four properties anyway. The guest phone, which Ambria
  // does hide from that role, is not in the feed at all.

  // ── 2. THE SECRETS ──────────────────────────────────────────────────
  // Reported BY NAME and never by value. "It is not working" with nothing else
  // cost days on the WhatsApp side; the fix was saying which secret was
  // missing, out loud, at the top.
  const baseUrl = (Deno.env.get('AMBRIA_FEED_URL') ?? '').trim().replace(/\/+$/, '')
  const feedKey = (Deno.env.get('AMBRIA_FEED_KEY') ?? '').trim()

  const missing: string[] = []
  if (!baseUrl) missing.push('AMBRIA_FEED_URL')
  if (!feedKey) missing.push('AMBRIA_FEED_KEY')
  if (missing.length) {
    return fail(
      'FEED_NOT_CONFIGURED',
      `Not set up yet: ${missing.join(' and ')} ${
        missing.length > 1 ? 'are' : 'is'
      } missing from this project's Edge Function secrets.`,
      503,
    )
  }

  // ── 3. THE REQUEST ──────────────────────────────────────────────────
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    return fail('BAD_BODY', 'Send a JSON body with from and to.', 400)
  }

  // Only the four documented parameters are forwarded, and nothing else. A
  // pass-everything proxy hands the caller a way to reach fields Ambria may
  // add later for a different audience.
  const payload: Record<string, unknown> = { from: body.from, to: body.to }
  if (body.property) payload.property = body.property
  if (body.events !== undefined) payload.events = body.events

  // THE RANGE IS NOT VALIDATED HERE. Ambria owns the rules — inclusive dates,
  // the 400-day cap, the five venue codes — and returns BAD_RANGE,
  // RANGE_TOO_WIDE or NO_SUCH_PROPERTY for each. Re-implementing them here
  // means two copies that drift, and the day the cap changes upstream this
  // function starts rejecting requests the feed would have answered.

  // ── 4. THE CALL ─────────────────────────────────────────────────────
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)

  let upstream: Response
  try {
    upstream = await fetch(`${baseUrl}${FEED_PATH}`, {
      method: 'POST',
      headers: { 'x-feed-key': feedKey, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abort.signal,
    })
  } catch (e) {
    // A timeout and a dead host are different things to whoever is looking:
    // one says wait and try again, the other says something is down.
    const timedOut = (e as Error)?.name === 'AbortError'
    console.error('[ambria-bookings] fetch failed:', (e as Error)?.message)
    return fail(
      timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      timedOut
        ? 'Ambria did not answer within a minute. It may be refreshing its CRM cache — try again shortly.'
        : 'Could not reach Ambria Admin. Check AMBRIA_FEED_URL.',
      timedOut ? 504 : 502,
    )
  } finally {
    clearTimeout(timer)
  }

  // ── 5. THE ANSWER ───────────────────────────────────────────────────
  const text = await upstream.text()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON at all. Almost always Supabase's own gateway rather than the
    // feed: the function is not deployed under that name there, or it is
    // deployed with JWT verification on. Say so, because the request is fine.
    console.error(
      `[ambria-bookings] non-JSON from upstream (${upstream.status}):`,
      text.slice(0, 300),
    )
    return fail(
      'UPSTREAM_BAD_RESPONSE',
      `Ambria answered ${upstream.status} with something that is not JSON. Check that valet-bookings-feed is deployed there with JWT verification off.`,
      502,
    )
  }

  // Passed through with Ambria's own status and code. FORBIDDEN here means OUR
  // key is wrong, not the caller's session — the caller was already verified in
  // step 1 — so the message says which, or the next person to see it starts by
  // logging out and back in.
  if (!upstream.ok) {
    const code = String((parsed as any)?.code ?? 'UPSTREAM_ERROR')
    const error =
      code === 'FORBIDDEN'
        ? 'Ambria rejected our feed key. AMBRIA_FEED_KEY does not match the VALET_FEED_KEY set on the Ambria project.'
        : String((parsed as any)?.error ?? `Ambria answered ${upstream.status}.`)
    return json({ ok: false, code, error }, upstream.status)
  }

  // ── A VENDOR GETS ONLY THEIR OWN ────────────────────────────────────
  // The last thing before the reply leaves, so there is no path around it.
  if (who.caller.role === ROLES.VALET_VENDOR) {
    return json(onlyMine(parsed, who.caller.phone), 200)
  }

  // Verbatim for everybody else, events_error and all. See the header.
  return json(parsed, 200)
})
