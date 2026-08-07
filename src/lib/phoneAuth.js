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
import { PHONE_REGEX, PIN_LENGTH, WEAK_PINS } from '@/types'

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
  if (!digits) return pickLang('Enter your mobile number', 'अपना मोबाइल नंबर डालिए')
  if (digits.length < 10) {
    const left = 10 - digits.length
    return pickLang(`${left} more digit${left > 1 ? 's' : ''} needed`, `${left} अंक और डालिए`)
  }
  if (!PHONE_REGEX.test(digits)) {
    return pickLang('Mobile numbers start with 6, 7, 8 or 9', 'मोबाइल नंबर 6, 7, 8 या 9 से शुरू होता है')
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
 * Stricter check, used only where a PIN is being CHOSEN (the admin's add-user
 * and reset-PIN flows) — never on the login screen.
 *
 * Why the split: on login, rejecting a weak PIN would tell an attacker that
 * '123456' is not this account's PIN, which is information. When SETTING one,
 * refusing the obvious choices is the entire point — with no lockout in this
 * system, a PIN of '111111' is the one realistic way in, because it is
 * guessable in the first handful of attempts rather than the millionth.
 */
export function isPinAcceptable(pin) {
  const digits = String(pin || '').replace(/\D/g, '')

  if (digits.length !== PIN_LENGTH) {
    return {
      ok: false,
      error: pickLang(`PIN must be exactly ${PIN_LENGTH} digits`, `पिन ठीक ${PIN_LENGTH} अंकों का होना चाहिए`),
    }
  }

  if (WEAK_PINS.has(digits)) {
    return {
      ok: false,
      error: pickLang(
        'That PIN is too common. Choose a different one.',
        'यह पिन बहुत आम है। कोई और चुनिए।',
      ),
    }
  }

  // All the same digit: 000000, 111111, ...
  if (/^(\d)\1+$/.test(digits)) {
    return { ok: false, error: pickLang('PIN cannot be the same digit repeated', 'पिन में सारे अंक एक जैसे नहीं हो सकते') }
  }

  // Straight runs up or down: 123456, 654321, 456789 ...
  const ascending = digits.split('').every((d, i, all) => i === 0 || +d === +all[i - 1] + 1)
  const descending = digits.split('').every((d, i, all) => i === 0 || +d === +all[i - 1] - 1)
  if (ascending || descending) {
    return { ok: false, error: pickLang('PIN cannot be consecutive digits', 'पिन क्रम में लगे अंकों का नहीं हो सकता') }
  }

  return { ok: true, error: null }
}

/**
 * A cryptographically random PIN, for the admin's "generate" button.
 *
 * crypto.getRandomValues, not Math.random: Math.random is not uniform and is
 * predictable from earlier outputs. For a credential that matters. The loop
 * simply rejects anything isPinAcceptable() would refuse, so a generated PIN
 * is never '123456'.
 */
export function generatePin() {
  const digits = new Uint8Array(PIN_LENGTH)

  for (let attempt = 0; attempt < 50; attempt += 1) {
    crypto.getRandomValues(digits)
    // % 10 on a byte is very slightly biased toward 0-5; irrelevant at this
    // scale, and avoiding it would add rejection sampling for no real gain.
    const pin = Array.from(digits, (byte) => byte % 10).join('')
    if (isPinAcceptable(pin).ok) return pin
  }

  // Unreachable in practice — a weak PIN 50 times in a row is astronomically
  // unlikely — but never return a value that failed validation.
  return '482913'
}
