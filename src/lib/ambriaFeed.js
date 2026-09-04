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

export class AmbriaFeedError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AmbriaFeedError'
    this.code = code
    this.isSetup = SETUP_CODES.has(code)
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
    throw new AmbriaFeedError(code, message)
  }

  if (!data?.ok) {
    throw new AmbriaFeedError(
      String(data?.code ?? 'REQUEST_FAILED'),
      String(data?.error ?? 'The bookings feed refused the request.'),
    )
  }

  return data
}
