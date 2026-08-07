/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/lib/analyticsApi.js                                       │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Two reads, both aggregated in Postgres, both over a DATE RANGE:    │
 * │     summary(propertyId, from, to)   one property, or all four         │
 * │     byProperty(from, to)            the group comparison              │
 * │     byOperator(from, to, prop)      who did how much work            │
 * │                                                                     │
 * │   Dates and not a day count, so "last Saturday" and "September" are   │
 * │   askable — a rolling window can only ever answer "the last N days".  │
 * │   See migration 0018.                                                │
 * │                                                                     │
 * │   Same contract as adminApi/valetApi: { ok, error, ... }, never      │
 * │   throws.                                                           │
 * │                                                                     │
 * │ WHY NOT JUST SELECT THE ROWS AND COUNT THEM                          │
 * │   A property hands out up to 1000 tokens a day, so a quarter is tens │
 * │   of thousands of rows per property and the group view is four of    │
 * │   them. Counting those in the browser means shipping all of it over  │
 * │   hotel wifi to produce eight numbers.                               │
 * │                                                                     │
 * │   The sharper reason: PostgREST can be given a row ceiling, and a    │
 * │   query that hits it returns a SHORT LIST WITH NO ERROR. The page    │
 * │   would draw a confident, wrong chart and nothing would look broken. │
 * │   Aggregating in SQL removes that failure instead of depending on a  │
 * │   setting staying unset. See migration 0011.                         │
 * │                                                                     │
 * │ SCOPE IS DECIDED SERVER-SIDE                                         │
 * │   Passing null as the property means "all four" only if the caller   │
 * │   is a system_admin; for anyone else the database substitutes their  │
 * │   own property. So one page works for both roles and there is no     │
 * │   property id in the browser for anyone to swap.                     │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   admin/Analytics, system/Analytics                                  │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase                                                      │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { supabase } from '@/supabase'

const CODE_MESSAGES = {
  FORBIDDEN: 'You do not have permission to see this.',
  FORBIDDEN_PROPERTY: 'That property is not yours to look at.',
}

async function call(fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) return { ok: false, ...describe(fn, error) }
    if (Array.isArray(data)) return { ok: true, rows: data }
    return { ok: true, data: data ?? null }
  } catch (thrown) {
    console.error(`[analyticsApi] ${fn} threw:`, thrown)
    return { ok: false, code: 'UNEXPECTED', error: 'Something went wrong. Please try again.' }
  }
}

function describe(fn, error) {
  const raw = error.message || ''

  const match = raw.match(/\b([A-Z][A-Z_]{2,})\s*:\s*(.+)/)
  if (match && CODE_MESSAGES[match[1]]) {
    const detail = match[2].trim()
    return { code: match[1], error: detail.charAt(0).toUpperCase() + detail.slice(1) }
  }
  const bare = Object.keys(CODE_MESSAGES).find((code) => raw.includes(code))
  if (bare) return { code: bare, error: CODE_MESSAGES[bare] }

  if (
    error.code === 'PGRST202' ||
    raw.includes('Could not find the function') ||
    raw.includes('does not exist')
  ) {
    return {
      code: 'NOT_MIGRATED',
      error:
        'Analytics is not set up in the database yet. Run migrations 0011 (analytics_rpc) and 0018 (analytics_date_range) in the Supabase SQL Editor.',
    }
  }

  if (raw.includes('Failed to fetch') || raw.includes('NetworkError')) {
    return { code: 'OFFLINE', error: 'No internet connection. Try again.' }
  }

  console.error(`[analyticsApi] ${fn} failed:`, error.code, raw, error)

  // In dev, show the real message on screen. "Could not load analytics" is
  // the right thing for an admin and useless for whoever has to fix it —
  // a 42804 type mismatch from RETURN QUERY looked identical to a network
  // blip until the console was opened. Same treatment as describeDbError().
  const message = 'Could not load analytics.'
  return {
    code: 'UNKNOWN',
    error: import.meta.env.DEV ? `${message} (${error.code ?? '?'}: ${raw})` : message,
  }
}

/**
 * One property's figures, or every property combined.
 *
 * @param propertyId null = all four (system_admin only; anyone else is
 *                   silently scoped to their own property by the database)
 * @param from       YYYY-MM-DD, inclusive. Null = 30 days back.
 * @param to         YYYY-MM-DD, inclusive. Null = today (IST).
 *                   The span is capped at 731 days server-side.
 *
 * Resolves { ok, data } where data is
 *   { from, to, days, cars, delivered, parked, no_shows, tiers,
 *     retrieval_wait, retrieval_count, parking_time, parking_count,
 *     per_day: [{ d, cars }], per_hour: [{ h, cars }] }
 *
 * `retrieval_wait` and `parking_time` are MEDIAN minutes and are null when
 * nothing completed in the period. Always render them next to their count —
 * a median of four cars is not a fact anyone should re-roster a shift on.
 */
export function summary(propertyId, from, to) {
  return call('analytics_summary', {
    p_property_id: propertyId ?? null,
    p_from: from ?? null,
    p_to: to ?? null,
  })
}

/**
 * Per-operator workload over the range: how many cars each one parked, fetched,
 * and their median guest wait.
 *
 * Counts COMPLETED tasks only. A retrieval that was reassigned would otherwise
 * count for two people, and an operator handed a car who never finished it would
 * score for it.
 *
 * Scoped like everything else: a valet_admin sees their own property whatever
 * they pass; an operator is refused.
 */
export function byOperator(from, to, propertyId) {
  return call('analytics_by_operator', {
    p_from: from ?? null,
    p_to: to ?? null,
    p_property_id: propertyId ?? null,
  })
}

/** Per-property comparison. system_admin only; others get FORBIDDEN. */
export function byProperty(from, to) {
  return call('analytics_by_property', { p_from: from ?? null, p_to: to ?? null })
}
