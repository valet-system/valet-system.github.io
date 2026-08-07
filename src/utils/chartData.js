/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/utils/chartData.js                                        │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Turns what analytics_summary() returns into what BarChart takes.   │
 * │   Two adapters, shared by the property and the group screens so the  │
 * │   same data never gets drawn two slightly different ways.            │
 * │                                                                     │
 * │ WHY THE AXIS LABELS THIN OUT                                         │
 * │   Ninety daily labels do not fit on any screen, and rotating them is │
 * │   harder to read than leaving some out — a rotated label has to be   │
 * │   traced, a sparse axis is just read. The bars all stay; only the    │
 * │   text under them is sampled, and the tooltip carries the exact date │
 * │   for every bar.                                                     │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   admin/Analytics, system/Analytics                                  │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   nothing                                                           │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { pickLang } from '@/i18n/activeLang'

/** @param perDay [{ d: 'YYYY-MM-DD', cars: number }] */
export function toDayChart(perDay = [], days = 30) {
  const every = days <= 7 ? 1 : days <= 30 ? 5 : 15

  return perDay.map((point, index) => {
    const [, month, day] = String(point.d).split('-')
    return {
      label: index % every === 0 ? `${Number(day)}/${Number(month)}` : '',
      full: point.d,
      value: point.cars,
    }
  })
}

/** @param perHour [{ h: 0..23, cars: number }] */
export function toHourChart(perHour = []) {
  return perHour.map((point) => ({
    label: point.h % 3 === 0 ? String(point.h).padStart(2, '0') : '',
    full: `${String(point.h).padStart(2, '0')}:00–${String((point.h + 1) % 24).padStart(2, '0')}:00`,
    value: point.cars,
  }))
}

/** The hour with the most cars, or null when there is no data. */
export function peakHour(perHour = []) {
  if (!perHour.length) return null
  return perHour.reduce((best, point) => (point.cars > best.cars ? point : best)).h
}

/** "14:00–15:00", for a caption. */
export function hourLabel(hour) {
  if (hour == null) return null
  return `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`
}

/**
 * A human label for a date range: "Today", "1 Aug – 30 Aug", "5 Aug".
 *
 * Every caption on the analytics screens used to say "the last N days", which
 * became a lie the moment a custom range existed — a chart of last September
 * captioned "the last 30 days" is worse than no caption, because it is read and
 * believed.
 *
 * Dates in, dates out. `from` and `to` are IST business dates (YYYY-MM-DD), and
 * are parsed at noon so a device in another timezone cannot shift the day.
 */
export function rangeLabel(from, to) {
  if (!from || !to) return ''

  const at = (d) => new Date(`${d}T12:00:00+05:30`)
  const short = (d) =>
    at(d).toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
    })

  if (from === to) return short(from)
  return `${short(from)} – ${short(to)}`
}

/**
 * "9 a day", or "9 in a day" for a single day.
 *
 * Never returns "0 a day". Math.round(9 / 30) is 0, which is arithmetically
 * right and reads as "we had no cars" on a screen that is simultaneously
 * showing 9 — so anything under 1 gets a decimal instead.
 */
export function perDayLabel(cars, days) {
  if (!days || days < 1) return ''
  // pickLang rather than a hook: this is called from inside JSX expressions,
  // not from a component body. See src/i18n/activeLang.
  if (days === 1) return pickLang('in one day', 'एक दिन में')

  const rate = cars / days
  if (rate === 0) return pickLang('none yet', 'अभी कोई नहीं')
  if (rate < 1) return pickLang(`${rate.toFixed(1)} a day`, `रोज़ ${rate.toFixed(1)}`)
  return pickLang(`${Math.round(rate)} a day`, `रोज़ ${Math.round(rate)}`)
}
