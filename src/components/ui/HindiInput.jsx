/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/HindiInput.jsx                              │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   A text field that keeps itself in sync with the Devanagari         │
 * │   spelling of another field, and lets a human overrule it.           │
 * │                                                                     │
 * │     <HindiInput source={name} value={nameHi} onChange={setNameHi}    │
 * │                 storedSource={row.name} storedValue={row.name_hi} /> │
 * │                                                                     │
 * │ ── THE RULE, IN ONE LINE ────────────────────────────────────────────│
 * │   The Hindi follows the English. A hand correction pins it, but only │
 * │   until the English changes again.                                   │
 * │                                                                     │
 * │   Why that and not "typing disables auto for good": a name that has  │
 * │   been RETYPED in English is a different name, and leaving the old   │
 * │   Devanagari sitting under it is worse than re-deriving. Fix a typo  │
 * │   in "Rajesk" and the Hindi should stop saying राजेस्क.                │
 * │                                                                     │
 * │   The pin still matters for the case it was built for: the admin     │
 * │   corrects the machine's spelling, then goes on to set the PIN, the  │
 * │   role, the property. None of that touches the English name, so      │
 * │   their correction survives — the machine never wins a race against  │
 * │   a human who is still typing.                                       │
 * │                                                                     │
 * │ ── OPENING A DIALOG CHANGES NOTHING ─────────────────────────────────│
 * │   storedSource + storedValue are what the DATABASE holds. While the  │
 * │   English field still reads exactly storedSource, the stored Hindi   │
 * │   is left alone — so opening Edit on someone and closing it again    │
 * │   cannot quietly rewrite their name.                                 │
 * │                                                                     │
 * │   This is checked by comparing VALUES, not with a "first render"     │
 * │   flag. A flag was tried and was wrong: the Edit dialog fills its    │
 * │   state from a useEffect that runs after this component has already  │
 * │   mounted, so on the first render `source` is still empty and any    │
 * │   mount-time decision is made against the wrong data.                │
 * │                                                                     │
 * │ ── DEBOUNCE AND ABORT, BOTH ─────────────────────────────────────────│
 * │   Debounce alone still fires on every pause, and a slow request for  │
 * │   "Raj" can land AFTER a fast one for "Rajesh" and overwrite it with │
 * │   the shorter answer. Aborting the in-flight call prevents that.     │
 * │                                                                     │
 * │ ── ALREADY-DEVANAGARI INPUT IS LEFT ALONE ───────────────────────────│
 * │   An admin who types Hindi straight into the English name field is   │
 * │   common. Pushing that back through an English→Hindi model is        │
 * │   exactly how a correct name comes back mangled, so it is skipped.   │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   pages/StaffManager — the Add and Edit dialogs                      │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   lib/hindiText, ui/Field, ui/Icon, src/i18n, utils/cn               │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useRef, useState } from 'react'
import Button from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import Icon from '@/components/ui/Icon'
import { useT } from '@/i18n'
import { hasDevanagari, hasLatin, transliterateToHindi } from '@/lib/hindiText'
import { cn } from '@/utils/cn'

/** Long enough that a name typed at speed is one request, not eight. */
const DEBOUNCE_MS = 500

/**
 * Should the field re-derive itself from `source` right now?
 *
 * Pulled out as a pure function and exported ONLY so it can be tested — the
 * three-way interaction below is where this component has gone wrong twice,
 * and a truth table catches that in a way that reading it does not. See
 * scripts/check-hindi-input.mjs.
 *
 * @param source       what the English field currently reads
 * @param value        what the Hindi field currently reads
 * @param storedSource what the database holds for `source`
 * @param storedValue  the database's Hindi spelling, if any
 * @param pinnedFor    the source in place when the admin last typed in here
 * @param forced       the admin asked for a refill
 */
export function shouldFollow({ source, value, storedSource, storedValue, pinnedFor, forced }) {
  // A hand correction holds — but only for the name it was made against.
  // Once the English moves on, this stops matching and following resumes.
  const pinned = pinnedFor !== null && pinnedFor === source

  // Nothing has been changed since the dialog opened, and there is already a
  // stored spelling. Opening a dialog must never rewrite what is in the
  // database.
  //
  // BOTH fields have to still show the stored pair. Checking only the English
  // one was wrong: an empty Hindi box next to an unchanged English name was
  // reported as "as saved" and left empty, which is neither true nor useful.
  const untouched =
    Boolean(storedValue) &&
    (source ?? '').trim() === (storedSource ?? '').trim() &&
    (value ?? '').trim() === storedValue.trim()

  return !pinned && (Boolean(forced) || !untouched)
}

export default function HindiInput({
  /** The English name to follow. */
  source,
  value,
  onChange,
  /** What the database holds for `source`. Omit in a create dialog. */
  storedSource = null,
  /** What the database holds for `value`. Omit in a create dialog. */
  storedValue = null,
  id = 'name-hi',
  label,
  className = '',
}) {
  const t = useT()

  /**
   * The `source` the admin was looking at when they last typed in here.
   *
   * Storing the source rather than a plain boolean is what makes the pin
   * release itself: once `source` moves on, this no longer matches, and the
   * field resumes following without anyone having to remember to unpin it.
   */
  const [pinnedFor, setPinnedFor] = useState(null)

  /**
   * Set by the "fill it in for me" button.
   *
   * Needed because `untouched` alone would make that button do nothing on a
   * freshly opened Edit dialog: the field is not following precisely BECAUSE
   * nothing has changed, and without this the one control offered to change
   * that would have no effect.
   */
  const [forced, setForced] = useState(false)

  /**
   * Bumped by the refresh button.
   *
   * A counter and not a boolean, because pressing refresh when the field is
   * ALREADY following changes none of the other inputs — so without something
   * that differs every press, the effect would not re-run and the button
   * would do nothing in exactly the case people press it: it looked stuck.
   */
  const [refreshes, setRefreshes] = useState(0)

  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  // onChange is called from inside the effect but must NOT retrigger it: the
  // parent usually passes a fresh arrow function each render, so depending on
  // it would restart the debounce on every keystroke and never fire.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const trimmed = (source || '').trim()
  const pinned = pinnedFor !== null && pinnedFor === source
  const following = shouldFollow({ source, value, storedSource, storedValue, pinnedFor, forced })

  useEffect(() => {
    if (!following) return undefined

    // Nothing to work from, or the admin typed Devanagari into the English
    // field. Either way, clear rather than guess.
    if (!trimmed || !hasLatin(trimmed) || hasDevanagari(trimmed)) {
      onChangeRef.current('')
      setBusy(false)
      setFailed(false)
      return undefined
    }

    const controller = new AbortController()
    setBusy(true)
    setFailed(false)

    const timer = setTimeout(async () => {
      try {
        const hindi = await transliterateToHindi(trimmed, controller.signal)
        onChangeRef.current(hindi)
      } catch (err) {
        // An abort is this component cancelling itself because the source
        // changed — not a failure, and showing "could not convert" for it
        // would flash an error on every keystroke.
        if (err?.name !== 'AbortError') setFailed(true)
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [trimmed, following, refreshes])

  const status = busy
    ? { icon: 'refresh', tone: 'text-ink-subtle', text: t('hindiName.converting') }
    : failed
      ? { icon: 'alert', tone: 'text-warning', text: t('hindiName.failed') }
      : following
        ? { icon: 'check', tone: 'text-ink-subtle', text: t('hindiName.auto') }
        : null

  // Two different reasons for not following, and they must not read the same.
  // "Yours" on a value nobody in this dialog typed is simply untrue.
  const idleText = pinned ? t('hindiName.manual') : t('hindiName.asSaved')

  /** Fill it from the English name right now, whatever state the field is in. */
  const refill = () => {
    setPinnedFor(null)
    setForced(true)
    setFailed(false)
    setRefreshes((n) => n + 1)
  }

  return (
    <Field label={label ?? t('hindiName.label')} htmlFor={id} className={className}>
      {/* Input and button in one row, the same shape as the PIN row in
          StaffManager. min-w-0 on the input so it yields to the button instead
          of pushing it off the edge of a narrow dialog. */}
      <div className="flex items-start gap-2">
        <input
          id={id}
          value={value || ''}
          onChange={(event) => {
            onChange(event.target.value)
            // Pin to the CURRENT source. Editing the English name later moves
            // source on, this stops matching, and the field resumes following.
            setPinnedFor(source)
            setFailed(false)
          }}
          // lang so the browser and any screen reader treat this as Devanagari.
          lang="hi"
          // The ENGLISH name this follows, not a made-up example.
          //
          // It used to be a fixed "राजेश कुमार", which was fine when this field
          // only existed in the staff dialog and confusing everywhere else: on a
          // check-in it read as a suggestion for the guest in front of you.
          // Showing the source says what the field is actually for, and an empty
          // box is honest when there is nothing to follow yet.
          placeholder={source?.trim() ?? ''}
          maxLength={80}
          autoComplete="off"
          spellCheck={false}
          className={cn(
            'h-touch min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-4',
            'text-base font-semibold text-ink outline-none',
            'placeholder:font-normal placeholder:text-ink-subtle',
            'focus:border-brand focus:ring-2 focus:ring-brand/20',
          )}
        />

        {/* ALWAYS here, not only when the field has stopped following.
            The automatic path can fail quietly — a rate limit, a dropped
            request, a name the model returns nothing for — and when it does,
            the thing somebody reaches for is a button they can already see.
            Hunting for a text link that appears only in some states is not
            that. */}
        <Button
          type="button"
          variant="secondary"
          size="icon-md"
          icon="refresh"
          onClick={refill}
          loading={busy}
          disabled={!trimmed}
          title={t('hindiName.refresh')}
          aria-label={t('hindiName.refresh')}
          className="shrink-0"
        />
      </div>

      <p className="mt-1.5 flex items-center gap-1.5 text-xs leading-relaxed text-ink-subtle">
        {status ? (
          <>
            <Icon
              name={status.icon}
              size={13}
              className={cn('shrink-0', status.tone, busy && 'animate-spin')}
            />
            <span className={status.tone}>{status.text}</span>
          </>
        ) : (
          // No link beside it any more: the refresh button above does the same
          // job and is always visible, and two controls for one action is how
          // people end up unsure which one they were meant to press.
          <span>{idleText}</span>
        )}
      </p>
    </Field>
  )
}
