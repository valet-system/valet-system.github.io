/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/RangePicker.jsx                             │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The date range control above every analytics screen: Today, 7      │
 * │   days, 30 days, and a custom from/to.                               │
 * │                                                                     │
 * │ IT REPORTS DATES, NOT A NUMBER OF DAYS                                │
 * │   It used to hand back `days` and the RPC always ended at today.     │
 * │   That answers "the last 30 days" and nothing else — not "last       │
 * │   Saturday", not "the wedding weekend", not "September". Those are   │
 * │   the questions somebody comparing two periods actually asks, so the │
 * │   value is `{ from, to }` and a preset is just one pair this         │
 * │   component happens to compute.                                     │
 * │                                                                     │
 * │ WHY PILLS AND NOT A <select>                                          │
 * │   Switching range is the main thing anyone does on these screens. A  │
 * │   select hides the options behind a tap and gives no sense of where  │
 * │   you are.                                                          │
 * │                                                                     │
 * │ THE CUSTOM FIELDS ARE NATIVE <input type="date">                      │
 * │   No date-picker library. The native control is a calendar the OS    │
 * │   already knows how to draw, it is localised, it is keyboard and     │
 * │   screen-reader accessible for free, and on a phone it opens the OS  │
 * │   wheel — better than anything a library renders in a webview.       │
 * │                                                                     │
 * │ WHY IT IS ITS OWN FILE                                               │
 * │   system/Analytics used to import this straight out of                │
 * │   admin/Analytics. That worked, and it quietly undid route-level     │
 * │   code splitting: opening the group screen pulled the whole admin    │
 * │   analytics page in with it, because one module importing another    │
 * │   puts them in the same chunk.                                      │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   admin/Analytics, system/Analytics                                  │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   utils/format (IST dates), ui/Icon, utils/cn                        │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useMemo, useState } from 'react'
import Icon from '@/components/ui/Icon'
import { useT } from '@/i18n'
import { istDaysAgo, istToday } from '@/utils/format'
import { cn } from '@/utils/cn'

/**
 * `back` is how many days to step BACK from today, so the range is inclusive of
 * both ends: Today is 0 (from === to), "7 days" is 6 — today plus the six
 * before it. Using 7 there would quietly return eight days.
 */
export const PRESETS = [
  // labelKey, not label: this array is evaluated once at import time, so a
  // literal would freeze whichever language happened to load first.
  { key: 'today', labelKey: 'range.today', back: 0 },
  { key: '7d', labelKey: 'range.7d', back: 6 },
  { key: '30d', labelKey: 'range.30d', back: 29 },
]

/**
 * The {from, to} for a preset key, in IST — never the device's timezone.
 *
 * `to` is deliberately NULL, not today's date. The server already treats a
 * missing end as "up to today" (migration 0018), so leaving it null means one
 * place decides what "now" is — and that place is the database, whose clock is
 * the only one this app trusts. Filling in the device's idea of today would put
 * a second answer in the browser, and a phone left on the wrong date would
 * quietly ask for the wrong period.
 */
export function presetRange(key) {
  const preset = PRESETS.find((p) => p.key === key) ?? PRESETS[2]
  return { from: istDaysAgo(preset.back), to: null }
}

export default function RangePicker({ from, to, onChange, className = '' }) {
  const t = useT()
  const [custom, setCustom] = useState(false)

  /**
   * Which preset the current range matches, or null for a custom one.
   *
   * Derived from the dates rather than stored as "the selected pill". Stored, a
   * parent restoring a saved range would show no pill highlighted even when the
   * dates are exactly "30 days".
   */
  const activeKey = useMemo(() => {
    // A preset always leaves `to` open, so an explicit end date means the range
    // was hand-picked even if the start happens to match a preset.
    if (to) return null

    const match = PRESETS.find((p) => presetRange(p.key).from === from)
    return match?.key ?? null
  }, [from, to])

  // Open the custom fields when the range arrives already custom, so the dates
  // on screen are the dates in effect rather than a collapsed panel.
  useEffect(() => {
    if (activeKey === null) setCustom(true)
  }, [activeKey])

  const today = istToday()

  return (
    <div className={cn('mb-4 space-y-2', className)}>
      {/* aria-pressed, not aria-selected: these are toggle buttons, not tabs —
          there is no tabpanel for them to control. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('range.label')}>
        {PRESETS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => {
              setCustom(false)
              onChange(presetRange(option.key))
            }}
            aria-pressed={!custom && activeKey === option.key}
            className={cn(
              'rounded-full px-3.5 py-2 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
              !custom && activeKey === option.key
                ? 'bg-brand font-semibold text-ink-inverse'
                : 'border border-line-strong bg-surface font-medium text-ink-muted hover:bg-surface-sunken',
            )}
          >
            {t(option.labelKey)}
          </button>
        ))}

        <button
          type="button"
          onClick={() => setCustom((v) => !v)}
          aria-pressed={custom}
          aria-expanded={custom}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
            custom
              ? 'bg-brand font-semibold text-ink-inverse'
              : 'border border-line-strong bg-surface font-medium text-ink-muted hover:bg-surface-sunken',
          )}
        >
          <Icon name="clock" size={14} />
          {t('range.custom')}
        </button>
      </div>

      {custom && (
        <div className="rounded-xl border border-line bg-surface p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-ink-subtle">
                {t('range.from')}
              </span>
              <input
                type="date"
                value={from ?? ''}
                // A start after the end is refused by the RPC as BAD_RANGE. `max`
                // stops it being picked at all, which is a better place to stop
                // it than an error message after a round trip.
                max={to ?? today}
                // Empty is passed through as null, not swallowed. Both ends are
                // optional, and the server fills in what is missing — clearing a
                // field has to actually clear it or the control lies about what
                // is in effect.
                onChange={(e) => onChange({ from: e.target.value || null, to })}
                className="tnum h-11 rounded-xl border border-line-strong bg-surface px-3 text-base font-medium text-ink outline-none focus:border-brand sm:text-sm"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-ink-subtle">
                {t('range.to')}
              </span>
              <input
                type="date"
                value={to ?? ''}
                min={from ?? undefined}
                // No future dates. There is no data there, and an empty chart
                // reads as "we had no cars" rather than "that has not happened".
                max={today}
                onChange={(e) => onChange({ from, to: e.target.value || null })}
                className="tnum h-11 rounded-xl border border-line-strong bg-surface px-3 text-base font-medium text-ink outline-none focus:border-brand sm:text-sm"
              />
            </label>

            <button
              type="button"
              onClick={() => {
                setCustom(false)
                onChange(presetRange('30d'))
              }}
              className="h-11 px-2 text-xs font-semibold text-info hover:text-ink"
            >
              {t('range.reset')}
            </button>
          </div>

          {/* A date input cannot carry a placeholder, so what "empty" means has
              to be said out loud — otherwise a blank To looks unfinished and
              nobody trusts the numbers on screen. */}
          <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink-subtle">
            <Icon name="info" size={13} className="mt-0.5 shrink-0" />
            <span>{t('range.emptyHint')}</span>
          </p>
        </div>
      )}
    </div>
  )
}
