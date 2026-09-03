/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/lib/adminApi.js                                           │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Everything the staff-management screen does to a user account:      │
 * │     createStaff({ name, phone, pin, role, propertyId })              │
 * │     getStaffPin(userRoleId)  — read back ONE person's current PIN     │
 * │     setStaffPin(userRoleId, pin)                                     │
 * │     setStaffActive(userRoleId, isActive)                             │
 * │     deleteStaff(userRoleId)  — system admin only, inactive only       │
 * │     renameStaff(userRoleId, name)                                    │
 * │     changeStaffPhone(userRoleId, phone)                              │
 * │                                                                     │
 * │   Each resolves to { ok, error, code, ...data } and NEVER throws.     │
 * │   Callers render `error` and move on.                                │
 * │                                                                     │
 * │ HOW IT WORKS — Postgres RPC, not an Edge Function                     │
 * │   These call SECURITY DEFINER functions defined in                   │
 * │   supabase/migrations/20260731090400_staff_management_rpc.sql.        │
 * │                                                                     │
 * │   Creating a staff member means writing an auth account AND a         │
 * │   user_roles row. The auth write normally needs the service_role key, │
 * │   which must never reach a browser — so the usual answer is an Edge   │
 * │   Function, which means the Supabase CLI, an authenticated account,   │
 * │   and a deploy step before anyone can add a valet.                    │
 * │                                                                     │
 * │   A SECURITY DEFINER function already runs with its owner's           │
 * │   privileges inside Postgres, so it can write to the auth schema with │
 * │   no key handed to anyone. Nothing to deploy, and the browser         │
 * │   authenticates with the ordinary user JWT it already holds.          │
 * │                                                                     │
 * │   It is also atomic: one transaction, so a failure part-way cannot    │
 * │   leave an auth account with no role row — a state the Edge Function  │
 * │   had to clean up by hand and could fail to.                          │
 * │                                                                     │
 * │ WHY ERRORS ARE RETURNED, NOT THROWN                                    │
 * │   Every caller is a form submit handler that must put a message on     │
 * │   screen. try/catch at eight call sites is eight chances to forget     │
 * │   one and leave a spinner running forever.                             │
 * │                                                                     │
 * │ PINs ARE READABLE — and what that costs                                │
 * │   Since migration 0007, a PIN is stored encrypted in staff_pins so an  │
 * │   admin can read it back via getStaffPin(). The key lives in Supabase  │
 * │   Vault, outside the database, so a pg_dump holds only ciphertext.     │
 * │                                                                     │
 * │   The cost is real: whoever can call getStaffPin() can sign in as      │
 * │   that valet. Every call is logged to staff_pin_access with the        │
 * │   viewer, the subject and the time, so call it at the moment a PIN is  │
 * │   about to go on screen — never on page load, or the log fills with    │
 * │   views nobody performed and stops being evidence.                     │
 * │                                                                     │
 * │   Migration 0009 replaced the bulk reader with this one-at-a-time      │
 * │   version for exactly that reason: "viewed 12 PINs" proves nothing.    │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   pages/StaffManager.jsx                                             │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase (the singleton client)                                │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { supabase } from '@/supabase'

/**
 * Single place every call goes through.
 *
 * The Postgres functions signal problems with `raise exception 'CODE: message'`.
 * Postgres delivers that to supabase-js as one string, so we split it back into
 * the machine-readable code and the human sentence. Two fields rather than one
 * because matching on message text is how error handling silently breaks the
 * day someone rewords a message.
 */
async function call(fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args)

    if (error) return { ok: false, ...describeRpcError(fn, error) }

    // A function declared `returns table (...)` comes back as an ARRAY, while
    // one declared `returns jsonb` comes back as an object. Spreading an array
    // would produce { 0: row, 1: row } — silently useless — so arrays get their
    // own key.
    if (Array.isArray(data)) return { ok: true, rows: data }

    return { ok: true, ...(data ?? {}) }
  } catch (thrown) {
    // rpc() itself threw: no session, or the client was never configured.
    console.error(`[adminApi] ${fn} threw:`, thrown)
    return { ok: false, code: 'UNEXPECTED', error: 'Something went wrong. Please try again.' }
  }
}

/** Every code our SQL raises, mapped to a sentence an admin can act on. */
const CODE_MESSAGES = {
  FORBIDDEN: 'You do not have permission to do that.',
  BAD_ROLE: 'Unknown role.',
  BAD_SCOPE: 'Choose a property for this user.',
  BAD_NAME: "Enter the person's name.",
  BAD_PHONE: 'Enter a valid 10-digit mobile number starting 6-9.',
  BAD_PIN: 'That PIN is not allowed.',
  PHONE_TAKEN: 'That number is already registered.',
  PIN_TAKEN: 'That PIN is already in use.',
  NOT_FOUND: 'That user no longer exists.',
  SELF: 'You cannot do that to your own account.',
  USE_CHANGE_PIN: 'Use Change PIN to change your own PIN.',
  WRONG_PIN: 'Your current PIN is wrong.',
  HAS_ACTIVE_TASKS: 'That operator has tasks in progress. Finish or reassign them first.',
  // Both of these arrive with a detailed server message that names the person
  // and the count, which describeRpcError prefers over these fallbacks. They
  // exist for the case where the message shape ever changes.
  HAS_OPEN_TASKS: 'They are holding a car right now. Wait until it is finished.',
  LAST_SYSTEM_ADMIN: 'That is the only system admin. Promote somebody else first.',
  PROPERTY_REQUIRED: 'Choose a property for this role.',
  PIN_KEY_MISSING: 'PIN storage is not set up. Run migration 0007 in the SQL Editor.',
}

/**
 * Which migration defines each RPC, for the "function does not exist" case.
 *
 * The PIN-reading functions came in LAST, in viewable_pins, so they are the
 * ones most likely to be missing on a database that is otherwise up to date —
 * which is exactly the situation this map exists to describe accurately.
 */
const MISSING_MIGRATION = {
  admin_staff_pin:
    'Reading a PIN back is not set up in the database yet. Run migration 0009 (pin_scope_and_self) in the Supabase SQL Editor.',
  admin_set_staff_pin:
    'Setting a PIN by hand is not set up in the database yet. Run migration 0007 (viewable_pins) in the Supabase SQL Editor.',
  admin_create_staff:
    'User management is not set up in the database yet. Run migration 0005 (staff_management_rpc) in the Supabase SQL Editor.',
  admin_reset_staff_pin:
    'User management is not set up in the database yet. Run migration 0005 (staff_management_rpc) in the Supabase SQL Editor.',
  admin_set_staff_active:
    'User management is not set up in the database yet. Run migration 0005 (staff_management_rpc) in the Supabase SQL Editor.',
  admin_update_staff:
    'User management is not set up in the database yet. Run migration 0005 (staff_management_rpc) in the Supabase SQL Editor.',
  admin_set_staff_name_hi:
    'Hindi names are not set up in the database yet. Run migration 0022 (staff_name_hi) in the Supabase SQL Editor.',
  default:
    'That feature is not set up in the database yet. Run the pending migrations in supabase/migrations in the Supabase SQL Editor.',
}

function describeRpcError(fn, error) {
  const raw = error.message || ''

  // Our own raises look like "CODE: human readable detail".
  const match = raw.match(/\b([A-Z][A-Z_]{2,})\s*:\s*(.+)/)
  if (match) {
    const [, code, detail] = match
    if (CODE_MESSAGES[code]) {
      // Prefer the SQL's own detail — it interpolates real values, e.g. the
      // name a number is already registered to, or how many tasks are open.
      return { code, error: capitalise(detail.trim()) }
    }
  }

  // ── the function does not exist ────────────────────────────────────
  // A migration has not been run. Which one depends on the function, and
  // getting that wrong is worse than saying nothing: an admin who is told to
  // run 0005 will run 0005, see it succeed, find the feature still broken,
  // and conclude the app is broken rather than unmigrated.
  if (
    error.code === 'PGRST202' ||
    raw.includes('Could not find the function') ||
    raw.includes('does not exist')
  ) {
    return { code: 'NOT_MIGRATED', error: MISSING_MIGRATION[fn] ?? MISSING_MIGRATION.default }
  }

  // ── table-level GRANT missing ─────────────────────────────────────
  if (error.code === '42501' || raw.includes('permission denied')) {
    return {
      code: 'NO_GRANT',
      error: 'Database permissions are missing. Run migration 0003 (explicit_grants).',
    }
  }

  // ── constraint violations that slipped past the function's own checks ──
  if (error.code === '23505' || raw.includes('duplicate key')) {
    return { code: 'PHONE_TAKEN', error: 'That number is already registered.' }
  }
  if (raw.includes('user_roles_property_scope_chk')) {
    return {
      code: 'BAD_SCOPE',
      error: 'A system admin cannot have a property, and everyone else must have one.',
    }
  }

  // ── network ───────────────────────────────────────────────────────
  if (raw.includes('Failed to fetch') || raw.includes('NetworkError')) {
    return { code: 'OFFLINE', error: 'No internet connection. Try again.' }
  }

  console.error(`[adminApi] ${fn} failed:`, error.code, raw, error)
  return { code: 'UNKNOWN', error: 'Something went wrong. Please try again.' }
}

function capitalise(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

// ═══════════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Creates a staff member: auth account + identity + user_roles row, or none of
 * them. One transaction, so there is no partial state to clean up.
 *
 * `role` and `propertyId` are only honoured for a system_admin. A valet_admin's
 * values are DISCARDED server-side and replaced with 'operator' plus their own
 * property — not validated, discarded, so there is no check to get wrong. They
 * are still sent so one form serves both roles.
 *
 * Resolves { ok: true, user, pin } — `pin` is readable here and nowhere else.
 */
export function createStaff({ name, phone, pin, role, propertyId }) {
  return call('admin_create_staff', {
    p_name: name,
    p_phone: phone,
    p_pin: pin,
    p_role: role,
    p_property_id: propertyId ?? null,
  })
}

/**
 * Sets someone's PIN to a value the admin typed.
 *
 * Updates the bcrypt hash in auth.users AND the encrypted copy in staff_pins,
 * in one transaction — if only the first moved, the admin's PIN list would show
 * a stale value forever, which is worse than showing nothing.
 *
 * Refuses if the target is the caller: Change PIN is the right door for your
 * own, because it verifies the current PIN first.
 */
export function setStaffPin(userRoleId, pin) {
  return call('admin_set_staff_pin', { p_user_role_id: userRoleId, p_pin: pin })
}

/**
 * Reads back ONE person's current PIN. Resolves
 * { ok, stored, pin, set_by_self, updated_at }.
 *
 * `stored: false` means they were created before migration 0007, so the only
 * copy is a bcrypt hash and nothing can reverse it. Offer a new PIN instead.
 *
 * WHO MAY CALL IT (enforced in Postgres, migration 0009):
 *   system_admin  anyone, including themselves
 *   valet_admin   themselves + operators at their own property
 *   operator      themselves only
 *
 * EVERY CALL IS LOGGED to public.staff_pin_access with the viewer, the
 * subject and the time — including calls that find nothing. Call it when a
 * PIN is actually about to be shown on screen, never speculatively, or the
 * log stops being evidence of anything.
 *
 * One person per call, deliberately. The bulk reader this replaces could only
 * record "viewed 12 PINs", which is useless after the fact.
 */
export function getStaffPin(userRoleId) {
  return call('admin_staff_pin', { p_user_role_id: userRoleId })
}

/**
 * Deactivates or reactivates. Never deletes — is_active = false blocks sign-in
 * and hides them from assignment while keeping every task they handled
 * attributable.
 *
 * Refuses to deactivate an operator holding an active task, and refuses to
 * deactivate the caller.
 */
export function setStaffActive(userRoleId, isActive) {
  return call('admin_set_staff_active', { p_user_role_id: userRoleId, p_is_active: isActive })
}

/**
 * Destroys somebody's LOGIN, permanently. System admin only, and only for
 * someone already deactivated.
 *
 * What actually goes: the auth account, their PIN, their push subscriptions,
 * and their phone number's claim on the system — so the next hire can be given
 * that number. They can never sign in again and they leave the staff list.
 *
 * What STAYS is the user_roles row itself, and that is the whole design rather
 * than a compromise. Records reads "who parked this car" through a live join
 * on that row, so deleting it would blank the operator's name on every car
 * they ever handled, across the entire history. Migration 0063's header has
 * the reasoning and the five foreign keys that make a real delete impossible
 * anyway.
 *
 * Resolves with { code: 'deleted', name, role, cars_kept } — cars_kept is how
 * many tasks stay attributed to them, so the screen can say what was preserved
 * instead of leaving the admin to guess. A second call returns
 * code: 'already_deleted' rather than failing.
 *
 * NOT REVERSIBLE. Re-adding the person creates a new account with a new PIN;
 * their old cars stay with the old row.
 */
export function deleteStaff(userRoleId) {
  return call('admin_delete_staff', { p_user_role_id: userRoleId })
}

/**
 * Sets (or clears) the Hindi spelling of someone's name.
 *
 * Its own call rather than a field on admin_create_staff / admin_update_staff,
 * because adding an argument to admin_create_staff would mean dropping and
 * re-creating the most fragile function in the project — it writes auth.users
 * through a dynamic column list, handles two shapes of auth.identities, stores
 * the encrypted PIN and verifies the account can sign in. Migration 0022's
 * header has the full reasoning.
 *
 * Pass '' to erase. A failure here is NOT fatal to the surrounding save: the
 * column is nullable and every reader falls back to the English name.
 */
export function setStaffNameHi(userRoleId, nameHi) {
  return call('admin_set_staff_name_hi', {
    p_user_role_id: userRoleId,
    p_name_hi: nameHi ?? '',
  })
}

export function renameStaff(userRoleId, name) {
  return call('admin_update_staff', { p_user_role_id: userRoleId, p_name: name, p_phone: null })
}

/**
 * Changes the login number. Moves user_roles.phone, the auth email, and the
 * identity's copy of the email together in one transaction — a mismatch between
 * any of them locks the person out with no error explaining why.
 */
export function changeStaffPhone(userRoleId, phone) {
  return call('admin_update_staff', { p_user_role_id: userRoleId, p_name: null, p_phone: phone })
}

/**
 * Changes someone's role and property. **system_admin only.**
 *
 * Separate from admin_update_staff because a name is a field and a role is a
 * PERMISSION — every RLS policy in the project is written in terms of role and
 * property_id. A valet_admin can edit their operators' names and PINs but must
 * never be able to set a role, or they could promote themselves.
 *
 * Pass propertyId null for system_admin; the server nulls it anyway.
 *
 * Two refusals worth handling in the UI, both returned as codes:
 *   HAS_OPEN_TASKS    they are holding a car right now. Moving them would
 *                     leave that car assigned to somebody who can no longer
 *                     complete it — invisible to every screen.
 *   LAST_SYSTEM_ADMIN demoting the only system admin leaves nobody who can
 *                     manage roles or properties, recoverable only in SQL.
 *
 * Resolves { ok: true, data: { changed, name, role, property_name, was_self } }.
 * `changed: false` means the form was saved unmodified — not a failure.
 */
export function setStaffRole(userRoleId, role, propertyId) {
  return call('admin_set_staff_role', {
    p_user_role_id: userRoleId,
    p_role: role,
    p_property_id: propertyId ?? null,
  })
}
