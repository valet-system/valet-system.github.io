/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/lib/valetApi.js                                           │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Every write in the car lifecycle:                                  │
 * │     checkIn({ guestName, guestPhone, carNumber, carTier, notes })    │
 * │     completeParking(taskId, location)                                │
 * │     assignRetrieval(taskId, operatorId)                              │
 * │     dispatchVehicle(vehicleId, operatorId)                           │
 * │     acceptTask(taskId)                                               │
 * │     startPickup(taskId)                                              │
 * │     guestArrived(taskId)                                             │
 * │     guestAbsent(taskId)                                              │
 * │     completeReparking(taskId, location)                              │
 * │     availableOperators(propertyId)                                   │
 * │                                                                     │
 * │   Each resolves to { ok, error, code, ...data } and NEVER throws,     │
 * │   exactly like src/lib/adminApi.js. Callers render `error`.           │
 * │                                                                     │
 * │ WHY EVERY ONE IS AN RPC AND NOT A .from().update()                    │
 * │   A task transition writes valet_tasks AND parked_vehicles AND        │
 * │   queues the guest's WhatsApp message. From the browser that is       │
 * │   three requests off a phone on hotel wifi, and any one of them can   │
 * │   be the last that lands — leaving the two tables disagreeing about   │
 * │   the same car, which is the bug migration 0002 section 8 exists to   │
 * │   fix. One RPC is one transaction.                                    │
 * │                                                                     │
 * │   And wa_outbox has no RLS policy on purpose, so `authenticated`      │
 * │   cannot insert into it at all. Queuing the guest message from here   │
 * │   is not untidy, it is impossible. See migration 0008's header.       │
 * │                                                                     │
 * │ THE STATUS ARGUMENT IS NOT SENT — ON PURPOSE                          │
 * │   No function here takes a target status. The SQL decides what a      │
 * │   task moves to, and refuses a move from the wrong current status.    │
 * │   A phone with a stale screen therefore cannot skip a step; it gets   │
 * │   WRONG_STATUS and is told to refresh.                                │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   pages/operator/CheckIn, pages/operator/MyTasks,                     │
 * │   pages/operator/TodaysCars, and later pages/admin/Dashboard.         │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase (the singleton client)                                │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { getActiveLang, pickLang } from '@/i18n/activeLang'
import { supabase } from '@/supabase'

/**
 * Single funnel for every call, mirroring adminApi.js.
 *
 * Our SQL signals problems two ways and both have to be understood here:
 *   raise exception 'CODE: human sentence'   — everything in migration 0008
 *   raise exception 'CODE'                   — allocate_token, from 0002
 * The second form has no sentence to show, so it falls back to the table
 * below. Matching on message text instead of the code is how error handling
 * silently breaks the day someone rewords a message.
 */
async function call(fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args)

    if (error) return { ok: false, ...describeRpcError(fn, error) }

    // `returns table (...)` arrives as an array; `returns jsonb` as an object.
    // Spreading an array would produce { 0: row, 1: row } — silently useless.
    if (Array.isArray(data)) return { ok: true, rows: data }

    return { ok: true, ...(data ?? {}) }
  } catch (thrown) {
    console.error(`[valetApi] ${fn} threw:`, thrown)
    return {
      ok: false,
      code: 'UNEXPECTED',
      error: pickLang('Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करें।'),
    }
  }
}

/**
 * Every code our SQL raises, mapped to a sentence an operator can act on —
 * [English, Hindi]. A pair rather than a string because this object is built
 * once at import time, long before anyone has picked a language; resolving it
 * here would freeze the first language for the life of the tab.
 */
const CODE_MESSAGES = {
  FORBIDDEN: ['You do not have permission to do that.', 'आपको यह करने की अनुमति नहीं है।'],
  FORBIDDEN_PROPERTY: ['That car belongs to another property.', 'यह गाड़ी दूसरी प्रॉपर्टी की है।'],
  PROPERTY_REQUIRED: [
    'No property is linked to your account. Contact your admin.',
    'आपके अकाउंट से कोई प्रॉपर्टी जुड़ी नहीं है। एडमिन से बात कीजिए।',
  ],
  NOT_FOUND: [
    'That is no longer in the system. Refresh and try again.',
    'यह अब सिस्टम में नहीं है। रिफ़्रेश करके दोबारा कोशिश कीजिए।',
  ],
  WRONG_TYPE: ['That action does not apply to this task.', 'यह काम इस टास्क पर लागू नहीं होता।'],
  WRONG_STATUS: [
    'Someone already moved this one. Refresh to see the latest.',
    'इसे कोई और आगे बढ़ा चुका है। ताज़ा हालत देखने के लिए रिफ़्रेश कीजिए।',
  ],
  BAD_NAME: ['Enter the guest name.', 'गेस्ट का नाम डालिए।'],
  BAD_PHONE: [
    'Enter a valid 10-digit mobile number starting 6-9.',
    '6-9 से शुरू होने वाला सही 10 अंकों का मोबाइल नंबर डालिए।',
  ],
  BAD_CAR: ['Enter the car number.', 'गाड़ी का नंबर डालिए।'],
  BAD_TIER: ['Choose Standard, Premium or VIP.', 'Standard, Premium या VIP में से चुनिए।'],
  BAD_LOCATION: ['Enter where you parked the car.', 'गाड़ी कहाँ पार्क की, वह डालिए।'],
  NOT_PARKED: ['That car is not parked right now.', 'यह गाड़ी अभी पार्क नहीं है।'],
  ALREADY_REQUESTED: ['This car has already been requested.', 'इस गाड़ी की माँग पहले ही दर्ज है।'],
  BAD_OPERATOR: ['That person cannot take this car.', 'यह व्यक्ति यह गाड़ी नहीं ले सकता।'],
  OPERATOR_BUSY: ['That operator is already on another car.', 'यह ऑपरेटर पहले से दूसरी गाड़ी पर है।'],
  TOKEN_RANGE_EXHAUSTED: [
    "Today's token range is finished. Ask your admin to extend it in Token Management.",
    'आज की टोकन रेंज खत्म हो गई है। एडमिन से टोकन मैनेजमेंट में बढ़वाइए।',
  ],
}

/** The current language's sentence for a code, or undefined if unmapped. */
function codeMessage(code) {
  const pair = CODE_MESSAGES[code]
  return pair ? pickLang(pair[0], pair[1]) : undefined
}

/**
 * Which migration is missing, per function. Keyed on the RPC name, because a
 * single message cannot be right for all of them.
 */
const MISSING_MIGRATION = {
  task_complete_parking:
    'Parking is not fully set up in the database yet. Run migration 0035 (no_capacity_and_system_spaces) in the Supabase SQL Editor.',
  task_complete_reparking:
    'Re-parking is not fully set up in the database yet. Run migration 0035 (no_capacity_and_system_spaces) in the Supabase SQL Editor.',
  default:
    'The car lifecycle is not set up in the database yet. Run migration 0008 (operator_flow_rpc) in the Supabase SQL Editor.',
}

function describeRpcError(fn, error) {
  const raw = error.message || ''

  // ── "CODE: human readable detail" ─────────────────────────────────
  // Prefer the SQL's own detail: it interpolates real values, like which
  // status the task is actually in or which operator is busy.
  const withDetail = raw.match(/\b([A-Z][A-Z_]{2,})\s*:\s*(.+)/)
  if (withDetail) {
    const [, code, detail] = withDetail
    const mapped = codeMessage(code)
    if (mapped) {
      // In English the SQL's own detail wins — it interpolates real values,
      // like which status the task is actually in. In Hindi it does NOT: the
      // detail is written in English inside the migrations, so showing it
      // would drop an English sentence into a Hindi screen. Our mapped
      // sentence is less specific and readable, which is the better trade for
      // someone who cannot read the specific one.
      if (getActiveLang() === 'en') return { code, error: capitalise(detail.trim()) }
      return { code, error: mapped }
    }
  }

  // ── bare "CODE", raised by the older functions ────────────────────
  const bare = Object.keys(CODE_MESSAGES).find((code) => raw.includes(code))
  if (bare) return { code: bare, error: codeMessage(bare) }

  // ── the function does not exist ───────────────────────────────────
  //
  // Which migration to name depends on WHICH function is missing, and getting
  // it wrong is worse than saying nothing: somebody told to run 0008 will run
  // 0008, watch it succeed, find parking still broken, and conclude the app is
  // broken rather than unmigrated. That happened once: the two parking
  // functions changed signature and this message went on naming 0008.
  //
  // PGRST202 is also what PostgREST returns when the function EXISTS but no
  // overload matches the arguments sent — which is what a front end deployed
  // ahead of its migration produces, and why the message has to name the right
  // migration rather than a plausible one.
  if (
    error.code === 'PGRST202' ||
    raw.includes('Could not find the function') ||
    raw.includes('does not exist')
  ) {
    return { code: 'NOT_MIGRATED', error: MISSING_MIGRATION[fn] ?? MISSING_MIGRATION.default }
  }

  if (error.code === '42501' || raw.includes('permission denied')) {
    return {
      code: 'NO_GRANT',
      error: 'Database permissions are missing. Run migration 0003 (explicit_grants).',
    }
  }

  // Constraint violations that got past the function's own checks. The
  // one-open-retrieval index is the interesting one: it is the real guard
  // against a guest asking twice, so it can fire under a genuine race.
  if (error.code === '23505' || raw.includes('duplicate key')) {
    if (raw.includes('one_open_retrieval')) {
      return { code: 'ALREADY_REQUESTED', error: codeMessage('ALREADY_REQUESTED') }
    }
    if (raw.includes('token_per_day')) {
      return {
        code: 'TOKEN_CLASH',
        error: pickLang('That token was just taken. Try again.', 'यह टोकन अभी-अभी किसी और को चला गया। दोबारा कोशिश कीजिए।'),
      }
    }
    return {
      code: 'DUPLICATE',
      error: pickLang('This record already exists.', 'यह रिकॉर्ड पहले से मौजूद है।'),
    }
  }

  if (raw.includes('Failed to fetch') || raw.includes('NetworkError')) {
    return {
      code: 'OFFLINE',
      error: pickLang('No internet connection. Try again.', 'इंटरनेट नहीं है। दोबारा कोशिश कीजिए।'),
    }
  }

  console.error(`[valetApi] ${fn} failed:`, error.code, raw, error)
  return {
    code: 'UNKNOWN',
    error: pickLang('Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करें।'),
  }
}

function capitalise(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

// ═══════════════════════════════════════════════════════════════════
// CHECK IN
// ═══════════════════════════════════════════════════════════════════

/**
 * Registers an arriving car: token, vehicle row, and a parking task assigned
 * to the caller — one transaction, so a burnt token with no car behind it
 * cannot happen.
 *
 * The property is NOT a parameter. It is read from the caller's own
 * user_roles row server-side, so there is no property id in the browser for
 * anyone to change.
 *
 * Resolves { ok: true, token_number, vehicle_id, task_id, car_number, ... }.
 */
export async function checkIn({
  guestName,
  guestNameHi,
  guestPhone,
  carNumber,
  carTier,
  notes,
}) {
  const result = await call('operator_check_in', {
    p_guest_name: guestName,
    p_guest_phone: guestPhone,
    p_car_number: carNumber,
    p_car_tier: carTier,
    p_notes: notes || null,
  })

  // ── the Hindi spelling, AFTER the token is issued and NOT awaited ──
  //
  // Sent as a SECOND call rather than as an argument to operator_check_in,
  // because that function allocates a token, creates the vehicle and opens the
  // parking task in one transaction — the piece that guarantees a burnt token
  // cannot exist without a car behind it. Restating it to thread one more
  // argument through is not worth the risk. See migration 0030.
  //
  // Not awaited, so the token is on screen before this runs. It carries no
  // network conversion — the value came from the FORM, where it was generated
  // while the operator was still typing the phone number — so all this does is
  // one small write. A failure leaves guest_name_hi NULL and every screen shows
  // the English name, which is the intended fallback.
  if (result.ok && result.vehicle_id && guestNameHi) {
    supabase
      .rpc('set_guest_name_hi', { p_vehicle_id: result.vehicle_id, p_name_hi: guestNameHi })
      .then(({ error }) => {
        // Logged, never surfaced. The operator has moved on to the next car and
        // there is nothing for them to do about it.
        if (error) console.info('[checkin] could not store the Hindi name:', error.message)
      })
  }

  return result
}

// ═══════════════════════════════════════════════════════════════════
// TASK TRANSITIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * "Car Parked" — closes the parking task and sends MSG 1 to the guest.
 *
 * Two arguments, since migration 0035. It used to take a third, `force`, so an
 * operator could insist a car really was in a place the system believed full.
 * Per-place limits are gone, so nothing refuses a park on capacity and there is
 * nothing to override.
 */
export function completeParking(taskId, location) {
  return call('task_complete_parking', { p_task_id: taskId, p_location: location })
}

/** Admin queue: send a named operator to fetch a car the guest has asked for. */
export function assignRetrieval(taskId, operatorId) {
  return call('assign_retrieval', { p_task_id: taskId, p_operator_id: operatorId })
}

/**
 * Send an operator for a car NOBODY has asked for yet.
 *
 * For the guest who walks up to the desk instead of tapping the button. There
 * is no task to assign, so the server makes one and assigns it in the same
 * transaction — see migration 0045 for why that must not be two calls from
 * here. If the guest happened to tap seconds earlier, their request is adopted
 * rather than duplicated.
 */
export function dispatchVehicle(vehicleId, operatorId) {
  return call('dispatch_vehicle', { p_vehicle_id: vehicleId, p_operator_id: operatorId })
}

/**
 * "Accept" — the operator acknowledges a dispatch. 'assigned' -> 'in_progress'.
 *
 * This is what stops the repeating alarm on MyTasks, which sounds for as long
 * as a retrieval sits in 'assigned'. Starting the pickup does the same thing,
 * because that also leaves 'assigned' — an operator already at the delivery
 * point does not have to tap twice.
 */
export function acceptTask(taskId) {
  return call('task_accept', { p_task_id: taskId })
}

/**
 * "Car at Delivery Point" — starts the hand-over window.
 *
 * Resolves { pickup_started_at } from the SERVER clock. Hang the countdown
 * off that, never off the phone's own clock: a device running minutes fast
 * would show time remaining after the database has already expired the task.
 */
export function startPickup(taskId) {
  return call('task_start_pickup', { p_task_id: taskId })
}

/** "Guest Arrived" — car handed over, MSG 2 queued. */
export function guestArrived(taskId) {
  return call('task_guest_arrived', { p_task_id: taskId })
}

/**
 * "Guest Not Here" — the task stays with this operator on 're_parking' and
 * the card stays on their screen until they confirm the new spot. MSG 3 is
 * queued. See migration 0008's header for why it is not 'returned'.
 */
export function guestAbsent(taskId) {
  return call('task_guest_absent', { p_task_id: taskId })
}

/** "Car Re-parked" — closes out a no-show, MSG 4 queued, operator free. */
export function completeReparking(taskId, location) {
  return call('task_complete_reparking', { p_task_id: taskId, p_location: location })
}


// ═══════════════════════════════════════════════════════════════════
// READS
// ═══════════════════════════════════════════════════════════════════

/**
 * Operators with no open task, straight from the database.
 *
 * Resolves { ok: true, rows: [{ id, name, phone }] }. Never filter a staff
 * list in React to find free operators — by the time it renders, someone has
 * taken a car.
 */
export function availableOperators(propertyId) {
  return call('get_available_operators', { p_property_id: propertyId })
}
