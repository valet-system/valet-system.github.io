/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/lib/phoneAuth.js                                          │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The bridge between "phone + PIN" (what a human types) and          │
 * │   "email + password" (what Supabase Auth understands).               │
 * │     phoneToAuthEmail(phone) — the derivation, used everywhere         │
 * │     validatePhoneInput(v)   — inline validation for the login form    │
 * │     validatePinInput(v)                                             │
 * │     isPinAcceptable(pin)    — used when an admin SETS a PIN           │
 * │                                                                     │
 * │ WHY THIS IS ITS OWN FILE                                             │
 * │   phoneToAuthEmail() is used in three places that must never          │
 * │   disagree: the login screen, the admin "add user" flow, and the      │
 * │   Edge Function that creates auth accounts. If two of them derived    │
 * │   the address slightly differently — one lowercasing, one not — the   │
 * │   account would be created at one address and looked up at another,   │
 * │   and the operator could never log in. The error would be a plain     │
 * │   "wrong PIN", pointing nowhere near the cause.                      │
 * │                                                                     │
 * │   One function, one file, imported by all three.                     │
 * │                                                                     │
 * │ WHY THE PIN IS NEVER STORED OR HASHED HERE                            │
 * │   It is passed straight to supabase.auth.signInWithPassword() as the  │
 * │   password. Supabase bcrypt-hashes it inside auth.users. This project │
 * │   has no `pin` column and no hashing code, on purpose — see the       │
 * │   header of supabase/migrations/20260731090300_phone_pin_login.sql.   │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   context/AuthContext (login), pages/Login (validation), and later    │
 * │   system/Users + the create-user Edge Function.                       │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   utils/format (normalisePhone), src/types (PHONE_REGEX, PIN_LENGTH)  │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { pickLang } from '@/i18n/activeLang'
import { normalisePhone } from '@/utils/format'
import { PHONE_REGEX, PIN_LENGTH } from '@/types'

/**
 * The domain half of the derived auth email.
 *
 * Defaults to `phone.invalid`. RFC 2606 reserves the `.invalid` TLD so it can
 * never resolve — which means no password-reset or confirmation email can ever
 * be delivered to an address that looks like a real operator's.
 *
 * Overridable via env only as an escape hatch: if Supabase's email validation
 * ever rejects `.invalid`, this can be pointed at a subdomain you control
 * (e.g. `valet.ambria.in`) without touching any other file. If you do that,
 * make sure no mailbox or catch-all exists there.
 */
const AUTH_EMAIL_DOMAIN = import.meta.env.VITE_PHONE_EMAIL_DOMAIN || 'phone.invalid'

/**
 * Turns a phone number into the auth email for that account.
 *
 *   '98765 43210'   -> '9876543210@phone.invalid'
 *   '+919876543210' -> '9876543210@phone.invalid'
 *
 * Runs through normalisePhone() first, so a country code, spaces, dashes or a
 * leading zero all collapse to the same 10 digits — and therefore the same
 * account. Without that, '+91 98765 43210' and '9876543210' would be two
 * different logins for one person.
 *
 * Returns null for anything that is not a valid Indian mobile number, so a
 * caller cannot accidentally attempt a login against a malformed address.
 */
export function phoneToAuthEmail(phone) {
  const digits = normalisePhone(phone)
  if (!PHONE_REGEX.test(digits)) return null
  // Lowercase because email addresses are case-insensitive in practice but
  // Supabase compares them as stored. Digits cannot change case, but the
  // domain can, and being explicit costs nothing.
  return `${digits}@${AUTH_EMAIL_DOMAIN}`.toLowerCase()
}

/** The reverse, for debugging and for showing "signed in as" text. */
export function authEmailToPhone(email) {
  if (!email) return null
  const [local, domain] = String(email).toLowerCase().split('@')
  if (domain !== AUTH_EMAIL_DOMAIN) return null
  return PHONE_REGEX.test(local) ? local : null
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATION — messages are written to be read by an operator, not a dev
// ═══════════════════════════════════════════════════════════════════

/** Returns an error string, or null when valid. */
export function validatePhoneInput(value) {
  const digits = normalisePhone(value)

  // pickLang, not a t() hook: these are called from inside the login form's
  // submit handler and from JSX expressions, and this module is not a
  // component. See i18n/activeLang for why that is safe here.
  if (!digits) return pickLang('Enter your phone number', 'अपना फ़ोन नंबर डालिए')
  if (digits.length < 10) {
    const left = 10 - digits.length
    return pickLang(`${left} more digit${left > 1 ? 's' : ''} needed`, `${left} अंक और डालिए`)
  }
  if (!PHONE_REGEX.test(digits)) {
    return pickLang('Phone numbers start with 6, 7, 8 or 9', 'फ़ोन नंबर 6, 7, 8 या 9 से शुरू होता है')
  }

  return null
}

/** Returns an error string, or null when valid. */
export function validatePinInput(value) {
  const digits = String(value || '').replace(/\D/g, '')

  if (!digits) return pickLang('Enter your PIN', 'अपना पिन डालिए')
  if (digits.length < PIN_LENGTH) {
    const left = PIN_LENGTH - digits.length
    return pickLang(`${left} more digit${left > 1 ? 's' : ''} needed`, `${left} अंक और डालिए`)
  }

  return null
}

/**
 * The only check left on a PIN being CHOSEN: that it is four digits.
 *
 * ── WHAT USED TO BE HERE, AND WHY IT IS GONE ──────────────────────────
 * A weak-PIN list, a same-digit check, and a sequential-run check. All removed
 * on request. '1234', '1111' and '0000' are now accepted and permanent.
 *
 * The length check stays because it is not a policy — it is a format. A PIN is
 * stored as the account's password, so a three-digit or non-numeric value does
 * not weaken the login, it breaks it.
 *
 * ── AND WHY THIS IS STILL A SEPARATE FUNCTION FROM LOGIN ──────────────
 * validatePinInput() above is what the login screen uses, and the two must not
 * be merged even now that this one barely does anything. Anything this function
 * refuses is a hint about what the PIN is NOT, and on a login form that is
 * information an attacker gets for free.
 */
export function isPinAcceptable(pin) {
  const digits = String(pin || '').replace(/\D/g, '')

  if (digits.length !== PIN_LENGTH) {
    return {
      ok: false,
      error: pickLang(`PIN must be exactly ${PIN_LENGTH} digits`, `पिन ठीक ${PIN_LENGTH} अंकों का होना चाहिए`),
    }
  }

  return { ok: true, error: null }
}

/**
 * A cryptographically random PIN, for the admin's "generate" button.
 *
 * crypto.getRandomValues, not Math.random: Math.random is not uniform and is
 * predictable from earlier outputs, which is the wrong property for something
 * that is briefly a credential.
 *
 * The reject-and-retry loop is gone with the weak-PIN list — there is nothing
 * left to reject, so a single draw is the answer. That does mean generate can
 * now hand back '1234' about once in ten thousand presses. It is accepted
 * everywhere else now, so refusing it only here would be inconsistent.
 */
export function generatePin() {
  const bytes = new Uint8Array(PIN_LENGTH)
  crypto.getRandomValues(bytes)
  // % 10 on a byte is very slightly biased toward 0-5; irrelevant at this
  // scale, and avoiding it would add rejection sampling for no real gain.
  return Array.from(bytes, (byte) => byte % 10).join('')
}
