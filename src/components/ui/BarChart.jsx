/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/BarChart.jsx                                │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Two chart primitives, both plain CSS. No charting library — the    │
 * │   smallest one is ~50kB gzipped and this app is loaded over hotel    │
 * │   wifi on cheap Androids, for two shapes we can draw with divs.      │
 * │                                                                     │
 * │     BarChart   vertical bars over time (per hour, per day)           │
 * │     MeterList  horizontal labelled rows (how a total splits up)      │
 * │                                                                     │
 * │ WHY BarChart IS ONE COLOUR                                           │
 * │   Every bar is the same measure at a different time, so colour has   │
 * │   no job here — it would only imply a difference that does not       │
 * │   exist. One hue, and therefore no legend: the heading names the     │
 * │   series. The only bar that differs is the one under the cursor.     │
 * │                                                                     │
 * │ WHY MeterList EXISTS INSTEAD OF A PIE OR A COLOURED BAR CHART        │
 * │   The breakdowns in this app are by car tier and by rating, and both │
 * │   already own colours elsewhere — a VIP badge is gold on every       │
 * │   screen. Reusing those as CATEGORICAL chart colours fails: the      │
 * │   Standard tier is deliberately near-gray (it is ~80% of cars, so    │
 * │   the design system suppresses it), and a near-gray slot cannot      │
 * │   carry identity on its own.                                        │
 * │                                                                     │
 * │   So identity is carried by a LABEL on every row, and the bar only   │
 * │   shows magnitude. That is also what makes it readable with any      │
 * │   form of colour blindness, in greyscale, and when printed.          │
 * │                                                                     │
 * │ ACCESSIBILITY                                                        │
 * │   Both render a screen-reader table of the same numbers. A bar is a  │
 * │   div; without it the data does not exist for anyone not looking at  │
 * │   the screen.                                                        │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   admin/TokenMgmt, admin/Analytics, admin/Reviews, system/Analytics  │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   utils/cn                                                          │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useId, useState } from 'react'
import { useI18n, useT } from '@/i18n'
import { cn } from '@/utils/cn'

/**
 * @param data      [{ label, value, full }] — `full` is the long form used in
 *                  the tooltip and the screen-reader table ("14:00–15:00").
 * @param labelEvery show every Nth axis label. 24 hourly labels do not fit on
 *                   a phone, and a rotated axis is worse than a sparse one.
 * @param unit      pluralised in the tooltip: "3 cars"
 */
export function BarChart({
  data = [],
  height = 160,
  labelEvery = 1,
  unit = '',
  emptyLabel = null,
  className = '',
  caption,
  /**
   * Narrowest a bar may get before the chart scrolls instead of squeezing.
   *
   * Without a floor, 90 days on a phone gives each bar under a pixel while
   * the 2px gaps stay fixed — so the chart becomes mostly gap, and the taller
   * bars read as thin lines you cannot compare. Below this width the row
   * scrolls sideways and every bar stays legible.
   */
  minBarWidth = 8,
}) {
  const { t, lang } = useI18n()
  const [hovered, setHovered] = useState(null)
  const tableId = useId()

  const max = Math.max(...data.map((d) => d.value), 0)
  // +2 for the gap that follows each bar.
  const naturalWidth = data.length * (minBarWidth + 2)

  if (data.length === 0 || max === 0) {
    return (
      <p
        className={cn(
          'flex items-center justify-center rounded-xl bg-surface-sunken text-sm text-ink-subtle',
          className,
        )}
        style={{ height }}
      >
        {emptyLabel ?? t('common.nothingToShow')}
      </p>
    )
  }

  return (
    <figure className={cn('m-0', className)}>
      {/* Bars and axis share ONE scroll container, so a scrolled chart keeps
          its labels under the right bars. Two containers would drift apart
          the moment anyone scrolled.

          pt-8 is for the tooltip, not for looks. CSS will not let one axis
          scroll while the other stays visible — set overflow-x and overflow-y
          computes to auto too — so a tooltip sitting above a bar would be
          clipped by the very container that makes the chart scrollable. The
          padding gives it somewhere to be. */}
      <div className="scrollbar-slim overflow-x-auto pt-8">
        <div style={{ minWidth: naturalWidth }}>
      <div
        className="flex items-end gap-[2px] border-b border-line"
        style={{ height }}
        // The bars are decorative duplicates of the table below, which is the
        // accessible copy. Announcing both would read every number twice.
        aria-hidden="true"
      >
        {data.map((point, index) => {
          const isHovered = hovered === index
          // Floor at 2px so a non-zero value is never invisible — "1 car" and
          // "no cars" must not look the same.
          const pct = max > 0 ? (point.value / max) * 100 : 0
          const barHeight = point.value === 0 ? 2 : Math.max(2, (pct / 100) * height)

          return (
            <div
              key={point.label}
              className="relative flex min-w-0 flex-1 justify-center"
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
            >
              {isHovered && point.value > 0 && (
                <span className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-xs font-semibold text-ink-inverse shadow-pop">
                  {point.full ?? point.label}: {point.value}
                  {/* The trailing "s" is English grammar. Hindi does not form
                      a plural that way, and appending one gives "गाड़ीs". */}
                  {unit && ` ${unit}${lang === 'en' && point.value !== 1 ? 's' : ''}`}
                </span>
              )}

              <div
                className={cn(
                  'w-full rounded-t transition-colors duration-100',
                  // ── WHY NOT bg-info ──────────────────────────────────────
                  // These were bright blue, and blue is the only cool colour
                  // left in an app whose chrome is near-black with a gold
                  // accent. A wall of twenty saturated blue bars is the loudest
                  // thing on the screen and it is not the most important — the
                  // reader wants the SHAPE of the week, not to be shouted at by
                  // every bar equally.
                  //
                  // Accent for the bars, brand on hover. That keeps the hover
                  // readable as "this one" — it goes darker and denser against
                  // its neighbours — and it stops the chart competing with the
                  // status badges, which still own blue and use it to MEAN
                  // something.
                  point.value === 0
                    ? 'bg-line'
                    : isHovered
                      ? 'bg-brand'
                      : 'bg-accent',
                )}
                style={{ height: barHeight }}
              />
            </div>
          )
        })}
      </div>

      {/* Sparse axis. A label under every hour would collide on a phone. */}
      <div className="mt-1.5 flex gap-[2px]">
        {data.map((point, index) => (
          <span
            key={point.label}
            className="min-w-0 flex-1 truncate text-center text-[0.625rem] leading-tight text-ink-subtle"
          >
            {index % labelEvery === 0 ? point.label : ''}
          </span>
        ))}
      </div>
        </div>
      </div>

      {caption && <figcaption className="mt-2 text-xs text-ink-subtle">{caption}</figcaption>}

      {/* ── sr-only on the WRAPPER, never on the table ────────────────────
          The table itself carried `sr-only` and it did not work, in a way that
          took a page measurement to see rather than a look.

          sr-only sets height: 1px — and a <table> treats height as a MINIMUM,
          so it stayed its natural 830px. It was still invisible, because
          sr-only also sets overflow: hidden and clip, so nothing looked wrong.
          But it is position: absolute, and an absolutely positioned box still
          counts toward its containing block's scrollable overflow. So every
          chart silently added several hundred pixels of empty scroll below the
          page, and on the Analytics screen that showed up as the dark sidebar
          appearing to stop two thirds of the way down.

          A <div> honours height: 1px, so wrapping fixes it: the div collapses
          and clips the full-size table inside. The id stays on the table, which
          is what aria-describedby points at. */}
      <div className="sr-only">
        <table id={tableId}>
          <caption>{caption ?? 'Chart data'}</caption>
          <thead>
            <tr>
              <th scope="col">{t('chart.period')}</th>
              <th scope="col">{t('chart.count')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((point) => (
              <tr key={point.label}>
                <th scope="row">{point.full ?? point.label}</th>
                <td>{point.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  )
}

/**
 * Labelled horizontal rows — a total split into named parts.
 *
 * @param rows [{ key, label, value, tone, badge }]
 *             `badge` is an optional node rendered instead of plain text, so a
 *             page can reuse TierBadge / RatingBadge and keep one visual
 *             language for a value across the whole app.
 */
export function MeterList({ rows = [], total, unit = '', className = '', caption }) {
  const t = useT()
  const sum = total ?? rows.reduce((acc, row) => acc + row.value, 0)

  const fill = {
    // `info` is the default a caller reaches for when a bar means "here is a
    // quantity" rather than "something is wrong" — which is almost always. It
    // paints ACCENT, so those bars match the vertical chart above them instead
    // of being blue beside gold on the same screen.
    //
    // The other tones keep their own colours, because those DO mean something:
    // a danger bar has to be red whatever the theme is.
    info: 'bg-accent',
    accent: 'bg-accent',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    vip: 'bg-vip',
    neutral: 'bg-ink-subtle',
  }

  if (sum === 0) {
    return (
      <p className={cn('rounded-xl bg-surface-sunken px-4 py-6 text-center text-sm text-ink-subtle', className)}>
        {t('common.nothingToShow')}
      </p>
    )
  }

  return (
    <figure className={cn('m-0 space-y-3', className)}>
      {rows.map((row) => {
        const pct = sum > 0 ? (row.value / sum) * 100 : 0

        return (
          <div key={row.key}>
            <div className="mb-1 flex items-center justify-between gap-3">
              {/* The label is what identifies the row. The bar's colour is
                  reinforcement, never the only signal. */}
              <span className="flex min-w-0 items-center gap-2">
                {row.badge ?? (
                  <span className="truncate text-sm font-medium text-ink">{row.label}</span>
                )}
              </span>
              <span className="tnum shrink-0 text-sm text-ink-muted">
                <span className="font-semibold text-ink">{row.value}</span>
                {unit && ` ${unit}`} · {Math.round(pct)}%
              </span>
            </div>

            <div className="h-2 w-full overflow-hidden rounded-full bg-line">
              <div
                className={cn('h-full rounded-full', fill[row.tone] ?? fill.neutral)}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )
      })}

      {caption && <figcaption className="text-xs text-ink-subtle">{caption}</figcaption>}
    </figure>
  )
}

export default BarChart
