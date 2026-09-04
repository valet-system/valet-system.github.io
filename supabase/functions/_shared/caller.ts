// @ts-nocheck — Deno file. See supabase/functions/README.md for why.
/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: supabase/functions/_shared/caller.ts                          │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Turns an incoming HTTP request into a trustworthy answer to "who   │
 * │   is calling, what role do they hold, and which property are they    │
 * │   allowed to touch?"                                                 │
 * │                                                                     │
 * │     adminClient()      — service_role client (bypasses RLS)          │
 * │     identifyCaller(req) — verifies the JWT, loads their user_roles    │
 * │     derivePhoneEmail()  — the SAME derivation as the frontend         │
 * │                                                                     │
 * │ WHY THIS IS THE MOST SECURITY-CRITICAL FILE IN THE PROJECT             │
 * │   Edge Functions here hold the service_role key, which BYPASSES ROW   │
 * │   LEVEL SECURITY COMPLETELY. Inside these functions the database has  │
 * │   no opinion about who may read or write what — every guard has to    │
 * │   be written by hand. RLS, which protects the whole rest of the app,  │
 * │   protects nothing in here.                                          │
 * │                                                                     │
 * │   So the rule is absolute: NEVER TRUST A ROLE OR A property_id THAT   │
 * │   ARRIVED IN THE REQUEST BODY. Both are read from the caller's own    │
 * │   user_roles row, which is looked up using the user id inside their   │
 * │   cryptographically-signed JWT.                                      │
 * │                                                                     │
 * │   Concretely, without that rule: a valet_admin at Ambria Restro POSTs │
 * │   { role: 'system_admin', property_id: <any> } and now owns all four  │
 * │   properties. It is a two-line request in the browser console.        │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   admin-users, and any future function that acts on a user's behalf.  │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   @supabase/supabase-js, env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

/**
 * The domain half of the derived auth address.
 *
 * MUST match VITE_PHONE_EMAIL_DOMAIN in the frontend's .env, and the default
 * in src/lib/phoneAuth.js. If the two ever disagree, accounts get created at
 * one address and looked up at another — and the only symptom is "wrong PIN"
 * on a PIN that is perfectly correct.
 */
const PHONE_EMAIL_DOMAIN = Deno.env.get('PHONE_EMAIL_DOMAIN') || 'phone.invalid'

export const ROLES = {
  SYSTEM_ADMIN: 'system_admin',
  VALET_ADMIN: 'valet_admin',
  OPERATOR: 'operator',
  /**
   * An outside staffing supplier, added by migration 0065. Reaches the valet
   * bookings feed and nothing else.
   *
   * Every function here gates on an explicit allow-list, so adding a name to
   * this object grants nothing on its own — which is the point.
   */
  VALET_VENDOR: 'valet_vendor',
} as const

export type CallerRole = (typeof ROLES)[keyof typeof ROLES]

export interface Caller {
  userId: string
  /** user_roles.id — NOT auth.users.id. */
  roleRowId: string
  role: CallerRole
  propertyId: string | null
  name: string
  phone: string
}

/**
 * A client with the service_role key. Bypasses RLS entirely.
 *
 * Every call made with this is unguarded by the database. Read the file header
 * before using it.
 */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: {
      // Nothing to persist or refresh: this client lives for one request and
      // authenticates with a static key, not a session.
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

/** Indian mobile: 10 digits, first digit 6-9, no country code. */
export const PHONE_REGEX = /^[6-9]\d{9}$/

/**
 * phone -> the auth email for that account. The server-side twin of
 * phoneToAuthEmail() in src/lib/phoneAuth.js. Keep the two identical.
 */
export function derivePhoneEmail(phone: string): string | null {
  const digits = String(phone || '').replace(/\D/g, '')
  if (!PHONE_REGEX.test(digits)) return null
  return `${digits}@${PHONE_EMAIL_DOMAIN}`.toLowerCase()
}

/**
 * E.164 without the leading '+', which is the shape GoTrue stores in
 * auth.users.phone. Only used to make the real number visible in the Supabase
 * dashboard — never for logging in, since phone login is disabled here.
 */
export function toE164(phone: string): string {
  return `91${String(phone || '').replace(/\D/g, '')}`
}

/**
 * Verifies the Authorization header and loads the caller's role.
 *
 * Returns a discriminated result rather than throwing, so each handler decides
 * the status code and message. `getUser(jwt)` is the important line: it asks
 * GoTrue to verify the token's SIGNATURE. Decoding the JWT ourselves would
 * accept a forged one, because a JWT's payload is only base64 — readable and
 * editable by anyone. Only the signature makes it trustworthy.
 */
export async function identifyCaller(
  req: Request,
): Promise<{ ok: true; caller: Caller; admin: SupabaseClient } | { ok: false; code: string; error: string; status: number }> {
  const authHeader = req.headers.get('Authorization') || ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim()

  if (!jwt) {
    return { ok: false, code: 'NO_TOKEN', error: 'Not signed in.', status: 401 }
  }

  const admin = adminClient()

  // Signature verification happens server-side inside GoTrue.
  const { data: userData, error: userError } = await admin.auth.getUser(jwt)
  if (userError || !userData?.user) {
    return { ok: false, code: 'BAD_TOKEN', error: 'Your session has expired. Sign in again.', status: 401 }
  }

  // The role comes from the DATABASE, keyed by the verified user id. Never from
  // the request body, and never from JWT custom claims (which an admin could
  // set but which also go stale the moment a role changes).
  const { data: roleRow, error: roleError } = await admin
    .from('user_roles')
    .select('id, role, property_id, name, phone, is_active')
    .eq('user_id', userData.user.id)
    .maybeSingle()

  if (roleError) {
    console.error('[caller] role lookup failed:', roleError)
    return { ok: false, code: 'ROLE_LOOKUP_FAILED', error: 'Could not verify your account.', status: 500 }
  }
  if (!roleRow) {
    return { ok: false, code: 'NO_ROLE', error: 'No role is assigned to your account.', status: 403 }
  }
  if (roleRow.is_active === false) {
    return { ok: false, code: 'INACTIVE', error: 'Your account has been deactivated.', status: 403 }
  }

  return {
    ok: true,
    admin,
    caller: {
      userId: userData.user.id,
      roleRowId: roleRow.id,
      role: roleRow.role as CallerRole,
      propertyId: roleRow.property_id,
      name: roleRow.name,
      phone: roleRow.phone,
    },
  }
}

/**
 * Decides what a caller is allowed to do to a target user, and RETURNS THE
 * VALUES TO USE — it does not merely approve the ones that were sent.
 *
 * That distinction is the whole point. A valet_admin's request may claim any
 * role and any property; this function discards both and substitutes
 * 'operator' and the caller's own property. There is no code path in which a
 * browser-supplied role or property_id reaches the database.
 */
export function resolveTargetScope(
  caller: Caller,
  requested: { role?: string; propertyId?: string | null },
): { ok: true; role: CallerRole; propertyId: string | null } | { ok: false; code: string; error: string } {
  // ── system_admin: may create anyone, anywhere ──────────────────────
  if (caller.role === ROLES.SYSTEM_ADMIN) {
    const role = (requested.role || ROLES.OPERATOR) as CallerRole

    if (!Object.values(ROLES).includes(role)) {
      return { ok: false, code: 'BAD_ROLE', error: 'Unknown role.' }
    }

    // Mirrors the DB constraint user_roles_property_scope_chk. Checked here too
    // so the admin gets a clear message instead of a raw constraint violation.
    if (role === ROLES.SYSTEM_ADMIN && requested.propertyId) {
      return { ok: false, code: 'BAD_SCOPE', error: 'A system admin cannot belong to a property.' }
    }
    if (role !== ROLES.SYSTEM_ADMIN && !requested.propertyId) {
      return { ok: false, code: 'BAD_SCOPE', error: 'Choose a property for this user.' }
    }

    return { ok: true, role, propertyId: role === ROLES.SYSTEM_ADMIN ? null : requested.propertyId! }
  }

  // ── valet_admin: operators only, own property only ─────────────────
  if (caller.role === ROLES.VALET_ADMIN) {
    if (!caller.propertyId) {
      return { ok: false, code: 'NO_PROPERTY', error: 'Your account has no property assigned.' }
    }
    // Note what is NOT happening: `requested.role` is not validated, it is
    // IGNORED. Same for requested.propertyId. Whatever the browser sent is
    // discarded, so there is nothing to get wrong.
    return { ok: true, role: ROLES.OPERATOR, propertyId: caller.propertyId }
  }

  // ── operator: no user management at all ────────────────────────────
  return { ok: false, code: 'FORBIDDEN', error: 'You do not have permission to manage users.' }
}

/**
 * May the caller act on this EXISTING user? Used by reset-PIN, rename, and
 * activate/deactivate, where the target already exists.
 *
 * A valet_admin is confined to operators at their own property. Without the
 * role check they could reset their own valet_admin peer's PIN — or the system
 * admin's, if that account ever carried a property_id.
 */
export function canActOn(
  caller: Caller,
  target: { role: string; property_id: string | null },
): { ok: true } | { ok: false; code: string; error: string } {
  if (caller.role === ROLES.SYSTEM_ADMIN) return { ok: true }

  if (caller.role === ROLES.VALET_ADMIN) {
    if (target.role !== ROLES.OPERATOR) {
      return { ok: false, code: 'FORBIDDEN', error: 'You can only manage operators.' }
    }
    if (!caller.propertyId || target.property_id !== caller.propertyId) {
      return { ok: false, code: 'FORBIDDEN', error: 'That user is not at your property.' }
    }
    return { ok: true }
  }

  return { ok: false, code: 'FORBIDDEN', error: 'You do not have permission to manage users.' }
}

// ═══════════════════════════════════════════════════════════════════
// PIN RULES — must match src/lib/phoneAuth.js
//
// Duplicated on purpose: the browser check is for fast feedback, this one is
// the one that counts. A request sent with curl never runs the frontend's
// validation at all, so a server that trusted it would happily set a PIN of
// '1' — which Supabase would reject for length, but '000000' it would accept.
// ═══════════════════════════════════════════════════════════════════

export const PIN_LENGTH = 6

const WEAK_PINS = new Set([
  '123456', '654321', '111111', '000000', '121212', '112233', '123123',
  '789456', '159753', '147258', '102030', '135790', '246800', '696969',
  '123321', '456654', '999999', '888888', '777777', '666666', '555555',
  '444444', '333333', '222222', '101010', '010101', '123654', '321123',
  '520520', '143143', '786786', '420420', '007007', '100100', '110011',
  '200000', '201010', '202020', '199999', '150847', '260150', '151515',
])

export function validatePin(pin: string): { ok: true } | { ok: false; error: string } {
  const digits = String(pin || '').replace(/\D/g, '')

  if (digits.length !== PIN_LENGTH || digits !== String(pin)) {
    return { ok: false, error: `PIN must be exactly ${PIN_LENGTH} digits.` }
  }
  if (WEAK_PINS.has(digits)) {
    return { ok: false, error: 'That PIN is too common. Choose a different one.' }
  }
  if (/^(\d)\1+$/.test(digits)) {
    return { ok: false, error: 'PIN cannot be the same digit repeated.' }
  }

  const chars = digits.split('').map(Number)
  const ascending = chars.every((d, i) => i === 0 || d === chars[i - 1] + 1)
  const descending = chars.every((d, i) => i === 0 || d === chars[i - 1] - 1)
  if (ascending || descending) {
    return { ok: false, error: 'PIN cannot be consecutive digits.' }
  }

  return { ok: true }
}
