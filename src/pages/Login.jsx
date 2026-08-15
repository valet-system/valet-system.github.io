/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/Login.jsx                                           │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The only unauthenticated screen. Two numeric fields: a 10-digit    │
 * │   mobile number and a 6-digit PIN. AuthContext then loads the role   │
 * │   and ProtectedRoute routes to the right dashboard.                  │
 * │                                                                     │
 * │   NO SMS. NO OTP. NO THIRD PARTY. The number is an identifier, not a │
 * │   channel — nothing is ever sent to it from this screen. Sign-in is  │
 * │   Supabase Auth and nothing else.                                    │
 * │                                                                     │
 * │ WHY NUMBER + PIN INSTEAD OF EMAIL + PASSWORD                          │
 * │   An operator signs in at the start of every shift, standing         │
 * │   outdoors, one-handed, often with cold or wet hands. Typing         │
 * │   "rajesh.kumar@ambria.in" then a mixed-case password means four     │
 * │   keyboard switches on a phone. Two numeric fields means none: the   │
 * │   numeric keypad has larger keys and never changes layout.            │
 * │                                                                     │
 * │   Underneath it is still Supabase Auth with a bcrypt-hashed          │
 * │   password. See src/lib/phoneAuth.js for how the number maps to an   │
 * │   auth account, and why this project never stores a PIN.              │
 * │                                                                     │
 * │ WHY THIS SCREEN DOES THREE THINGS BESIDES SIGNING IN                  │
 * │   The login tap is the FIRST and often ONLY user gesture of the       │
 * │   whole shift, and browsers gate three capabilities behind a real     │
 * │   gesture. Miss this moment and they are gone until the next login:   │
 * │                                                                     │
 * │   1. primeAudio() — unlocks the AudioContext. Without a gesture,     │
 * │      audio stays suspended and every later alert is SILENT. A         │
 * │      realtime event does not count as a gesture, so an operator      │
 * │      would simply never hear a task arrive.                          │
 * │   2. requestNotificationPermission() — Chrome ignores the prompt     │
 * │      outside a gesture. Asked here the operator expects setup; asked  │
 * │      on page load people reflex-tap Block, and it can never be       │
 * │      asked again.                                                    │
 * │   3. InstallPrompt — the natural moment to offer "add to home        │
 * │      screen", before the shift rather than during it.                │
 * │                                                                     │
 * │ WHY ERRORS RENDER INLINE, NOT AS A TOAST                              │
 * │   Toasts sit at the top of the screen and would cover the form. A     │
 * │   wrong PIN belongs beside the field that caused it. Toasts are for   │
 * │   things that happen while you are looking somewhere else.            │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   App.jsx at /login, wrapped in <PublicRoute> so an already          │
 * │   signed-in user is redirected instead of seeing this form.           │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   context/AuthContext, lib/phoneAuth, utils/format, utils/sounds,     │
 * │   components/PwaStatus, ui/*                                         │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import Button from '@/components/ui/Button'
import Icon from '@/components/ui/Icon'
import { Field } from '@/components/ui/Field'
import { InstallPrompt } from '@/components/PwaStatus'
import { validatePhoneInput, validatePinInput } from '@/lib/phoneAuth'
import { groupPhone, normalisePhone, skipPhoneSeparator } from '@/utils/format'
import { primeAudio, requestNotificationPermission } from '@/utils/sounds'
import { subscribeToPush } from '@/lib/pushApi'
import LanguageToggle from '@/components/LanguageToggle'
import { useT } from '@/i18n'
import { PIN_LENGTH } from '@/types'
import { cn } from '@/utils/cn'

export default function Login() {
  const t = useT()
  const { signInWithPin } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [formError, setFormError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})

  const pinRef = useRef(null)

  /** Where ProtectedRoute wanted to send them before bouncing them here. */
  const redirectTo = location.state?.from

  /**
   * Strips non-digits as the operator types, and caps the length.
   *
   * Cleaned on change rather than on submit so a pasted "+91 98765 43210"
   * visibly becomes "9876543210" straight away. Accepting it and cleaning it
   * silently later means the field shows something different from what is
   * actually used — and this is the field you cannot afford to get wrong.
   */
  function handlePhoneChange(event) {
    const digits = normalisePhone(event.target.value)
    setPhone(digits)
    if (fieldErrors.phone) setFieldErrors((prev) => ({ ...prev, phone: null }))
  }

  /**
   * Enter moves to the PIN instead of submitting.
   *
   * THERE USED TO BE AUTO-ADVANCE HERE and it was removed. Jumping focus the
   * instant the tenth digit landed broke two ordinary things:
   *
   *   1. A stray eleventh keystroke went into the PIN. normalisePhone caps the
   *      number at 10, so the extra digit was harmless in the field it was
   *      aimed at — but focus had already moved, so it became the first digit
   *      of the PIN. The PIN is masked, so nobody saw it, and the login failed
   *      with "Wrong mobile number or PIN" for no visible reason.
   *
   *   2. Correcting a typo was impossible. Fixing the third digit means the
   *      length passes through 9 and back to 10, which fired the jump again —
   *      so every attempt to repair the number threw you out of the field.
   *
   * Enter is the deliberate version of the same convenience: the operator asks
   * for it rather than having it happen to them.
   */
  function handlePhoneKeyDown(event) {
    // Backspace on the 5-5 separator has to delete the digit, not stall.
    skipPhoneSeparator(event)

    if (event.key !== 'Enter') return
    event.preventDefault()
    pinRef.current?.focus()
  }

  function handlePinChange(event) {
    const digits = event.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH)
    setPin(digits)
    if (fieldErrors.pin) setFieldErrors((prev) => ({ ...prev, pin: null }))
  }

  async function handleSubmit(event) {
    event.preventDefault()

    // ── inline validation before touching the network ──────────────────
    const errors = {
      phone: validatePhoneInput(phone),
      pin: validatePinInput(pin),
    }
    setFieldErrors(errors)
    setFormError(null)
    if (errors.phone || errors.pin) return

    // Unlock audio BEFORE the await. The gesture context is only reliable in
    // the synchronous part of the handler — after an await, Safari in
    // particular stops treating us as "user activated".
    primeAudio()

    const { error } = await signInWithPin(phone, pin)

    if (error) {
      setFormError(error)
      // Clear the PIN, keep the number. Re-entering 10 digits after every
      // mistyped PIN is needless friction, and the PIN is the part that was
      // probably wrong.
      setPin('')
      pinRef.current?.focus()
      return
    }

    // Fire and forget — if notifications are blocked the app still works with
    // sound and haptics, so this must never block the login.
    //
    // Register for push only AFTER permission resolves, and only if it was
    // granted. subscribeToPush deliberately does not ask on its own: Chrome
    // ignores a permission prompt outside a user gesture, and asking from a
    // background call burns the single chance to ever ask.
    requestNotificationPermission()
      .then((permission) => {
        if (permission === 'granted') return subscribeToPush()
        return undefined
      })
      .catch(() => {})

    // AuthContext is now loading the user_roles row. ProtectedRoute shows a
    // spinner until it lands, then routes by role — which is why there is no
    // role check here. "/" redirects by role on its own.
    navigate(redirectTo ?? '/', { replace: true })
  }

  return (
    <div className="flex min-h-app flex-col bg-surface-sunken">
      {/* The toggle is ABOVE the form and before any of the words it changes.
          Somebody who cannot read this page has to be able to fix that
          without first reading it — see components/LanguageToggle. */}
      {/* The padding ADDS the iOS safe area rather than replacing it.
          index.html sets apple-mobile-web-app-status-bar-style to
          black-translucent, so once installed the page runs UNDER the status
          bar — on a notched iPhone that is 47-59px of clock and battery. A
          plain pt-4 put this toggle inside it. Android reserves that space
          itself, which is why it only showed up on iPhone.
          env() is 0 everywhere else, so this is a no-op off iOS. */}
      <div className="flex justify-end px-4 pt-[calc(1rem+env(safe-area-inset-top))]">
        <LanguageToggle tone="light" />
      </div>

      <main className="flex flex-1 items-center justify-center px-4 pb-10 pt-4">
        <div className="w-full max-w-sm">
          {/* ── brand ─────────────────────────────────────────────────────
              The real lockup, not the old car glyph in a rounded square.

              It sits on a DARK PLATE because it has to: the "AMBRIA" wordmark
              is white, and this screen's background is light — on the bare page
              the company name would be invisible while the gold car stayed
              readable, which looks like a half-loaded image.

              alt is empty and aria-hidden: the h1 underneath already says the
              name, and a screen reader announcing "Ambria" twice in a row is
              noise. The image is decoration here, not information. */}
          <div className="mb-8 text-center">
            <span className="mx-auto mb-4 flex w-52 items-center justify-center rounded-2xl bg-brand px-5 py-4 shadow-raised">
              {/* The size public/logo-lockup.png is actually emitted at, per
                  `npm run logo`. These were 919x444 — the dimensions of the
                  full-resolution copy in brand/, which is never served here. */}
              <img
                src="/logo-lockup.png"
                alt=""
                aria-hidden="true"
                width={520}
                height={220}
                className="h-auto w-full"
              />
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-ink">{t('login.brand')}</h1>
            <p className="mt-1 text-sm text-ink-subtle">{t('login.tagline')}</p>
          </div>

          {/* ── form ──────────────────────────────────────────────────── */}
          <form
            onSubmit={handleSubmit}
            // noValidate: we render our own messages. Native browser bubbles
            // cannot be styled and are poor for screen readers.
            noValidate
            className="space-y-4 rounded-card border border-line bg-surface p-5 shadow-card sm:p-6"
          >
            {formError && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-3 text-sm font-medium text-danger"
              >
                <Icon name="alert" size={17} className="mt-0.5" strokeWidth={2} />
                <span>{formError}</span>
              </div>
            )}

            {/* ── mobile number ──────────────────────────────────────── */}
            <Field
              label={t('login.mobile')}
              htmlFor="login-phone"
              error={fieldErrors.phone}
              hint={
                !fieldErrors.phone ? t('login.mobileHint') : undefined
              }
              required
            >
              <div className="relative">
                {/* Fixed +91 prefix. Showing it removes the "do I type 91?"
                    hesitation, and because it is not part of the input it can
                    never end up in the stored value. */}
                <span className="pointer-events-none absolute left-0 top-0 flex h-touch w-14 items-center justify-center border-r border-line-strong text-[0.9375rem] font-semibold text-ink-subtle">
                  +91
                </span>
                <input
                  id="login-phone"
                  // Grouped for reading, ten bare digits underneath.
                  value={groupPhone(phone)}
                  onChange={handlePhoneChange}
                  onKeyDown={handlePhoneKeyDown}
                  // type="tel" + inputMode="numeric": tel alone shows *, # and +
                  // on some Androids; numeric gives plain digits.
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  // Turns the phone keyboard's action key into "Next", which
                  // is what handlePhoneKeyDown then acts on.
                  enterKeyHint="next"
                  // NO maxLength — deliberately.
                  //
                  // maxLength counts RAW characters, including '+', spaces and
                  // dashes, and the browser truncates BEFORE our onChange runs.
                  // Pasting "+91 98765 43210" would be cut to "+91 98765" and
                  // arrive here as 5 usable digits, so a perfectly good pasted
                  // number silently became invalid.
                  //
                  // normalisePhone() in the handler is the real limiter: it
                  // strips formatting, drops a 91 or a leading 0, and caps at
                  // 10 digits — so the value can never exceed 10 anyway.
                  placeholder="98765 43210"
                  aria-invalid={fieldErrors.phone ? true : undefined}
                  aria-describedby={fieldErrors.phone ? 'login-phone-error' : 'login-phone-hint'}
                  className={cn(
                    'tnum h-touch w-full rounded-xl border bg-surface pl-16 pr-4',
                    // Larger text with loose tracking: 10 ungrouped digits are
                    // hard to proof-read at a glance.
                    'text-lg font-semibold tracking-[0.06em] text-ink outline-none',
                    'placeholder:font-normal placeholder:tracking-normal placeholder:text-ink-subtle',
                    'transition-colors duration-150',
                    fieldErrors.phone
                      ? 'border-danger focus:border-danger focus:ring-2 focus:ring-danger/20'
                      : 'border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20',
                  )}
                />
              </div>
            </Field>

            {/* ── PIN ────────────────────────────────────────────────── */}
            <Field
              label={t('login.pin', { n: PIN_LENGTH })}
              htmlFor="login-pin"
              error={fieldErrors.pin}
              required
            >
              <div className="relative">
                <input
                  id="login-pin"
                  ref={pinRef}
                  value={pin}
                  onChange={handlePinChange}
                  // Not type="number": that permits 'e', '+' and '-' and adds
                  // spinner arrows. tel + numeric gives a clean digit keypad.
                  type={showPin ? 'tel' : 'password'}
                  inputMode="numeric"
                  autoComplete="current-password"
                  // "Go" on the last field, so Enter submits from here.
                  enterKeyHint="go"
                  maxLength={PIN_LENGTH}
                  placeholder={'•'.repeat(PIN_LENGTH)}
                  aria-invalid={fieldErrors.pin ? true : undefined}
                  aria-describedby={fieldErrors.pin ? 'login-pin-error' : undefined}
                  className={cn(
                    'tnum h-touch w-full rounded-xl border bg-surface px-4 pr-14',
                    'text-center text-2xl font-bold tracking-[0.45em] text-ink outline-none',
                    'placeholder:text-lg placeholder:font-normal placeholder:tracking-[0.3em]',
                    'transition-colors duration-150',
                    fieldErrors.pin
                      ? 'border-danger focus:border-danger focus:ring-2 focus:ring-danger/20'
                      : 'border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20',
                  )}
                />

                {/* Reveal toggle. A masked 6-digit field gives no way to spot a
                    fat-fingered digit; without this a typo means starting over
                    with no idea what went wrong. */}
                <button
                  type="button"
                  onClick={() => setShowPin((v) => !v)}
                  aria-label={t(showPin ? 'login.hidePin' : 'login.showPin')}
                  className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-line/60 hover:text-ink"
                >
                  <Icon name={showPin ? 'eye-off' : 'eye'} size={19} />
                </button>
              </div>

              {/* Progress dots — readable at arm's length in daylight, which a
                  small "3/6" counter is not. */}
              <div className="mt-2.5 flex justify-center gap-2" aria-hidden="true">
                {Array.from({ length: PIN_LENGTH }, (_, i) => (
                  <span
                    key={i}
                    className={cn(
                      'h-1.5 w-6 rounded-full transition-colors duration-150',
                      i < pin.length ? 'bg-brand' : 'bg-line',
                    )}
                  />
                ))}
              </div>
            </Field>

            {/* Button manages its own loading + disabled state because
                handleSubmit returns a promise. See ui/Button. */}
            <Button type="submit" variant="primary" size="lg" fullWidth loadingText={t('login.signingIn')}>
              {t('login.signIn')}
            </Button>
          </form>

          <InstallPrompt className="mt-4" />

          <p className="mt-6 text-center text-xs leading-relaxed text-ink-subtle">
            {t('login.setByAdmin')}
            <br />
            {t('login.forgot')}
          </p>
        </div>
      </main>
    </div>
  )
}
