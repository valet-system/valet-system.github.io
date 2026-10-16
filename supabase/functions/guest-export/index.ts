// @ts-nocheck — Deno file. See supabase/functions/README.md for why.
/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: supabase/functions/guest-export/index.ts                      │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Emails sales@ambria.in a CSV of every guest who came last month —  │
 * │   name and phone, phone as +91XXXXXXXXXX. Run by pg_cron on the 2nd  │
 * │   of each month (migration 0076).                                    │
 * │                                                                     │
 * │ ONE ROW PER PERSON, NOT PER VISIT                                    │
 * │   Deduplicated on the phone number. If somebody came three times the │
 * │   file has one row, carrying the most recent name given. A visit      │
 * │   with no name does not erase a name given on an earlier visit.      │
 * │                                                                     │
 * │ WHICH MONTH                                                          │
 * │   The previous calendar month, by service_date — the 05:30 IST       │
 * │   service day the rest of the app uses, not the clock date.          │
 * │                                                                     │
 * │ WHY IT IS SAFE TO LEAVE PUBLICLY CALLABLE                            │
 * │   Deployed with --no-verify-jwt because pg_net sends no              │
 * │   Authorization header (the same arrangement as push-send and        │
 * │   ambria-bookings-sync). This one moves PERSONAL DATA, so the         │
 * │   reasoning matters:                                                 │
 * │                                                                     │
 * │     * The recipient is fixed in a secret. A caller cannot redirect   │
 * │       the file anywhere; the reply carries no guest data at all.     │
 * │     * It is IDEMPOTENT PER MONTH. guest_export_log records a send,   │
 * │       so a second call finds 'sent' and does nothing — a stranger    │
 * │       hammering it cannot make sales@ receive a second copy.         │
 * │     * Without the key it refuses to run before the 2nd, so it       │
 * │       cannot be provoked early.                                      │
 * │     * Choosing a month, forcing a resend or a dry run needs the      │
 * │       x-export-key header, compared in constant time. An unset key   │
 * │       refuses everything rather than waving it through.              │
 * │                                                                     │
 * │ SECRETS (Supabase → Edge Functions → Secrets — never in chat/code)   │
 * │   RESEND_API_KEY   required                                          │
 * │   GUEST_EXPORT_FROM  required in practice — an address on a domain   │
 * │                    verified in Resend. The fallback below only        │
 * │                    delivers to the Resend account owner.             │
 * │   GUEST_EXPORT_TO  optional, defaults to sales@ambria.in             │
 * │   GUEST_EXPORT_KEY optional, enables manual runs                     │
 * │   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY are platform-injected.     │
 * │                                                                     │
 * │ DEPLOY                                                              │
 * │   supabase functions deploy guest-export --no-verify-jwt             │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4'

const DEFAULT_TO = 'sales@ambria.in'
// Resend's shared test sender. It only delivers to the email address the
// Resend account was created with, so mail to sales@ will not arrive from it.
const FALLBACK_FROM = 'Ambria Valet <onboarding@resend.dev>'
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const PAGE = 1000
const STALE_CLAIM_MS = 10 * 60 * 1000

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/** Constant-time string compare, so the key cannot be guessed by timing. */
function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  }
  return diff === 0
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Today in IST as { y, m (1-12), d } — the clock the business runs on. */
function istToday() {
  const t = new Date(Date.now() + 5.5 * 3600 * 1000)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

/** First and last calendar day of a month, as YYYY-MM-DD, plus a label. */
function monthSpan(y: number, m: number) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return {
    key: `${y}-${pad(m)}`,
    first: `${y}-${pad(m)}-01`,
    last: `${y}-${pad(m)}-${pad(last)}`,
    label: `${MONTHS[m - 1]} ${y}`,
  }
}

/**
 * Normalises a stored phone to +91XXXXXXXXXX, or null if it is not a valid
 * Indian mobile. Mirrors the shapes operator_check_in() sheds, because rows
 * from before that function normalised may still carry a country code.
 */
function toE164(raw: unknown): string | null {
  let p = String(raw ?? '').replace(/\D/g, '')
  if (p.length === 14 && p.startsWith('0091')) p = p.slice(-10)
  else if (p.length === 13 && p.startsWith('910')) p = p.slice(-10)
  else if (p.length === 12 && p.startsWith('91')) p = p.slice(-10)
  else if (p.length === 11 && p.startsWith('0')) p = p.slice(-10)
  return /^[6-9]\d{9}$/.test(p) ? `+91${p}` : null
}

/**
 * One CSV field. Quoted when needed, and a leading = + - @ is defused with an
 * apostrophe: a guest name is typed by staff at a porch, and a name that
 * begins "=" would otherwise run as a formula when the file is opened.
 * (The phone column is written by this code and is exempt — see below.)
 */
function field(v: string, defuse = true): string {
  let s = String(v ?? '')
  if (defuse && /^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** UTF-8 → base64 without blowing the stack on a large file. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply({ ok: false, code: 'METHOD', error: 'POST only.' }, 405)

  const apiKey = Deno.env.get('RESEND_API_KEY') ?? ''
  if (!apiKey) {
    return reply({ ok: false, code: 'NOT_CONFIGURED', error: 'RESEND_API_KEY is not set.' }, 500)
  }
  const to = (Deno.env.get('GUEST_EXPORT_TO') ?? DEFAULT_TO).trim()
  const from = (Deno.env.get('GUEST_EXPORT_FROM') ?? FALLBACK_FROM).trim()

  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    // An empty body is the normal cron call.
  }

  // ── who is asking ─────────────────────────────────────────────────
  const configuredKey = Deno.env.get('GUEST_EXPORT_KEY') ?? ''
  const givenKey = req.headers.get('x-export-key') ?? ''
  const trusted = configuredKey !== '' && givenKey !== '' && sameKey(givenKey, configuredKey)
  const wantsSpecial = body.month != null || body.force === true || body.dry_run === true
  if (wantsSpecial && !trusted) {
    return reply({ ok: false, code: 'FORBIDDEN', error: 'A key is needed for that.' }, 403)
  }

  // ── which month ───────────────────────────────────────────────────
  const today = istToday()
  let y: number, m: number
  if (body.month != null) {
    const mm = /^(\d{4})-(\d{2})$/.exec(String(body.month))
    if (!mm || Number(mm[2]) < 1 || Number(mm[2]) > 12) {
      return reply({ ok: false, code: 'BAD_MONTH', error: 'Use month as YYYY-MM.' }, 400)
    }
    y = Number(mm[1])
    m = Number(mm[2])
  } else {
    // The previous calendar month. Not before the 2nd: the 1st is when the
    // last service day is still closing out.
    if (!trusted && today.d < 2) {
      return reply({ ok: true, skipped: 'too_early', note: 'Runs from the 2nd.' })
    }
    y = today.m === 1 ? today.y - 1 : today.y
    m = today.m === 1 ? 12 : today.m - 1
  }
  const span = monthSpan(y, m)
  const monthDate = span.first

  const db = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  // ── has this month already gone out? ──────────────────────────────
  const force = body.force === true && trusted
  const dry = body.dry_run === true && trusted
  const { data: existing, error: logErr } = await db
    .from('guest_export_log')
    .select('status, claimed_at')
    .eq('month', monthDate)
    .maybeSingle()
  if (logErr) {
    console.error('[guest-export] log read failed:', logErr.message)
    return reply({ ok: false, code: 'DB_FAILED', error: 'Could not read the send log.' }, 500)
  }
  if (!dry && existing && !force) {
    if (existing.status === 'sent') {
      return reply({ ok: true, skipped: 'already_sent', month: span.key })
    }
    if (
      existing.status === 'sending' &&
      Date.now() - new Date(existing.claimed_at).getTime() < STALE_CLAIM_MS
    ) {
      return reply({ ok: true, skipped: 'in_progress', month: span.key })
    }
  }

  // ── read the month's guests ───────────────────────────────────────
  const people = new Map<string, string>() // phone → latest non-empty name
  let visits = 0
  let skippedBadPhone = 0
  for (let from_ = 0; ; from_ += PAGE) {
    const { data, error } = await db
      .from('parked_vehicles')
      .select('guest_name, guest_phone')
      .gte('service_date', span.first)
      .lte('service_date', span.last)
      .order('parked_at', { ascending: true })
      .range(from_, from_ + PAGE - 1)
    if (error) {
      console.error('[guest-export] read failed:', error.message)
      return reply({ ok: false, code: 'DB_FAILED', error: 'Could not read the guests.' }, 500)
    }
    for (const row of data ?? []) {
      visits++
      const phone = toE164(row.guest_phone)
      if (!phone) {
        skippedBadPhone++
        continue
      }
      const name = String(row.guest_name ?? '').trim()
      if (!people.has(phone)) people.set(phone, name)
      else if (name) people.set(phone, name) // later visit wins, never erased by a blank
    }
    if ((data?.length ?? 0) < PAGE) break
  }

  if (dry) {
    return reply({
      ok: true,
      dry_run: true,
      month: span.key,
      visits,
      unique_guests: people.size,
      skipped_bad_phone: skippedBadPhone,
      to,
      from,
    })
  }

  // ── claim the month, so two runs cannot both send ─────────────────
  const claim = await db
    .from('guest_export_log')
    .upsert(
      { month: monthDate, status: 'sending', claimed_at: new Date().toISOString(), error: null },
      { onConflict: 'month' },
    )
  if (claim.error) {
    console.error('[guest-export] claim failed:', claim.error.message)
    return reply({ ok: false, code: 'DB_FAILED', error: 'Could not record the send.' }, 500)
  }

  // ── build the CSV ─────────────────────────────────────────────────
  // The phone column is NOT defused: it is generated here, always +91 then ten
  // digits, so it cannot carry a formula. Defusing it would put an apostrophe
  // in front of every number.
  const rows = ['Guest Name,Phone']
  for (const [phone, name] of people) rows.push(`${field(name)},${field(phone, false)}`)
  // BOM so Excel reads Hindi names as UTF-8; CRLF because that is what CSV is.
  const csv = '﻿' + rows.join('\r\n') + '\r\n'

  const subject = `Ambria Valet - guests for ${span.label} (${people.size})`
  const text =
    `Attached: every guest who used valet parking in ${span.label}.\n\n` +
    `Guests in the file: ${people.size} (one row per phone number)\n` +
    `Total visits that month: ${visits}\n` +
    (skippedBadPhone ? `Left out for an invalid phone number: ${skippedBadPhone}\n` : '') +
    `\nSent automatically on the 2nd of each month.`

  // ── send ──────────────────────────────────────────────────────────
  let res: Response
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Resend de-duplicates on this key, a second line of defence behind the
        // log. A forced resend gets a fresh key so it actually sends.
        'Idempotency-Key': `guest-export-${span.key}${force ? `-${Date.now()}` : ''}`,
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        attachments: [{ filename: `ambria-guests-${span.key}.csv`, content: toBase64(csv) }],
      }),
    })
  } catch (e) {
    await db.from('guest_export_log').update({ status: 'failed', error: String(e?.message ?? e) }).eq('month', monthDate)
    return reply({ ok: false, code: 'SEND_FAILED', error: 'Could not reach the email service.' }, 502)
  }

  const out = await res.json().catch(() => ({}))
  if (!res.ok) {
    const why = String(out?.message ?? out?.error ?? `HTTP ${res.status}`)
    console.error('[guest-export] resend refused:', res.status, why)
    await db.from('guest_export_log').update({ status: 'failed', error: why.slice(0, 500) }).eq('month', monthDate)
    return reply({ ok: false, code: 'SEND_FAILED', error: why }, 502)
  }

  await db
    .from('guest_export_log')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      row_count: people.size,
      recipient: to,
      provider_id: String(out?.id ?? ''),
      error: null,
    })
    .eq('month', monthDate)

  return reply({ ok: true, month: span.key, unique_guests: people.size, visits, sent_to: to })
})
