/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/lib/ambriaFeed.js                                         │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The only way this app reads Ambria Admin's valet bookings.         │
 * │                                                                     │
 * │     ambriaFeed({ from, to, property, events })                       │
 * │       -> { ok, bookings, events, properties, events_error, ... }     │
 * │                                                                     │
 * │     AmbriaFeedError  — thrown on failure, carries .code and .isSetup │
 * │                                                                     │
 * │ HOW IT WORKS                                                        │
 * │   It calls OUR OWN edge function, ambria-bookings, which holds the   │
 * │   shared secret and forwards the request to Ambria. There is no      │
 * │   version of this that talks to Ambria directly: the feed is gated   │
 * │   by a header, and a key in this bundle is not a key, it is a        │
 * │   published string.                                                  │
 * │                                                                     │
 * │   READ-ONLY. Bookings are created and edited in Ambria Admin, which  │
 * │   owns the one-booking-per-venue-per-day constraint and the staffing │
 * │   matrix. There is no write function here, and there should not be.  │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   src/pages/admin/ValetBookings.jsx                                  │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { supabase } from '@/supabase'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'

const FUNCTION_NAME = 'ambria-bookings'

/**
 * The codes that mean SOMEBODY HAS TO GO AND CONFIGURE SOMETHING, as opposed
 * to the ones that mean try again.
 *
 * The distinction earns its keep in the UI: a Retry button against a missing
 * secret is a button that will never work, and offering it sends whoever is
 * looking round the same loop instead of to the dashboard. So these get an
 * explanation and no Retry; everything else gets a Retry.
 */
const SETUP_CODES = new Set([
  'FEED_NOT_CONFIGURED', // our own secrets are missing
  'FORBIDDEN', // Ambria rejected our feed key — a secret needs fixing
  // Not a setup problem in the same sense, but it belongs here for the same
  // reason: a Retry button cannot change whose account you are signed into.
  'ROLE_NOT_ALLOWED',
  'UPSTREAM_BAD_RESPONSE', // not deployed there, or deployed with JWT on
  'UPSTREAM_UNREACHABLE', // AMBRIA_FEED_URL is wrong
  'NO_SUCH_PROPERTY', // a venue code this app should not have sent
])

/**
 * The two codes ambria-bookings returns when it could not make sense of the
 * Authorization header: no bearer token at all, or one GoTrue refused to
 * verify. Both arrive as 401, and BAD_TOKEN's message is the blunt
 * "Your session has expired. Sign in again."
 *
 * They are handled separately below, because most of the time that message is
 * not true. See recoverSession().
 */
const AUTH_FAIL_CODES = new Set(['NO_TOKEN', 'BAD_TOKEN'])

export class AmbriaFeedError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AmbriaFeedError'
    this.code = code
    this.isSetup = SETUP_CODES.has(code)
  }
}

/**
 * ONE round trip to the function.
 *
 * Returns the reply body on success and an AmbriaFeedError on failure —
 * RETURNED, not thrown, because the caller below has to look at the code and
 * decide whether the failure is worth believing.
 */
async function callFeed(body) {
  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, { body })

  // A non-2xx reply arrives here as `error` with the body NOT parsed, so the
  // function's own code and message are inside it and have to be dug out —
  // otherwise every upstream failure reads "Edge Function returned a non-2xx
  // status code", which is true and useless.
  if (error) {
    let code = 'REQUEST_FAILED'
    let message = error.message ?? 'Could not reach the bookings feed.'
    try {
      const parsed = await error.context?.json?.()
      if (parsed?.code) code = String(parsed.code)
      if (parsed?.error) message = String(parsed.error)
    } catch {
      // Leave the generic message. The response was not JSON, which the
      // function already logs on its own side.
    }
    return new AmbriaFeedError(code, message)
  }

  if (!data?.ok) {
    return new AmbriaFeedError(
      String(data?.code ?? 'REQUEST_FAILED'),
      String(data?.error ?? 'The bookings feed refused the request.'),
    )
  }

  return data
}

/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ WHY "YOUR SESSION HAS EXPIRED" WAS USUALLY A LIE                    │
 * │                                                                     │
 * │ This is the screen left open all evening on the porch tablet, and it │
 * │ is the only screen in the app that calls an edge function. That      │
 * │ combination is why it was the only screen ever showing this.         │
 * │                                                                     │
 * │ A hidden tab has its timers throttled and eventually frozen, so      │
 * │ supabase-js never gets to run its own background token refresh. By   │
 * │ the time the tablet is woken the access token is long expired, and   │
 * │ ValetBookings fires a fetch IMMEDIATELY on visibilitychange and on   │
 * │ focus — on a device whose wifi has not finished associating.         │
 * │                                                                     │
 * │ supabase-js does attempt a refresh inside that call. But when the    │
 * │ refresh cannot REACH GoTrue and the access token is genuinely past   │
 * │ its expiry, getSession() hands back null rather than a stale         │
 * │ session. invoke() then falls back to the anon key for the            │
 * │ Authorization header, ambria-bookings asks GoTrue who that is,       │
 * │ GoTrue says nobody, and the function answers BAD_TOKEN — "Your       │
 * │ session has expired. Sign in again."                                 │
 * │                                                                     │
 * │ Nothing about the session had expired. The wifi was down for two     │
 * │ seconds. Ten seconds later the next poll succeeded and the message   │
 * │ cleared itself, which is exactly the "sometimes" in the report.      │
 * │                                                                     │
 * │ So a 401 is not believed until a refresh has been forced and has     │
 * │ actually reached the server to be refused.                          │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Forces a new access token and reports which kind of answer came back:
 *
 *   'live'    — a fresh token is in place; the call is worth repeating
 *   'offline' — the refresh never reached GoTrue, so nothing was proven
 *   'dead'    — GoTrue saw the refresh token and refused it; really signed out
 *
 * refreshSession() is safe to call from here: auth-js serialises concurrent
 * refreshes itself, so a poll and the client's own background refresh landing
 * together share one request rather than racing for the rotated token.
 */
async function recoverSession() {
  // Cheap and decisive when the browser already knows. NOT trusted in the
  // other direction — onLine true only means an interface is up, which on a
  // tablet that just woke is not the same as reachable.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline'

  try {
    const { data, error } = await supabase.auth.refreshSession()
    if (error) {
      // AuthRetryableFetchError is auth-js's own name for "this request never
      // got an answer". A real refusal from GoTrue is an AuthApiError with a
      // status on it. That distinction is the whole fix.
      return isAuthRetryableFetchError(error) ? 'offline' : 'dead'
    }
    return data?.session?.access_token ? 'live' : 'dead'
  } catch {
    // refreshSession() throwing rather than returning an error is a transport
    // failure too. Same verdict: unproven, not dead.
    return 'offline'
  }
}

/**
 * Reads the feed. Throws AmbriaFeedError; never returns a half-answer.
 *
 * `events: false` skips the CRM leg entirely and comes back in about a second,
 * which is what makes a 30-second poll for bookings reasonable while the full
 * call runs every few minutes. See ValetBookings.jsx.
 *
 * NOTE ON `events_error`: it rides alongside `ok: true` and is a WARNING, not a
 * failure — the CRM was unreachable, and `events` is either a few hours stale
 * or empty. It is returned as-is for the caller to render beside the events,
 * because an empty list and a failed fetch need different reactions and
 * collapsing them into "no events" is the misleading outcome.
 */
export async function ambriaFeed({ from, to, property = null, events = true } = {}) {
  if (!from || !to) {
    throw new AmbriaFeedError('BAD_RANGE', 'Choose a date range first.')
  }

  const body = { from, to }
  if (property) body.property = property
  // Sent as the STRING 'false', which is the shape the feed documents. A
  // boolean survives JSON, but matching the documented contract means the two
  // sides cannot disagree about truthiness of the empty string later.
  if (!events) body.events = 'false'

  const first = await callFeed(body)
  if (!(first instanceof AmbriaFeedError)) return first

  // Anything that is not a 401 is the function's real answer. There is nothing
  // to recover from, and retrying would only double the load on Ambria.
  if (!AUTH_FAIL_CODES.has(first.code)) throw first

  // ── ONE recovery attempt, and exactly one ───────────────────────────
  // ValetBookings polls every ten seconds, so the next poll IS the next
  // attempt and it is already spaced out. A loop here would turn one bad
  // minute into a queue of retries against GoTrue.
  const state = await recoverSession()

  if (state === 'offline') {
    // Deliberately NOT a setup code: Retry is the right button for this, and
    // the poll behind it has usually fixed it before anybody presses it.
    throw new AmbriaFeedError(
      'OFFLINE',
      'Could not reach the server. Checking again in a few seconds.',
    )
  }

  if (state === 'dead') {
    // GoTrue was reached and refused the refresh token. NOW the message is the
    // truth, so the function's own wording goes through untouched and the
    // screen says to sign in again.
    throw first
  }

  // A fresh token is in place. This is the call that used to be lost.
  const second = await callFeed(body)
  if (second instanceof AmbriaFeedError) throw second
  return second
}
