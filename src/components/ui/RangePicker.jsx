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
import DateFields from '@/components/ui/DateFields'

/**
 * `back` is how many days to step BACK from today, so the range is inclusive of
 * both ends: Today is 0 (from === to), "7 days" is 6 — today plus the six
 * before it. Using 7 there would quietly return eight days.
 */
/**
 * Every preset this component knows how to compute — the CATALOGUE, not the list
 * any one screen shows. presetRange() and the active-pill match both look here,
 * so a key must exist in this array even if only one screen renders it.
 *
 * labelKey, not label: this array is evaluated once at import time, so a literal
 * would freeze whichever language happened to load first.
 *
 * The 90d and 1y labels reuse the records.* keys they were already translated
 * under. Slightly odd naming for a shared component, and better than a second
 * pair of keys saying the same words.
 */
export const PRESETS = [
  { key: 'today', labelKey: 'range.today', back: 0 },
  { key: '7d', labelKey: 'range.7d', back: 6 },
  { key: '30d', labelKey: 'range.30d', back: 29 },
  { key: '90d', labelKey: 'records.90d', back: 89 },
  { key: '1y', labelKey: 'records.1y', back: 364 },
]

/**
 * What a screen gets if it does not choose: the three short ranges.
 *
 * Analytics aggregates server-side over whatever it is given, and offering a
 * year there by default would invite a slow query nobody asked for.
 */
export const SHORT_PRESETS = PRESETS.slice(0, 3)

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

export default function RangePicker({
  from,
  to,
  onChange,
  /**
   * Which pills to offer. Defaults to PRESETS.
   *
   * A prop and not a constant, because Records wants 90 days and a year and
   * Analytics does not. Adding those to the shared PRESETS would have changed
   * the Analytics screen too, which nobody asked for — a shared component
   * growing options for one caller is how the other caller's UI drifts.
   */
  presets = SHORT_PRESETS,
  className = '',
}) {
  const t = useT()
  const [custom, setCustom] = useState(false)

  /**
   * The dates being typed, held back until Search is pressed.
   *
   * ── WHY A DRAFT AND NOT onChange PER KEYSTROKE ──────────────────────
   * The date inputs used to call onChange directly, and every caller runs its
   * query off [range.from, range.to]. So picking a date re-queried the page
   * IMMEDIATELY — and a <input type="date"> fires change more than once while a
   * date is being assembled, so choosing one period could send several requests
   * for periods nobody asked about. Half-built dates like 2026-06-0 went to the
   * server, the screen flickered through wrong numbers, and the reader had no
   * way to tell a loading state from a result.
   *
   * Now the fields write here, and nothing leaves this component until Search.
   *
   * PRESETS ARE NOT DRAFTED. One tap is one complete intent — there is no
   * half-typed "last 7 days" — so those still apply straight away. Reset is the
   * same: it is a discard, and making somebody confirm a discard is noise.
   */
  const [draft, setDraft] = useState({ from, to })

  // Re-seed whenever the APPLIED range changes — a preset tap, or a parent
  // restoring a saved range. Without this the draft would keep showing dates
  // that are no longer in effect the next time the panel is opened.
  useEffect(() => {
    setDraft({ from, to })
  }, [from, to])

  // Is there anything to search for? Used to enable the button, and it is also
  // the only signal on screen that a pick has not been applied yet.
  const dirty = draft.from !== from || draft.to !== to

  // Built once per render rather than inline twice, so both fields cannot drift
  // apart, and so a new object identity is not handed to DateFields on every
  // keystroke of the other one.
  const dateLabels = { day: t('range.day'), month: t('range.month'), year: t('range.year') }

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

    // `presets`, not the catalogue: a range matching a preset this screen does
    // not offer is a custom range as far as this screen is concerned.
    const match = presets.find((p) => presetRange(p.key).from === from)
    return match?.key ?? null
  }, [from, to, presets])

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
        {presets.map((option) => (
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
          {/* gap-x-6, not gap-2. The two dates are six little boxes in a row,
              and with the same gap outside as inside they read as ONE chain:
              29 / 07 / 2026 / DD / MM / YYYY. The wide outer gap is the only
              thing telling the eye where FROM ends and TO begins. */}
          {/* items-START, not items-end.
              DateFields grows a line of error text under itself when a date is
              impossible. With items-end that made the OTHER group's boxes drop
              to line up with the bottom of the errored one — an error in From
              visibly nudged To downwards. Aligning tops keeps the six boxes on
              one line whatever appears below them. */}
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            {/* A div, not a label. A <label> points at ONE control; wrapping
                three makes a click on the word land on whichever the browser
                guesses. DateFields already labels each box for screen readers. */}
            <div className="flex flex-col gap-1">
              <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-ink-subtle">
                {t('range.from')}
              </span>
              {/* Three fields, not <input type="date"> — see DateFields for
                  why. A start after the end is refused by the RPC as
                  BAD_RANGE, so `max` stops it being assembled at all, which is
                  a better place to stop it than an error after a round trip.

                  draft.to, not the applied `to`: bounded against what is on
                  screen, or a From could be refused for clashing with an end
                  date the reader has already changed.

                  Empty comes back as null, not swallowed. Both ends are
                  optional and the server fills in what is missing — clearing a
                  field has to actually clear it, or the control lies about what
                  is in effect. */}
              <DateFields
                value={draft.from}
                max={draft.to ?? today}
                onChange={(iso) => setDraft((d) => ({ ...d, from: iso }))}
                labels={dateLabels}
                invalidText={t('range.badDate')}
                outOfRangeText={t('range.outOfRange')}
              />
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-ink-subtle">
                {t('range.to')}
              </span>
              {/* No future dates. There is no data there, and an empty chart
                  reads as "we had no cars" rather than "that has not happened". */}
              <DateFields
                value={draft.to}
                min={draft.from ?? undefined}
                max={today}
                onChange={(iso) => setDraft((d) => ({ ...d, to: iso }))}
                labels={dateLabels}
                invalidText={t('range.badDate')}
                outOfRangeText={t('range.outOfRange')}
              />
            </div>

            {/* Their own group. Loose in the row they inherited the same gap as
                the date boxes and Search ended up flush against YYYY, reading
                as a seventh segment. */}
            <div className="flex flex-col gap-1">
              {/* A spacer label, so this group has the same shape as the two
                  beside it and items-start lines all three up on its own. A
                  hard-coded top margin would do the same until somebody changes
                  the label's font size. */}
              <span aria-hidden="true" className="text-[0.6875rem] font-bold uppercase tracking-wider">
                &nbsp;
              </span>
              <div className="flex items-center gap-3">
            {/* Nothing is queried until this is pressed. Disabled while the
                draft matches what is already on screen, which is also how the
                reader can tell whether a pick is still waiting to be applied. */}
            <button
              type="button"
              onClick={() => onChange(draft)}
              disabled={!dirty}
              className={cn(
                'h-11 rounded-xl px-4 text-sm font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
                dirty
                  ? 'bg-brand text-ink-inverse hover:opacity-90'
                  : 'cursor-not-allowed border border-line-strong bg-surface-sunken text-ink-subtle',
              )}
            >
              {t('range.search')}
            </button>

              <button
                type="button"
                onClick={() => {
                  setCustom(false)
                  onChange(presetRange('30d'))
                }}
                className="h-11 px-1 text-xs font-semibold text-info hover:text-ink"
              >
                {t('range.reset')}
              </button>
              </div>
            </div>
          </div>

          {/* The DD / MM / YYYY placeholders say what goes in each box, but not
              what LEAVING them empty means — and a blank To looks unfinished,
              so nobody trusts the numbers on screen until it is said. */}
          <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink-subtle">
            <Icon name="info" size={13} className="mt-0.5 shrink-0" />
            <span>{t('range.emptyHint')}</span>
          </p>
        </div>
      )}
    </div>
  )
}
