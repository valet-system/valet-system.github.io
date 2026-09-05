// @ts-nocheck — Deno file. See supabase/functions/README.md for why.
/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: supabase/functions/ambria-bookings-sync/index.ts              │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Notices bookings that are new to us and tells the valet firm they  │
 * │   were given to. Run by pg_cron every two minutes.                   │
 * │                                                                     │
 * │ WHY A POLLER AND NOT A WEBHOOK                                       │
 * │   Because the bookings live in AMBRIA's database and nothing there   │
 * │   calls us. There is no event to subscribe to and no row of ours     │
 * │   that changes when a booking is made, so a trigger has nothing to   │
 * │   fire on. The only way to learn about a booking is to look.          │
 * │                                                                     │
 * │   Asking a webhook of the Ambria side would be the better shape and  │
 * │   a much larger conversation: it means an endpoint here, a secret     │
 * │   both ways, and their booking form calling us on save. Worth doing   │
 * │   if the two-minute delay ever matters; it does not today.            │
 * │                                                                     │
 * │ WHY ONE INSERT DOES BOTH NOTIFICATIONS                               │
 * │   push_outbox is the push queue AND the in-app bell's feed — the      │
 * │   bell reads that table directly, scoped by RLS. So a single row      │
 * │   produces the phone notification and the in-app one, and they        │
 * │   cannot disagree about what happened. A trigger on the table nudges  │
 * │   push-send over pg_net.                                             │
 * │                                                                     │
 * │ IDEMPOTENT, WHICH IS WHAT MAKES IT SAFE TO EXPOSE                     │
 * │   Deployed with --no-verify-jwt, because pg_net sends no             │
 * │   Authorization header — the same arrangement push-send has. That     │
 * │   makes it publicly callable, so it must be harmless to call twice    │
 * │   or a thousand times: ambria_booking_seen is the record of what has  │
 * │   been announced, and a second run finds nothing to do.               │
 * │                                                                     │
 * │   A stranger hammering it costs a feed read against Ambria and        │
 * │   nothing else. Worth knowing rather than assuming.                   │
 * │                                                                     │
 * │ SECRETS — the same two the browser-facing proxy uses                  │
 * │   AMBRIA_FEED_URL, AMBRIA_FEED_KEY                                    │
 * │   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are platform-injected.   │
 * │                                                                     │
 * │ DEPLOY                                                              │
 * │   supabase functions deploy ambria-bookings-sync --no-verify-jwt \    │
 * │     --project-ref <valet-ref>                                        │
 * │   Or from the dashboard, with "Verify JWT" OFF.                       │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4'

/**
 * How far ahead to look.
 *
 * The feed refuses a range wider than 400 days, and a booking can be made a
 * year out — the doc's own example is dated 2027. Looking the whole way means a
 * booking made today for next February is announced today, when it is news,
 * rather than months later when the window finally reaches it.
 *
 * There is no row cap and no paging on this feed, and Ambria enforces one
 * booking per venue per day, so the widest possible answer is five a day. One
 * call, about a second.
 */
const DAYS_AHEAD = 399

/**
 * `event_time` as a 12-hour clock, WITHOUT parsing it into a Date.
 *
 * A duplicate of prettyEventTime in ValetBookings.jsx, and it has to be: that
 * is a browser module and this is Deno, with no shared import between them.
 * Worth the copy for four lines — the alternative is a notification that says
 * 17:00 while the screen it links to says 5:00 PM about the same booking.
 *
 * ONE SHAPE IS CONVERTED and everything else passes through untouched. The
 * field is free text from the CRM and the real values are not one thing:
 * "9:00 AM", "18:00", "7 PM onwards". A bare HH:MM is the only form a reader
 * cannot already understand and the only one unambiguous enough to rewrite;
 * `new Date("7 PM onwards")` is Invalid Date.
 */
function pretty12h(raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''

  const m = /^(\d{1,2}):([0-5]\d)$/.exec(value)
  if (!m) return value

  const hour = Number(m[1])
  if (hour > 23) return value

  // 0 and 12 both show as 12 — midnight is 12 AM, noon is 12 PM.
  const shown = hour % 12 === 0 ? 12 : hour % 12
  return `${shown}:${m[2]} ${hour < 12 ? 'AM' : 'PM'}`
}

/** Last ten digits. See the note in ambria-bookings/index.ts. */
function digits10(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '').slice(-10)
}

function isoDay(offset: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

Deno.serve(async () => {
  const baseUrl = (Deno.env.get('AMBRIA_FEED_URL') ?? '').trim().replace(/\/+$/, '')
  const feedKey = (Deno.env.get('AMBRIA_FEED_KEY') ?? '').trim()

  if (!baseUrl || !feedKey) {
    // Named, not guessed at. "It is not working" with nothing else cost days on
    // the WhatsApp side of this project.
    const missing = [!baseUrl && 'AMBRIA_FEED_URL', !feedKey && 'AMBRIA_FEED_KEY'].filter(Boolean)
    console.error('[bookings-sync] missing secrets:', missing.join(', '))
    return new Response(JSON.stringify({ ok: false, code: 'NOT_CONFIGURED', missing }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  // ── 1. WHAT AMBRIA HAS ──────────────────────────────────────────────
  let feed: any
  try {
    const res = await fetch(`${baseUrl}/functions/v1/valet-bookings-feed`, {
      method: 'POST',
      headers: { 'x-feed-key': feedKey, 'content-type': 'application/json' },
      // events: false — the CRM leg costs ~15s when Ambria's cache expires and
      // an unbooked event has no vendor to notify by definition.
      body: JSON.stringify({ from: isoDay(0), to: isoDay(DAYS_AHEAD), events: 'false' }),
      signal: AbortSignal.timeout(60_000),
    })
    feed = await res.json()
    if (!res.ok || !feed?.ok) {
      console.error('[bookings-sync] feed refused:', res.status, feed?.code, feed?.error)
      return new Response(JSON.stringify({ ok: false, code: feed?.code ?? 'FEED_FAILED' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  } catch (e) {
    console.error('[bookings-sync] feed unreachable:', (e as Error)?.message)
    return new Response(JSON.stringify({ ok: false, code: 'FEED_UNREACHABLE' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const bookings: any[] = Array.isArray(feed.bookings) ? feed.bookings : []

  // ── 2. WHAT WE HAVE ALREADY ANNOUNCED ───────────────────────────────
  const { data: seenRows, error: seenErr } = await db
    .from('ambria_booking_seen')
    .select('booking_id, valet_phone')

  if (seenErr) {
    console.error('[bookings-sync] seen table unreadable:', seenErr.message)
    return new Response(JSON.stringify({ ok: false, code: 'NOT_MIGRATED' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const seen = new Map<string, string>()
  for (const r of seenRows ?? []) seen.set(String(r.booking_id), digits10(r.valet_phone))

  // ── 3. THE FIRST RUN ANNOUNCES NOTHING ──────────────────────────────
  // Every booking already in Ambria is "new to us" the first time this runs.
  // Without this the first tick would push one notification per existing
  // booking — a year of them, all at once, to whoever happened to be assigned.
  // The table is seeded silently instead, and the next run notifies genuinely
  // new work.
  const seeding = (seenRows ?? []).length === 0

  // ── 4. WHO EACH ONE BELONGS TO ──────────────────────────────────────
  // Matched on PHONE, per the feed's instruction: the two systems keep separate
  // logins, so Ambria's vendor id means nothing here. Both sides normalised to
  // the last ten digits, because the numbers on file were hand-typed with
  // spaces and +91 prefixes.
  const { data: vendors, error: vendorErr } = await db
    .from('user_roles')
    .select('id, phone')
    .eq('role', 'valet_vendor')
    .eq('is_active', true)
    .is('deleted_at', null)

  if (vendorErr) {
    console.error('[bookings-sync] vendor lookup failed:', vendorErr.message)
    return new Response(JSON.stringify({ ok: false, code: 'VENDOR_LOOKUP_FAILED' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const vendorByPhone = new Map<string, string>()
  for (const v of vendors ?? []) {
    const key = digits10(v.phone)
    if (key) vendorByPhone.set(key, v.id)
  }

  // ── 5. WHAT CHANGED ─────────────────────────────────────────────────
  const notifications: Record<string, unknown>[] = []
  const toRecord: Record<string, unknown>[] = []
  let reassigned = 0

  for (const b of bookings) {
    const id = String(b?.id ?? '')
    if (!id) continue

    const phone = digits10(b?.valet_phone)
    const known = seen.get(id)

    // Unchanged since the last look.
    if (known !== undefined && known === phone) continue

    toRecord.push({
      booking_id: id,
      valet_phone: phone || null,
      event_date: b?.event_date ?? null,
    })

    if (seeding) continue

    // An unassigned booking has nobody to tell. It is not dropped from the
    // record — recording it is what stops it counting as new for ever — but
    // there is no vendor to notify until Ambria puts somebody on it, and that
    // change comes back through here as a reassignment.
    if (!phone) continue

    const userRoleId = vendorByPhone.get(phone)
    if (!userRoleId) {
      // The firm has no account here, or its number does not match. Logged
      // rather than silent: this is the single most likely reason somebody
      // reports "my vendor gets no notifications", and the number is the fix.
      console.warn(`[bookings-sync] no active vendor account for phone ending ${phone.slice(-4)}`)
      continue
    }

    // Still counted: the summary and the log are where somebody debugging wants
    // to know whether a booking was created or moved, even though the vendor
    // is told the same thing either way.
    const isReassignment = known !== undefined
    if (isReassignment) reassigned += 1

    const venue = b?.property_name ?? b?.property ?? ''
    const staff = Number(b?.staff_total ?? 0)

    notifications.push({
      user_role_id: userRoleId,
      // ── ONE TITLE FOR BOTH CASES ──────────────────────────────────
      // It said "Booking moved to you" when a booking changed hands and "New
      // valet booking" when one was created. That distinction is real on
      // AMBRIA's side and means nothing on the receiving end: whether the
      // booking was just made or taken off another firm, what reached this
      // vendor is a job they did not have a minute ago. "Moved to you" also
      // implied they could see where it moved from, and they cannot.
      //
      // The two are still told apart in the summary and the log, which is where
      // somebody debugging needs them.
      title: 'New booking',
      body:
        `${b?.event_date ?? ''} · ${venue}` +
        (pretty12h(b?.event_time) ? ` · ${pretty12h(b.event_time)}` : '') +
        (staff ? ` · ${staff} staff` : ''),
      url: '/vendor/bookings',
      // UNIQUE PER ANNOUNCEMENT, not per booking. Chrome REPLACES a
      // notification that reuses a tag, and does it silently — a silent
      // replacement is not an alert. Migration 0025 in this project has the
      // full reasoning.
      tag: `ambria-booking-${id}-${Date.now()}`,
      // Not critical. A guest is not standing anywhere; this is next week's
      // work, and the critical flag is reserved for a car waiting now.
      critical: false,
    })
  }

  // ── 6. RECORD FIRST, THEN NOTIFY ────────────────────────────────────
  // This order matters. If the insert into push_outbox succeeded and then the
  // record failed, the next run would find the booking new again and announce
  // it a second time — every two minutes, for ever. Recorded first, the worst
  // case is a notification that never arrives, which is far better than an
  // alarm nobody can stop.
  if (toRecord.length) {
    const { error } = await db
      .from('ambria_booking_seen')
      .upsert(toRecord, { onConflict: 'booking_id' })
    if (error) {
      console.error('[bookings-sync] could not record:', error.message)
      return new Response(JSON.stringify({ ok: false, code: 'RECORD_FAILED' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  if (notifications.length) {
    const { error } = await db.from('push_outbox').insert(notifications)
    if (error) console.error('[bookings-sync] could not queue notifications:', error.message)
  }

  const summary = {
    ok: true,
    seeded: seeding ? toRecord.length : 0,
    announced: notifications.length,
    reassigned,
    scanned: bookings.length,
  }
  console.log('[bookings-sync]', JSON.stringify(summary))
  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
