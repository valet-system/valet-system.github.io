/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/DateFields.jsx                              │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   One date, as three plain number fields — day, month, year.         │
 * │                                                                     │
 * │     <DateFields value="2026-06-29" onChange={setIso} max={today} /> │
 * │                                                                     │
 * │   value and onChange speak ISO 'YYYY-MM-DD', or null for empty, so   │
 * │   it drops straight into anything that used <input type="date">.     │
 * │                                                                     │
 * │ ── WHY NOT <input type="date"> ──────────────────────────────────────│
 * │   Its segments AUTO-ADVANCE, and that cannot be switched off. The     │
 * │   segments live in the browser's shadow DOM and the keystroke         │
 * │   handling is native: no attribute, no CSS, no event hook reaches it. │
 * │                                                                     │
 * │   Chrome's rule is that it jumps as soon as more digits become        │
 * │   impossible. Type 3 in the day and it waits — 30 and 31 exist. Type │
 * │   4 and it leaves at once, because there is no 4x day. That is       │
 * │   defensible, but it means a digit sometimes lands in the YEAR field  │
 * │   while somebody is still thinking about the day, and the reader ends │
 * │   up with 0004 as a year and no idea how.                            │
 * │                                                                     │
 * │   So: no auto-advance here AT ALL, by request. Each field holds what  │
 * │   you type until you move yourself. Tab, or click the next field.     │
 * │                                                                     │
 * │ ── WHAT THIS GIVES UP ───────────────────────────────────────────────│
 * │   The browser's calendar picker. On a phone that is a real loss — a   │
 * │   tap on a grid beats typing six digits. Accepted deliberately: these │
 * │   are the report screens, read on a desk far more often than on a     │
 * │   porch. inputMode="numeric" still brings up the number keypad.       │
 * │                                                                     │
 * │ ── WHY THE SEGMENTS ARE STATE AND NOT DERIVED ───────────────────────│
 * │   A half-typed date is not a date. '3' in the day field makes no      │
 * │   valid ISO string, so onChange emits null — and if the fields were   │
 * │   rendered FROM that null they would clear themselves on the first    │
 * │   keystroke. The three strings therefore live here, and the incoming  │
 * │   value only reseeds them when it did not come from us.               │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   ui/RangePicker                                                     │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   utils/cn                                                          │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/utils/cn'

/** '2026-06-29' -> { d: '29', m: '06', y: '2026' }. Anything else -> blanks. */
function split(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  return m ? { y: m[1], m: m[2], d: m[3] } : { y: '', m: '', d: '' }
}

/**
 * Three strings -> ISO, or null.
 *
 * Null covers BOTH "still typing" and "not a real date". The caller does not
 * need to tell those apart — neither one can be searched for — and the panel
 * says which it is by whether all three fields are filled.
 *
 * The round-trip check is what catches 31 February: Date() happily rolls it
 * forward to 3 March, so the only reliable test is to build the date and ask
 * whether it still reads back as the numbers that went in.
 */
function join({ d, m, y }) {
  if (y.length !== 4 || !m || !d) return null

  const yi = Number(y)
  const mi = Number(m)
  const di = Number(d)
  if (!yi || mi < 1 || mi > 12 || di < 1 || di > 31) return null

  const iso = `${y}-${String(mi).padStart(2, '0')}-${String(di).padStart(2, '0')}`
  const back = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(back.getTime())) return null
  // Rolled over, so the day does not exist in that month.
  if (back.getUTCDate() !== di || back.getUTCMonth() + 1 !== mi) return null

  return iso
}

/** True when all three are filled but they do not name a real date. */
function isImpossible(parts) {
  const filled = parts.d && parts.m && parts.y.length === 4
  return Boolean(filled) && join(parts) === null
}

export default function DateFields({
  value,
  onChange,
  /** ISO upper bound, inclusive. Checked on assembly, not while typing. */
  max,
  /** ISO lower bound, inclusive. */
  min,
  labels = { day: 'Day', month: 'Month', year: 'Year' },
  invalidText = 'That date does not exist.',
  outOfRangeText = 'That date is outside the allowed range.',
  className = '',
  id,
}) {
  const [parts, setParts] = useState(() => split(value))

  // What we last handed upward. The reseed below compares against this so a
  // null we CAUSED (mid-typing) cannot wipe the fields, while a value from
  // somewhere else — a preset, a parent restoring state — still lands.
  const emitted = useRef(value ?? null)

  useEffect(() => {
    if ((value ?? null) === emitted.current) return
    emitted.current = value ?? null
    setParts(split(value))
  }, [value])

  const emit = (next) => {
    setParts(next)
    const iso = join(next)
    // Out of bounds is reported, not silently corrected: clamping would change
    // a typed date to a different one under the reader's hands.
    const ok = iso && (!max || iso <= max) && (!min || iso >= min)
    const out = ok ? iso : null
    emitted.current = out
    onChange(out)
  }

  const bad = isImpossible(parts)
  const iso = join(parts)
  const ranged = iso && ((max && iso > max) || (min && iso < min))

  /** Digits only, capped. NO advancing to the next field — that is the point. */
  const field = (key, size, label, placeholder) => (
    <input
      id={key === 'd' && id ? id : undefined}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      placeholder={placeholder}
      value={parts[key]}
      maxLength={size}
      onChange={(e) => emit({ ...parts, [key]: e.target.value.replace(/\D/g, '').slice(0, size) })}
      // Selects what is there so the next digit replaces rather than appends —
      // the one convenience a native date input gets right, and the only
      // behaviour worth keeping from it.
      onFocus={(e) => e.target.select()}
      className={cn(
        'tnum h-11 rounded-xl border bg-surface text-center text-base font-medium text-ink',
        'outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 sm:text-sm',
        'placeholder:font-normal placeholder:text-ink-subtle',
        size === 4 ? 'w-[4.5rem]' : 'w-[3rem]',
        bad ? 'border-danger' : 'border-line-strong',
      )}
    />
  )

  return (
    <div className={className}>
      <div className="flex items-center gap-1">
        {field('d', 2, labels.day, 'DD')}
        <span className="text-ink-subtle">/</span>
        {field('m', 2, labels.month, 'MM')}
        <span className="text-ink-subtle">/</span>
        {field('y', 4, labels.year, 'YYYY')}
      </div>

      {/* Said out loud rather than corrected. A silently clamped date is a date
          the reader did not choose, reported as if they had. */}
      {(bad || ranged) && (
        <p className="mt-1 text-xs font-medium text-danger">
          {bad ? invalidText : outOfRangeText}
        </p>
      )}
    </div>
  )
}
