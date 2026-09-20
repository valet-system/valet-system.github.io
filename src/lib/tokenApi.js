/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/lib/tokenApi.js                                           │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Tonight's token roster, from the admin side:                      │
 * │     tokenRoster(propertyId, serviceDate)                            │
 * │     assignTokenRange({ operatorId, rangeEnd, rangeStart, ... })     │
 * │     removeTokenRange({ operatorId, ... })                           │
 * │                                                                     │
 * │   Each resolves to { ok, error, code, ...data } and NEVER throws,   │
 * │   exactly like adminApi.js. Callers render `error`.                 │
 * │                                                                     │
 * │ WHY AN RPC AND NOT .from('operator_token_ranges')                   │
 * │   Assigning a range has real business logic — overlap checking      │
 * │   against every other operator on duty tonight, and "extend only,   │
 * │   start never moves" — that has to be enforced server-side, in the  │
 * │   same transaction as the write, or two admins racing each other    │
 * │   could both write ranges that collide. See migration 0071.         │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   pages/admin/TokenMgmt.jsx                                         │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase (the singleton client)                               │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { supabase } from '@/supabase'

async function call(fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) return { ok: false, ...describeRpcError(fn, error) }
    if (Array.isArray(data)) return { ok: true, rows: data }
    return { ok: true, ...(data ?? {}) }
  } catch (thrown) {
    console.error(`[tokenApi] ${fn} threw:`, thrown)
    return { ok: false, code: 'UNEXPECTED', error: 'Something went wrong. Please try again.' }
  }
}

const CODE_MESSAGES = {
  FORBIDDEN: 'You do not have permission to do that.',
  PROPERTY_REQUIRED: 'Choose a property.',
  BAD_DATE: 'Choose today or tomorrow.',
  NOT_FOUND: 'That operator no longer exists.',
  BAD_OPERATOR: 'That person is not an active operator at this property.',
  RANGE_REQUIRED: "Enter the first token in this operator's range.",
  BAD_RANGE: 'Enter a valid range.',
  ONLY_BIGGER: 'The range can only be made bigger, never smaller.',
  RANGE_OVERLAP: 'That range overlaps another operator working tonight.',
}

const MISSING_MIGRATION = {
  default:
    'Per-operator token ranges are not set up in the database yet. Run migration 0071 (operator_token_ranges) in the Supabase SQL Editor.',
}

function describeRpcError(fn, error) {
  const raw = error.message || ''
  const match = raw.match(/\b([A-Z][A-Z_]{2,})\s*:\s*(.+)/)
  if (match) {
    const [, code, detail] = match
    return { code, error: capitalise(detail.trim()) || CODE_MESSAGES[code] || raw }
  }
  if (
    error.code === 'PGRST202' ||
    raw.includes('Could not find the function') ||
    raw.includes('does not exist')
  ) {
    return { code: 'NOT_MIGRATED', error: MISSING_MIGRATION[fn] ?? MISSING_MIGRATION.default }
  }
  if (error.code === '42501' || raw.includes('permission denied')) {
    return { code: 'NO_GRANT', error: 'Database permissions are missing.' }
  }
  if (raw.includes('Failed to fetch') || raw.includes('NetworkError')) {
    return { code: 'OFFLINE', error: 'No internet connection. Try again.' }
  }
  console.error(`[tokenApi] ${fn} failed:`, error.code, raw, error)
  return { code: 'UNKNOWN', error: 'Something went wrong. Please try again.' }
}

function capitalise(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/** Tonight's roster (or p_service_date's), one row per assigned operator. */
export function tokenRoster(propertyId, serviceDate) {
  return call('admin_token_roster', {
    p_property_id: propertyId ?? null,
    p_service_date: serviceDate ?? null,
  })
}

/**
 * Create or extend one operator's range. Omit rangeStart to extend an
 * existing row — the server ignores it once a row exists, since a range's
 * start can never move.
 */
export function assignTokenRange({ operatorId, rangeEnd, rangeStart, serviceDate, propertyId }) {
  return call('admin_assign_token_range', {
    p_operator_id: operatorId,
    p_range_end: rangeEnd,
    p_range_start: rangeStart ?? null,
    p_service_date: serviceDate ?? null,
    p_property_id: propertyId ?? null,
  })
}

/** Takes an operator off tonight's roster without deleting the audit row. */
export function removeTokenRange({ operatorId, serviceDate, propertyId }) {
  return call('admin_remove_token_range', {
    p_operator_id: operatorId,
    p_service_date: serviceDate ?? null,
    p_property_id: propertyId ?? null,
  })
}
