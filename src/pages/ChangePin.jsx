/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/ChangePin.jsx                                       │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Where a signed-in user replaces their own PIN. Three fields:      │
 * │   current PIN, new PIN, confirm new PIN.                            │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   An admin sets the FIRST PIN when creating the account and reads it │
 * │   out to the operator. That PIN has therefore been spoken aloud on a │
 * │   porch and possibly written on paper. This screen is how it stops   │
 * │   being a shared secret and becomes the operator's own.              │
 * │                                                                     │
 * │   It also means an admin never has to know a working PIN. If someone │
 * │   forgets theirs, the admin RESETS it rather than looking it up —    │
 * │   which is why no PIN is stored in readable form anywhere in this    │
 * │   system. Only Supabase's bcrypt hash exists.                        │
 * │                                                                     │
 * │ WHY THE STRICT RULES ONLY APPLY HERE                                  │
 * │   isPinAcceptable() rejects 111111, 123456, 654321 and a list of     │
 * │   common choices. That check runs when SETTING a PIN and never when  │
 * │   logging in — refusing a weak PIN at login would tell an attacker   │
 * │   that '123456' is not this account's PIN, which is information.     │
 * │                                                                     │
 * │   The rules matter more than usual here because this system has no   │
 * │   login lockout by design. A guessable PIN falls in the first        │
 * │   handful of attempts instead of the 500,000th, which makes the      │
 * │   million-combination space irrelevant.                              │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   App.jsx at /change-pin, reachable from the user menu in AppShell.  │
 * │   Available to every role.                                          │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   context/AuthContext (changePin), context/ToastContext,             │
 * │   lib/phoneAuth (isPinAcceptable, generatePin), ui/*                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { useToast } from '@/context/ToastContext'
import { PageHeader } from '@/components/AppShell'
import Card from '@/components/ui/Card'
import Button from '@/components/ui/Button'
import Icon from '@/components/ui/Icon'
import { Field } from '@/components/ui/Field'
import { isPinAcceptable } from '@/lib/phoneAuth'
import { formatPhone, personName } from '@/utils/format'
import { PIN_INPUT_MAX, PIN_LENGTH } from '@/types'
import { getStaffPin } from '@/lib/adminApi'
import { cn } from '@/utils/cn'

export default function ChangePin() {
  const { changePin, phone, displayName, displayNameHi, homePath, operatorId } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()

  const t = useT()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [reveal, setReveal] = useState(false)
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)

  const nextRef = useRef(null)
  const confirmRef = useRef(null)

  /**
   * Fill in the current PIN for them.
   *
   * Anyone may read their OWN PIN — migration 0008 decided that explicitly, and
   * can_view_staff_pin() returns "allowed" the moment the target is the caller.
   * So this asks for the signed-in person's own, and nobody else's is reachable
   * from here.
   *
   * ── WHAT THIS GIVES UP ────────────────────────────────────────────────
   * The Current PIN field was a verification step: it proved the person holding
   * the phone was the account holder rather than someone who found it
   * unlocked. Filled in, it is a question the screen has already answered.
   *
   * That is the trade being made deliberately. The screen is reached straight
   * after a successful sign-in with that same PIN, so it was mostly asking
   * something already proven a moment ago — and on a phone, three PIN fields is
   * a lot of tapping for that.
   *
   * ── WHY IT FAILS QUIETLY ──────────────────────────────────────────────
   * If the read fails, or the PIN predates encrypted storage (`stored: false`),
   * the field is simply left empty and they type it as before. A blocking error
   * here would strand somebody on a screen they are forced through and cannot
   * skip.
   */
  useEffect(() => {
    if (!operatorId) return
    let cancelled = false

    getStaffPin(operatorId).then((result) => {
      if (cancelled) return
      const pin = result.ok ? String(result.pin ?? '') : ''
      // A RANGE, not an equality test. `!== PIN_LENGTH` refused to prefill a
      // legacy six-digit PIN — and those are precisely the people who have to
      // retype one here, so they were the only ones getting no help at all.
      // Anything outside the range is not a PIN this screen can show.
      if (pin.length < PIN_LENGTH || pin.length > PIN_INPUT_MAX) return
      setCurrent(pin)
      // Straight to the field they actually have to fill. Landing on a filled
      // one and tabbing past it is a step that exists for no reason.
      nextRef.current?.focus()
    })

    return () => {
      cancelled = true
    }
  }, [operatorId])

  /**
   * One handler for all three fields: digits only, capped per field.
   *
   * `max` differs between them, and it matters. The CURRENT PIN may be a legacy
   * six-digit one, so its field has to accept six or somebody cannot type their
   * own PIN to change it. A NEW PIN is four. See src/types for the two numbers.
   */
  function makeHandler(setter, key, advanceTo, max = PIN_LENGTH) {
    return (event) => {
      const digits = event.target.value.replace(/\D/g, '').slice(0, max)
      setter(digits)
      if (errors[key]) setErrors((prev) => ({ ...prev, [key]: null }))
      if (formError) setFormError(null)
      // Auto-advance only on a field with a FIXED length. The current-PIN field
      // does not know whether four digits is the whole PIN or the first four of
      // six, so jumping away at four would cut somebody off mid-PIN.
      if (max === PIN_LENGTH && digits.length === PIN_LENGTH && advanceTo) {
        advanceTo.current?.focus()
      }
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()

    const nextErrors = {}

    // `<`, not `!==`. An existing six-digit PIN is a valid current PIN, and
    // demanding exactly PIN_LENGTH here would refuse it before the network
    // call — telling somebody their own correct PIN is wrong.
    if (current.length < PIN_LENGTH) nextErrors.current = t('pin.enterCurrent')

    const strength = isPinAcceptable(next)
    if (!strength.ok) nextErrors.next = strength.error

    if (confirm !== next) nextErrors.confirm = t('pin.noMatch')
    // Checked before the network call so the user is not told "must be
    // different" by Supabase after a round trip.
    if (next && next === current) nextErrors.next = t('pin.mustDiffer')

    setErrors(nextErrors)
    setFormError(null)
    if (Object.keys(nextErrors).length) return

    const { error } = await changePin(current, next)

    if (error) {
      setFormError(error)
      // Only the current-PIN field is cleared: if that was the wrong part,
      // wiping the new PIN they just composed twice is punishing.
      setCurrent('')
      return
    }

    toast.success(t('pin.changed'))
    // Leave the screen so the three filled fields are not left on display.
    navigate(homePath, { replace: true })
  }

  return (
    <div className="mx-auto max-w-md">
      <PageHeader
        title={t('pin.title')}
        subtitle={
          phone
            ? t('pin.signedInAs', {
                name: personName(displayName, displayNameHi),
                phone: formatPhone(phone),
              })
            : personName(displayName, displayNameHi)
        }
      />

      <Card>
        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          {formError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-3 text-sm font-medium text-danger"
            >
              <Icon name="alert" size={17} className="mt-0.5" strokeWidth={2} />
              <span>{formError}</span>
            </div>
          )}

          {/* ALWAYS VISIBLE, not governed by the toggle below.
              Masking this one was pointless in a way the other two are not.
              The app fills it in from the database — so the dots were hiding a
              value the screen had just looked up and handed over, from the one
              person entitled to read it. Nobody could check what was in the
              field, and the label promising it was "already filled in" could
              not be verified at all.
              The toggle still covers the two NEW PIN fields, where the person
              is typing something nobody has seen yet and shoulder-surfing is a
              real concern. */}
          <PinField
            id="pin-current"
            label={current ? t('pin.current') : t('pin.currentEmpty')}
            value={current}
            onChange={makeHandler(setCurrent, 'current', nextRef, PIN_INPUT_MAX)}
            error={errors.current}
            reveal
            autoComplete="current-password"
            max={PIN_INPUT_MAX}
          />

          <hr className="border-t border-line" />

          <PinField
            id="pin-new"
            inputRef={nextRef}
            label={t('pin.new')}
            value={next}
            onChange={makeHandler(setNext, 'next', confirmRef)}
            error={errors.next}
            reveal={reveal}
            autoComplete="new-password"
            hint={t('pin.newHint', { n: PIN_LENGTH })}
          />

          <PinField
            id="pin-confirm"
            inputRef={confirmRef}
            label={t('pin.confirm')}
            value={confirm}
            onChange={makeHandler(setConfirm, 'confirm', null)}
            error={errors.confirm}
            reveal={reveal}
            autoComplete="new-password"
          />

          {/* One toggle for the two NEW PIN fields — the current one above is
              always visible, since the app filled it in itself. Three separate
              eye buttons would be clutter, and what is being typed here is
              either private or it is not. */}
          <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={reveal}
              onChange={(e) => setReveal(e.target.checked)}
              className="h-4 w-4 rounded border-line-strong accent-brand"
            />
            {/* State, not action — same as the login toggle. Here the checkbox
                already says what tapping does, so an icon contradicting the
                visible PINs beside it was doubly confusing. */}
            <Icon name={reveal ? 'eye' : 'eye-off'} size={15} />
            {t('pin.showPins')}
          </label>

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              fullWidth
              onClick={() => navigate(homePath)}
            >
              {t('common.cancel')}
            </Button>
            {/* Button owns its loading state because handleSubmit returns a
                promise — see ui/Button. */}
            <Button type="submit" variant="primary" size="lg" fullWidth loadingText={t('common.saving')}>
              {t('pin.save')}
            </Button>
          </div>
        </form>
      </Card>

      <p className="mt-4 flex items-start gap-2 px-1 text-xs leading-relaxed text-ink-subtle">
        <Icon name="info" size={14} className="mt-0.5" />
        <span>
          {t('pin.adminCanReset')}
        </span>
      </p>
    </div>
  )
}

/**
 * One PIN input. Extracted because three near-identical PIN fields on one
 * screen is precisely where copy-paste drift starts — one field ends up
 * missing inputMode and shows a full keyboard on a phone.
 */
function PinField({
  id, inputRef, label, value, onChange, error, reveal, hint, autoComplete,
  // Defaults to the length of a NEW PIN. The current-PIN field passes
  // PIN_INPUT_MAX, because an existing six-digit PIN has to be typeable.
  max = PIN_LENGTH,
}) {
  return (
    <Field label={label} htmlFor={id} error={error} hint={!error ? hint : undefined} required>
      <input
        id={id}
        ref={inputRef}
        value={value}
        onChange={onChange}
        // Not type="number": that allows 'e', '+', '-' and adds spinners.
        type={reveal ? 'tel' : 'password'}
        inputMode="numeric"
        autoComplete={autoComplete}
        maxLength={max}
        placeholder={'•'.repeat(PIN_LENGTH)}
        aria-invalid={error ? true : undefined}
        className={cn(
          'tnum h-touch w-full rounded-xl border bg-surface px-4',
          'text-center text-2xl font-bold tracking-[0.45em] text-ink outline-none',
          'placeholder:text-lg placeholder:font-normal placeholder:tracking-[0.3em]',
          'transition-colors duration-150',
          error
            ? 'border-danger focus:border-danger focus:ring-2 focus:ring-danger/20'
            : 'border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20',
        )}
      />

      {/* Progress dots — visible at arm's length, unlike a small "4/6". */}
      <div className="mt-2 flex justify-center gap-1.5" aria-hidden="true">
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span
            key={i}
            className={cn(
              'h-1.5 w-5 rounded-full transition-colors duration-150',
              i < value.length ? 'bg-brand' : 'bg-line',
            )}
          />
        ))}
      </div>
    </Field>
  )
}
