/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/types/index.js                                            │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The single source of truth for every enum the database enforces    │
 * │   (roles, car tiers, task types, task statuses, vehicle statuses,    │
 * │   ratings, WhatsApp message types) PLUS how each value is presented  │
 * │   — its label, colour tone and icon — in the matching *_META map.    │
 * │   Also holds the operational constants: timer length, phone rules,   │
 * │   default token range, timezone.                                     │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Rule: no page ever types a raw status string like 'at_pickup'.     │
 * │   It imports VEHICLE_STATUS.AT_PICKUP.                              │
 * │                                                                     │
 * │   Reason — these columns have CHECK constraints in Postgres. A typo  │
 * │   is not caught at build time (this is JavaScript) and is not caught │
 * │   in review. It surfaces at 9pm on a live car as:                    │
 * │     violates check constraint "parked_vehicles_status_check"         │
 * │   One import turns that into a name your editor autocompletes.       │
 * │                                                                     │
 * │   The *_META maps sit here rather than in the components so a status │
 * │   looks identical on the operator's phone, in the admin queue and in │
 * │   the CSV export, without anyone re-deciding what colour "fetching"  │
 * │   should be.                                                        │
 * │                                                                     │
 * │ WHEN YOU CHANGE THIS FILE                                            │
 * │   Check whether the SQL needs the same change. The CHECK constraints │
 * │   in supabase/migrations are the real authority; this file must not  │
 * │   drift from them. ACTIVE_TASK_STATUSES in particular is mirrored    │
 * │   inside get_available_operators() — see the note on it below.       │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   Every page, ui/Badge, AuthContext, useTimer.                       │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   Nothing (reads two VITE_ env vars).                                │
 * └─────────────────────────────────────────────────────────────────────┘
 */

// ═══════════════════════════════════════════════════════════════════
// ROLES
// ═══════════════════════════════════════════════════════════════════

export const ROLES = {
  SYSTEM_ADMIN: 'system_admin',
  VALET_ADMIN: 'valet_admin',
  OPERATOR: 'operator',
}

export const ROLE_META = {
  [ROLES.SYSTEM_ADMIN]: { label: 'System Admin', icon: 'shield', home: '/system/properties' },
  [ROLES.VALET_ADMIN]: { label: 'Valet Admin', icon: 'users', home: '/admin/dashboard' },
  [ROLES.OPERATOR]: { label: 'Operator', icon: 'key', home: '/operator/checkin' },
}

// ═══════════════════════════════════════════════════════════════════
// CAR TIERS
// Gold is reserved for VIP alone — see src/index.css. If Premium also
// used gold, VIP would stop meaning anything at a glance.
// ═══════════════════════════════════════════════════════════════════

export const CAR_TIERS = {
  VIP: 'VIP',
  PREMIUM: 'Premium',
  STANDARD: 'Standard',
}

export const CAR_TIER_LIST = [CAR_TIERS.STANDARD, CAR_TIERS.PREMIUM, CAR_TIERS.VIP]

export const CAR_TIER_META = {
  [CAR_TIERS.VIP]: {
    label: 'VIP',
    tone: 'vip',
    icon: 'star',
    /** VIP cards get a highlighted border in the retrieval queue. */
    emphasise: true,
  },
  [CAR_TIERS.PREMIUM]: { label: 'Premium', tone: 'info', icon: 'star', emphasise: false },
  [CAR_TIERS.STANDARD]: { label: 'Standard', tone: 'neutral', icon: null, emphasise: false },
}

// ═══════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════

export const TASK_TYPES = {
  PARKING: 'parking',
  RETRIEVAL: 'retrieval',
}

export const TASK_TYPE_META = {
  [TASK_TYPES.PARKING]: { label: 'Park', icon: 'parking', tone: 'info' },
  [TASK_TYPES.RETRIEVAL]: { label: 'Retrieve', icon: 'car', tone: 'warning' },
}

export const TASK_STATUS = {
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  AT_PICKUP: 'at_pickup',
  COMPLETED: 'completed',
  RE_PARKING: 're_parking',
  RETURNED: 'returned',
}

export const TASK_STATUS_META = {
  [TASK_STATUS.PENDING]: { label: 'Waiting', tone: 'danger', icon: 'clock' },
  [TASK_STATUS.ASSIGNED]: { label: 'Assigned', tone: 'info', icon: 'user' },
  [TASK_STATUS.IN_PROGRESS]: { label: 'In progress', tone: 'info', icon: 'car' },
  [TASK_STATUS.AT_PICKUP]: { label: 'At delivery point', tone: 'warning', icon: 'timer' },
  [TASK_STATUS.COMPLETED]: { label: 'Completed', tone: 'success', icon: 'check-circle' },
  [TASK_STATUS.RE_PARKING]: { label: 'Re-parking', tone: 'warning', icon: 'refresh' },
  [TASK_STATUS.RETURNED]: { label: 'Guest absent', tone: 'danger', icon: 'x-circle' },
}

/**
 * An operator holding a task in any of these states is BUSY and must not be
 * offered for a new assignment. It is also exactly the list MyTasks shows as
 * open work — those two must be the same set, or an operator is held busy by
 * a task they cannot see, or freed while still holding a car.
 *
 * This list is duplicated inside get_available_operators() in the SQL
 * migration. It is duplicated on purpose — the database is the authority and
 * must not trust the client — but the two MUST be changed together. If you
 * add a status here, add it there.
 *
 * RETURNED is in the list but nothing creates it any more. Before migration
 * 0008, a no-show sent the task to 'returned', which was in neither list: the
 * card vanished off the screen of the operator still holding the keys, and
 * that operator was immediately offered for another car. Now a no-show goes
 * to RE_PARKING. RETURNED stays here so any row already stranded on it keeps
 * its operator held until the task is actually finished.
 */
export const ACTIVE_TASK_STATUSES = [
  TASK_STATUS.ASSIGNED,
  TASK_STATUS.IN_PROGRESS,
  TASK_STATUS.AT_PICKUP,
  TASK_STATUS.RE_PARKING,
  TASK_STATUS.RETURNED,
]

/** Terminal states — a task here is finished and leaves the active list. */
export const CLOSED_TASK_STATUSES = [TASK_STATUS.COMPLETED]

// ═══════════════════════════════════════════════════════════════════
// VEHICLES
// Lifecycle:
//   checked_in -> parking -> parked
//                              |
//                    (guest taps Get My Car)
//                              v
//              requested -> fetching -> at_pickup -> delivered   [done]
//                                            |
//                                   (guest absent / timeout)
//                                            v
//                                re_parking -> returned
//                                            |
//                              (guest taps Get My Car again)
//                                            v
//                                      back to requested
// ═══════════════════════════════════════════════════════════════════

export const VEHICLE_STATUS = {
  CHECKED_IN: 'checked_in',
  PARKING: 'parking',
  PARKED: 'parked',
  REQUESTED: 'requested',
  FETCHING: 'fetching',
  AT_PICKUP: 'at_pickup',
  DELIVERED: 'delivered',
  RE_PARKING: 're_parking',
  RETURNED: 'returned',
}

export const VEHICLE_STATUS_META = {
  [VEHICLE_STATUS.CHECKED_IN]: { label: 'Checked in', tone: 'neutral', icon: 'ticket', step: 1 },
  [VEHICLE_STATUS.PARKING]: { label: 'Being parked', tone: 'info', icon: 'car', step: 2 },
  [VEHICLE_STATUS.PARKED]: { label: 'Parked', tone: 'success', icon: 'parking', step: 3 },
  [VEHICLE_STATUS.REQUESTED]: { label: 'Requested', tone: 'danger', icon: 'bell', step: 4 },
  [VEHICLE_STATUS.FETCHING]: { label: 'Being fetched', tone: 'info', icon: 'car', step: 5 },
  [VEHICLE_STATUS.AT_PICKUP]: { label: 'Ready for guest', tone: 'warning', icon: 'timer', step: 6 },
  [VEHICLE_STATUS.DELIVERED]: { label: 'Delivered', tone: 'success', icon: 'check-circle', step: 7 },
  [VEHICLE_STATUS.RE_PARKING]: { label: 'Re-parking', tone: 'warning', icon: 'refresh', step: 6 },
  [VEHICLE_STATUS.RETURNED]: { label: 'Parked again', tone: 'success', icon: 'parking', step: 3 },
}

/** A car in one of these states is sitting in the car park, available to request. */
export const VEHICLE_AT_REST = [VEHICLE_STATUS.PARKED, VEHICLE_STATUS.RETURNED]

/** A car in one of these states is mid-journey; it is "live" work. */
export const VEHICLE_IN_FLIGHT = [
  VEHICLE_STATUS.CHECKED_IN,
  VEHICLE_STATUS.PARKING,
  VEHICLE_STATUS.REQUESTED,
  VEHICLE_STATUS.FETCHING,
  VEHICLE_STATUS.AT_PICKUP,
  VEHICLE_STATUS.RE_PARKING,
]

// ═══════════════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════════════

export const RATINGS = {
  EXCELLENT: 'excellent',
  GOOD: 'good',
  POOR: 'poor',
}

export const RATING_LIST = [RATINGS.EXCELLENT, RATINGS.GOOD, RATINGS.POOR]

export const RATING_META = {
  [RATINGS.EXCELLENT]: { label: 'Excellent', tone: 'success', icon: 'star', score: 3 },
  [RATINGS.GOOD]: { label: 'Good', tone: 'info', icon: 'check-circle', score: 2 },
  [RATINGS.POOR]: { label: 'Poor', tone: 'danger', icon: 'x-circle', score: 1 },
}

// ═══════════════════════════════════════════════════════════════════
// WHATSAPP MESSAGE TYPES
// Must match the `message_type` CHECK constraint on public.wa_outbox and the
// switch inside the wa-send Edge Function.
// ═══════════════════════════════════════════════════════════════════

export const WA_MESSAGE = {
  CAR_PARKED: 'car_parked',
  CAR_DELIVERED: 'car_delivered',
  NOT_AVAILABLE: 'not_available',
  CAR_RETURNED: 'car_returned',
}

// ═══════════════════════════════════════════════════════════════════
// OPERATIONAL CONSTANTS
// ═══════════════════════════════════════════════════════════════════

/**
 * Hand-over window in minutes.
 *
 * Read from env so it can be tuned per deployment without a rebuild, but note
 * this value only controls the COUNTDOWN THE OPERATOR SEES. The authority is
 * expire_stale_pickups(10) in the pg_cron job — that is what fires when the
 * operator's phone is locked. Changing one without the other means the screen
 * and the database disagree about when a guest counted as absent.
 */
export const PICKUP_TIMEOUT_MINUTES = Number(import.meta.env.VITE_PICKUP_TIMEOUT_MINUTES) || 10
export const PICKUP_TIMEOUT_SECONDS = PICKUP_TIMEOUT_MINUTES * 60

/** Countdown turns red and the warning tone plays with this much left. */
export const PICKUP_WARNING_SECONDS = 120

/**
 * Indian mobile numbers: 10 digits, first digit 6-9. Stored WITHOUT '91'.
 *
 * This is ALSO the login identifier — see src/lib/phoneAuth.js. The same regex
 * is enforced as a CHECK constraint in migration 0004, because a phone stored
 * in any other shape derives a different auth email and that account becomes
 * permanently unreachable.
 */
export const PHONE_LENGTH = 10
export const PHONE_REGEX = /^[6-9]\d{9}$/
export const COUNTRY_CODE = '91'

/**
 * PIN length. FOUR, on request.
 *
 * This was six, and the reason it was six is worth leaving on the record
 * rather than deleting, because it has not stopped being true:
 *
 *   4 digits =    10,000 combinations
 *   6 digits = 1,000,000 combinations
 *
 * There is deliberately no application-level lockout in this system. So the
 * only things between an attacker and an account are this number and
 * Supabase's own per-IP rate limit (Dashboard -> Authentication -> Rate
 * Limits). At four digits with no weak-PIN check and a default of 1234, that
 * rate limit is doing effectively all of the work — it is worth confirming it
 * is actually tightened. See migration 0004's header.
 *
 * The weak-PIN list and the sequential/repeated checks were removed with it,
 * also on request: a PIN of 1234 or 1111 is now accepted and permanent.
 */
export const PIN_LENGTH = 4

/**
 * The PIN a new staff member starts with.
 *
 * They are still forced through Change PIN on first login — that is unchanged
 * — so this is a handover value, not a resting one. Its only job is to be
 * easy to read out over a counter.
 */
export const DEFAULT_PIN = '1234'

/**
 * Default daily token range, PER PROPERTY.
 *
 * Ranges have always been per-property — token_ranges is
 * unique(property_id, range_date) — so Exotica's token 47 and Restro's token
 * 47 are different cars. Each site counts its own 1..N.
 *
 * These two only prefill the "create a range" form. The authority is
 * public.default_token_start() / default_token_end() in migration 0010, which
 * the column default, allocate_token() and reset_daily_tokens() all read. If
 * you change the size, change it THERE — a range created by any of those
 * paths ignores what is written here.
 */
export const DEFAULT_TOKEN_START = 1
export const DEFAULT_TOKEN_END = 1000

/** Business timezone. The DB stores UTC; every date shown to a human is IST. */
export const TIMEZONE = 'Asia/Kolkata'
