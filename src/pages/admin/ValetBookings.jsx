/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/admin/ValetBookings.jsx                             │
 * │                                                                     │
 * │ WHAT THIS SCREEN IS                                                 │
 * │   Ambria Admin's valet bookings, shown inside this app. A month grid  │
 * │   of days, and beside it a panel for the day that is selected: the    │
 * │   totals, then one row per booking with its staffing snapshot.        │
 * │                                                                     │
 * │   Above the calendar, Daily / Weekly / Monthly scopes those totals,   │
 * │   and the days it counts are banded in the grid.                      │
 * │                                                                     │
 * │ BOOKINGS ONLY — NO CRM EVENTS                                        │
 * │   The feed also returns venue events with no booking yet. Nothing     │
 * │   here shows them any more (removed on request), so `events: false`   │
 * │   is sent and the CRM leg is never asked for. That is why every call  │
 * │   is ~1s with no worst case; with the leg it was ~15s whenever         │
 * │   Ambria's sweep cache expired. Re-enabling is two flags and a         │
 * │   section — the feed and the proxy still support it in full.           │
 * │                                                                     │
 * │ READ-ONLY, AND SAID SO ON SCREEN                                     │
 * │   Bookings are created, edited and deleted in Ambria Admin, which     │
 * │   owns the one-booking-per-venue-per-day constraint, the staffing     │
 * │   matrix and the event matching. Somebody will try to edit a row;     │
 * │   finding out from a missing save button is a worse way to learn it   │
 * │   than a label.                                                      │
 * │                                                                     │
 * │ WHY IT POLLS INSTEAD OF SUBSCRIBING                                  │
 * │   Realtime would need Ambria's anon key in this browser, and every    │
 * │   table on that project carries a permissive "Allow all" policy — so  │
 * │   that key is full read AND write on their staff, attendance and      │
 * │   repair data. See src/lib/ambriaFeed.js.                            │
 * │                                                                     │
 * │   One interval, 30s, gated on tab visibility.                         │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/lib/ambriaFeed.js -> our ambria-bookings edge function          │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '@/components/AppShell'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import EmptyState from '@/components/ui/EmptyState'
import Icon from '@/components/ui/Icon'
import Badge from '@/components/ui/Badge'
import { PageSpinner } from '@/components/ui/Spinner'
import StatTile, { StatRow } from '@/components/ui/StatTile'
import { useI18n } from '@/i18n'
import { ambriaFeed, AmbriaFeedError } from '@/lib/ambriaFeed'
import { formatTime, istToday } from '@/utils/format'

/**
 * The last good answer for each range, so coming back to a month already seen
 * is instant instead of another round trip.
 *
 * Ambria's own valet screen feels immediate for exactly this reason: it never
 * reloads from nothing. It polls every five seconds and always has an answer
 * in memory, so nobody ever watches it fetch. This is the same trick with a
 * smaller budget — show what we had, then quietly check.
 *
 * MODULE SCOPE, NOT localStorage, and that is deliberate. These rows carry
 * customer names, and the porch tablet is a shared device; writing them to
 * disk would leave them readable long after whoever looked at them walked
 * away. Living in memory means the cache dies with the tab, which is the right
 * lifetime for it.
 *
 * Always revalidated, never trusted as final: the cached answer is painted and
 * a real request goes out behind it. A booking deleted in Ambria therefore
 * disappears on the next reply rather than living on in here.
 */
const cache = new Map()

/**
 * How often the bookings are re-read.
 *
 * TEN SECONDS. It was thirty, which was the right number when every call still
 * dragged the CRM events leg behind it and could cost fifteen seconds; polling
 * hard would have meant requests overlapping their own replies.
 *
 * That leg is gone — nothing here shows those events any more — so a call is
 * about a second, and thirty seconds of waiting to see a booking somebody just
 * made in Ambria is a cost with nothing left on the other side of it. Ambria's
 * own tabs poll at five.
 *
 * Not lower than ten. Each request is a chain — this browser, our edge
 * function, Ambria's edge function, Ambria's database — and shortening it
 * further multiplies load on somebody else's project to shave a second off a
 * calendar that changes a few times a day.
 */
const POLL_MS = 10_000

// ═══════════════════════════════════════════════════════════════════════
// DATES
//
// Every date here is a plain 'YYYY-MM-DD' string, built and compared as text.
// Nothing is put through `new Date(str)` and read back, because that parses as
// UTC and comes back a day earlier for anybody east of Greenwich — which is
// everybody using this app. The strings the feed sends are calendar dates with
// no time and no zone, and they are kept that way.
// ═══════════════════════════════════════════════════════════════════════

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`

/** Days in a month. `new Date(y, m + 1, 0)` is local-time arithmetic, safe. */
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate()

/** Monday-first index for the 1st of the month, so the grid lines up. */
const firstWeekday = (y, m) => (new Date(y, m, 1).getDay() + 6) % 7

/** A Date as the plain calendar date it represents locally. */
const keyOf = (d) => dayKey(d.getFullYear(), d.getMonth(), d.getDate())

/**
 * A month, and the wider span actually fetched for it.
 *
 * `new Date(y, m, 1)` normalises the month first, so callers can pass month 12
 * or -1 and get January of the next year or December of the last — which is
 * what makes stepping and prefetching a neighbour one expression instead of
 * four lines of year arithmetic each time.
 *
 * ── WHY THE FETCH RUNS SIX DAYS PAST THE MONTH ───────────────────────
 * Because Weekly is a ROLLING seven days from its anchor day, not a
 * Monday-to-Sunday calendar week — and a rolling week starting on the 30th of
 * September ends on the 6th of October.
 *
 * Fetch only September and that week is missing six days. Missing SILENTLY,
 * which is the part that matters: the total would simply come out lower, with
 * nothing on screen to say days had been left out. A staffing figure that is
 * quietly short is worse than no figure at all.
 *
 * So the request runs six days past the last day of the month — every rolling
 * week that can start inside this month is then complete in memory, and
 * switching period costs no request at all.
 *
 * It also reaches six days BACK from the 1st, for the case that follows from
 * the band being visible: a week anchored on the 30th of September runs into
 * October, so stepping to October to see the rest of it keeps the anchor on the
 * 30th — a day outside that month. Without the leading week, October's totals
 * would drop it, and drop it silently.
 *
 * Twelve extra days in all, nowhere near the feed's 400-day cap.
 *
 * from/to remain the month itself — the Monthly total must not count the
 * following days this span drags in.
 *
 * Defined AFTER daysInMonth on purpose: it calls it, and a const arrow is in
 * its temporal dead zone until its own line.
 */
function monthRange(y, m, venue) {
  const first = new Date(y, m, 1)
  const yy = first.getFullYear()
  const mm = first.getMonth()
  const total = daysInMonth(yy, mm)

  const from = dayKey(yy, mm, 1)
  const to = dayKey(yy, mm, total)

  // Day-of-month arithmetic outside 1..total is legal and rolls into the
  // neighbouring month, which is exactly what is wanted here.
  const fetchFrom = keyOf(new Date(yy, mm, 1 - 6))
  const fetchTo = keyOf(new Date(yy, mm, total + 6))

  // The cache and the in-flight guard key on what was REQUESTED, not on the
  // month, or two different spans would collide on one entry.
  return { from, to, fetchFrom, fetchTo, key: `${fetchFrom}|${fetchTo}|${venue}` }
}

/**
 * Seven days starting on the given date — a rolling week, not a calendar one.
 *
 * On request: the Weekly figure answers "how many people do I need between now
 * and next week", so it starts at the anchor day and runs forward. A
 * Monday-to-Sunday week would answer a different question, and on a Friday it
 * would be mostly days that have already happened.
 */
function rollingWeek(date) {
  const d = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
  return { from: date, to: keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6)) }
}

/**
 * A hex colour as a translucent tint.
 *
 * The five venue colours come from Ambria and are the ones it shades its own
 * calendar with — taking them from the feed rather than hardcoding is what
 * makes the two screens look like one product. At full strength they would
 * swallow the date, so they go on at low alpha, which also keeps them working
 * against both the light and the dark surface.
 */
function tint(hex, alpha) {
  const clean = String(hex ?? '').replace('#', '')
  if (clean.length !== 6) return `rgba(127,127,127,${alpha})`
  const n = parseInt(clean, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/**
 * Several bookings split the tile, as they do on Ambria's calendar.
 *
 * Hard stops, not a blend: a gradient that fades between two venues reads as a
 * third colour that means nothing. One booking gets a flat tint.
 *
 * ── PAINTED AS A LAYER, NOT AS THE TILE'S BACKGROUND ──────────────────
 * It used to be an inline `background` on the button itself, and that cannot
 * survive the Daily/Weekly band: the band is a class (bg-brand-soft) and an
 * inline style always beats a class, so a tinted day inside the counted span
 * lost its band entirely — the one place both facts matter at once.
 *
 * As an absolutely-positioned layer the two compose: the band paints the tile,
 * the venue colour sits over it, and the date and count sit over both.
 */
function tileBackground(colours) {
  if (!colours.length) return undefined
  if (colours.length === 1) return tint(colours[0], 0.22)
  const step = 100 / colours.length
  const stops = colours
    .map((c, i) => `${tint(c, 0.22)} ${i * step}% ${(i + 1) * step}%`)
    .join(', ')
  return `linear-gradient(135deg, ${stops})`
}

/**
 * Warm the cache for a month nobody has asked for yet.
 *
 * Stepping a month costs a round trip, and the two months either side of the
 * one on screen are overwhelmingly the ones asked for next. Fetching them while
 * nobody is waiting turns that round trip into a cache hit, which is the whole
 * difference between a calendar that steps and one that loads.
 *
 * It touches NO component state — only the cache. A prefetch is not an event on
 * screen: it must not move a spinner, must not set `fetchedAt`, and above all
 * must not raise an error, because nobody asked for this month and an error
 * about one the user cannot see is noise they cannot act on. A failed prefetch
 * is simply an absent cache entry, and the ordinary load will try again.
 */
async function prefetchRange(from, to, venue) {
  const key = `${from}|${to}|${venue}`
  if (cache.has(key)) return
  try {
    const data = await ambriaFeed({ from, to, property: venue || null, events: false })
    cache.set(key, { data, at: Date.now() })
  } catch {
    // Deliberately silent. See above.
  }
}

/**
 * `event_time` as a 12-hour clock, WITHOUT parsing it into a Date.
 *
 * The field is free text from the CRM, and the real values are not one shape:
 * "9:00 AM", "7:00 PM", "18:00", "7 PM onwards". The brief is explicit that it
 * must not become a Date and must not be sorted on — a "7 PM onwards" through
 * `new Date()` is Invalid Date, and the day's cards would sort into nonsense.
 *
 * So this converts ONE shape and passes everything else through untouched: a
 * string that is nothing but HH:MM. That is the only form a reader cannot
 * already understand at a glance, and the only one where the meaning is
 * unambiguous enough to rewrite. Anything with am/pm already in it, or any
 * extra words at all, is left exactly as the CRM wrote it.
 */
function prettyEventTime(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return '—'

  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value)
  if (!match) return value

  const hour = Number(match[1])
  if (hour > 23) return value

  // 0 and 12 both show as 12 — midnight is 12 AM, noon is 12 PM.
  const shown = hour % 12 === 0 ? 12 : hour % 12
  return `${shown}:${match[2]} ${hour < 12 ? 'AM' : 'PM'}`
}

export default function ValetBookings() {
  const { t, lang } = useI18n()

  const today = istToday()
  const [year, setYear] = useState(() => Number(today.slice(0, 4)))
  const [month, setMonth] = useState(() => Number(today.slice(5, 7)) - 1)
  const [venue, setVenue] = useState('')
  const [selected, setSelected] = useState(() => today)

  const [feed, setFeed] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [fetchedAt, setFetchedAt] = useState(null)
  // WHICH RANGE THE DATA ON SCREEN IS FOR.
  //
  // Without it, stepping to an un-cached month leaves the previous month's feed
  // rendered under the new month's heading. The tiles come out blank, because
  // the dates no longer match anything in it — and a blank calendar does not
  // read as "still loading", it reads as "nothing is booked this month", which
  // is a different and much worse thing to tell a valet team.
  const [shownRange, setShownRange] = useState(null)

  // ── BRINGING THE DAY INTO VIEW ──────────────────────────────────────
  // The day's detail sits below the calendar, which on a desktop screen is
  // below the fold. Tapping a date then looks like it did nothing at all — the
  // detail is right there, off screen.
  //
  // A COUNTER, not a boolean and not an effect on `selected`. The element does
  // not exist yet at the moment of the first click, so the scroll has to happen
  // after the render that creates it. And it must fire again when the SAME date
  // is clicked twice, which a boolean or a `selected` dependency would swallow.
  //
  // It starts at 0 so the initial render — which selects today by itself — does
  // not yank a freshly-opened page down the screen.
  const [jump, setJump] = useState(0)
  const detailRef = useRef(null)

  const { from, to, fetchFrom, fetchTo, key: rangeKey } = monthRange(year, month, venue)

  // ── ONE FETCH AT A TIME ─────────────────────────────────────────────
  // Holds the REQUEST ITSELF, not a boolean, so a caller who cannot be dropped
  // has something to wait on. A ref rather than state because a poll tick has
  // to see the current value the moment it fires, and a state update scheduled
  // for the next render is too late — two overlapping fetches then race and
  // the slower one wins, showing older data than the app already had.
  const inFlight = useRef(null)
  // Guards against a reply from the month the user just navigated away from
  // landing on top of the month they are now looking at.
  const wantedRange = useRef(rangeKey)
  wantedRange.current = rangeKey

  /**
   * What is on screen right now, readable synchronously.
   *
   * `feed` itself cannot be used for this. The poll intervals are created in an
   * effect keyed on the range, so the `load` they call is captured once and its
   * closure holds whatever `feed` was at that moment — minutes stale by the
   * second tick. Reading a ref instead means the events-preserving merge below
   * merges into the CURRENT events rather than resurrecting old ones.
   */
  const feedRef = useRef(null)

  const load = useCallback(
    async ({ quiet = false, force = false } = {}) => {
      // ── WHO MAY BE DROPPED, AND WHO MAY NOT ─────────────────────────
      // A POLL arriving while something is already in the air is dropped. Its
      // answer would be the same one, and letting requests pile up is exactly
      // what the feed's own notes warn against.
      //
      // A MONTH CHANGE is not dropped, and that distinction is a bug fix. The
      // guard used to be a plain boolean and returned early for everybody, so
      // changing month while a poll happened to be in flight did nothing at
      // all: no request went out, `shownRange` never caught up, and the screen
      // sat on its spinner for ever. Somebody is waiting for this one, so it
      // queues behind the current request instead of vanishing.
      if (inFlight.current) {
        if (!force) return
        await inFlight.current.catch(() => {})
      }

      const asked = wantedRange.current
      if (!quiet) setLoading(true)

      const run = (async () => {
        try {
          const data = await ambriaFeed({
            // The WIDER span — see monthRange. A week that straddles the month
            // boundary has to arrive complete or the Weekly total is quietly
            // short.
            from: fetchFrom,
            to: fetchTo,
            property: venue || null,
            events: false,
          })
          // The user moved on while this was in the air. Throw it away.
          if (asked !== wantedRange.current) return

          // REPLACED WHOLESALE, never merged by id. Merging is how a booking
          // deleted in Ambria becomes immortal here: it would never appear in a
          // later response and so would never be removed.
          //
          // There used to be a merge on this line, preserving the events list
          // across a bookings-only poll. Both the poll shapes and the events
          // are gone, so every reply is now simply the answer.
          const at = Date.now()
          feedRef.current = data
          setFeed(data)
          setShownRange(asked)
          setError(null)
          setFetchedAt(at)
          cache.set(asked, { data, at })
        } catch (e) {
          if (asked !== wantedRange.current) return
          const err =
            e instanceof AmbriaFeedError
              ? e
              : new AmbriaFeedError('REQUEST_FAILED', e?.message ?? 'Something went wrong.')
          // A failed BACKGROUND poll must not blank a screen that is already
          // showing good data — the porch reads this while working. It only
          // surfaces when there is nothing to show.
          setError((p) => (quiet && feedRef.current ? p : err))
        } finally {
          if (!quiet) setLoading(false)
        }
      })()

      // Published only now, so a `force` caller awaiting the previous request
      // cannot accidentally await its own.
      inFlight.current = run
      try {
        await run
      } finally {
        // Identity-checked: a later request may already own the slot, and
        // clearing it blindly would let the next poll overlap with it.
        if (inFlight.current === run) inFlight.current = null
      }
    },
    // No `feed` here on purpose — it is read through feedRef instead.
    //
    // With `feed` in this list the callback was rebuilt on every successful
    // fetch, and the two effects below had to suppress the exhaustive-deps
    // rule to keep from re-running each time data arrived. A suppressed lint
    // warning is a claim nobody checks: it also hid the fact that a poll's
    // captured `load` held a stale `feed` and merged into events that were
    // minutes old. Reading the ref fixes the bug and makes the dependency
    // lists honest — `load` now changes exactly when the range does.
    [fetchFrom, fetchTo, venue],
  )

  // ── THE MONTH CHANGED — ONE CALL ────────────────────────────────────
  //
  // This was briefly two: a cheap bookings-only call to paint the calendar,
  // then the expensive one for the CRM events. It was built for a fifteen-
  // second CRM leg, and measurement says that leg is not there — Ambria's
  // lms_feed_cache is live, so the full call comes back in about the same time
  // as the cheap one:
  //
  //     bookings only   2.67s   (paid the cold start)
  //     full            2.16s   (warm isolate)
  //
  // The split therefore cost what it was meant to save. Two sequential calls
  // put everything on screen at ~4.8s; one call does it at ~2.2s. So it is one
  // call again, and the honest reason is written down rather than left as a
  // mystery for whoever wonders why the obvious optimisation is missing.
  //
  // The cost is real but rare: roughly once every ten minutes Ambria's cache
  // expires and the refreshing call pays the full sweep, and on that one call
  // the page waits for it. Trading two seconds off every load for one slow load
  // per ten minutes of use is the right way round.

  useEffect(() => {
    const key = rangeKey
    const hit = cache.get(key)

    // ── SHOW WHAT WE HAD, THEN CHECK ──────────────────────────────────
    // Returning to a month already seen paints instantly. The request still
    // goes out behind it, so a booking deleted in Ambria disappears on the
    // reply — the cache shortens the wait, it does not decide what is true.
    if (hit) {
      feedRef.current = hit.data
      setFeed(hit.data)
      setShownRange(key)
      setFetchedAt(hit.at)
      setError(null)
      setLoading(false)
    }

    let cancelled = false

    ;(async () => {
      // force: somebody is waiting for this month. Without it a poll already
      // in flight would swallow the request and the spinner would never end.
      //
      // Quiet when something is already on screen: a spinner over data that is
      // seconds old is a downgrade, not feedback.
      await load({ quiet: Boolean(hit), force: true })

      // ── THEN WARM THE NEIGHBOURS ────────────────────────────────────
      // After, never before: the month being looked at gets the connection
      // first. Next month leads because forward is the direction people step.
      //
      // One at a time, and abandoned the moment a real fetch starts — a poll
      // or a month change is somebody waiting, and a prefetch is not.
      for (const delta of [1, -1]) {
        if (cancelled || inFlight.current) return
        const near = monthRange(year, month + delta, venue)
        await prefetchRange(near.fetchFrom, near.fetchTo, venue)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [rangeKey, venue, year, month, load])

  // ── POLLING, GATED ON VISIBILITY ────────────────────────────────────
  // An interval alone is not enough: browsers throttle timers in a hidden tab
  // to roughly once a minute and freeze one that has been hidden long enough,
  // so the screen comes back showing data that LOOKS current and is not. The
  // refetch on becoming visible is the part that actually keeps it honest.
  useEffect(() => {
    let timer

    const start = () => {
      clearInterval(timer)
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') load({ quiet: true })
      }, POLL_MS)
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible') {
        clearInterval(timer)
        return
      }
      load({ quiet: true })
      start()
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisible)

    // ── AND ON WINDOW FOCUS ───────────────────────────────────────────
    // visibilitychange fires when a TAB is switched, not when the whole window
    // loses focus — so the actual workflow here missed it entirely: make a
    // booking in Ambria Admin in another window, alt-tab back, and this tab was
    // visible the whole time and had fired nothing. The wait was however much
    // of the interval happened to be left.
    //
    // Refetching on focus makes that switch the trigger. It cannot double up
    // with the visibility handler: load() holds a one-at-a-time lock and drops
    // a poll that arrives while another is in flight.
    window.addEventListener('focus', onVisible)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [rangeKey, venue, load])

  // Runs after the render that created the detail, which is the only time the
  // element is there to scroll to.
  useEffect(() => {
    if (!jump) return
    // Honour the OS setting. Smooth scrolling is motion, and for somebody who
    // has asked the system to stop animating things it is the kind of movement
    // that causes real discomfort.
    // NARROW SCREENS ONLY. From xl up the day panel sits BESIDE the calendar
    // and is already in view — scrolling there would yank the page for no
    // reason, which is worse than not scrolling at all. The 1280px breakpoint
    // is Tailwind's `xl`, the same one the two-column grid switches on.
    if (window.matchMedia?.('(min-width: 1280px)')?.matches) return

    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    detailRef.current?.scrollIntoView({
      behavior: still ? 'auto' : 'smooth',
      block: 'start',
    })
  }, [jump])

  // ── DERIVED ─────────────────────────────────────────────────────────
  const properties = feed?.properties ?? []

  /** code -> the whole venue, because the name and the colour travel together. */
  const venueOf = useMemo(() => {
    const map = new Map()
    for (const p of properties) map.set(p.code, p)
    return map
  }, [properties])

  /** date -> that day's bookings. */
  const byDay = useMemo(() => {
    const bookings = new Map()
    for (const b of feed?.bookings ?? []) {
      if (!bookings.has(b.event_date)) bookings.set(b.event_date, [])
      bookings.get(b.event_date).push(b)
    }
    return { bookings }
  }, [feed])

  /**
   * WHICH DAYS THE TILES COUNT.
   *
   * Day, week or month, anchored on the selected date. A staffing figure is
   * useless without knowing what span it covers — "18 staff" means one thing
   * for a Saturday and another for September — so the span is also printed
   * beside the switch rather than left to be inferred from which button looks
   * pressed.
   *
   * WEEKLY BY DEFAULT, on request. The month was the first default because it
   * matches the grid, but that is a property of the layout rather than of the
   * question being asked: nobody staffs September, they staff the next few
   * days. The rolling week from today is the answer somebody opening this
   * screen actually wants, and the band shows them which days it covers.
   *
   * One consequence worth knowing: on Weekly and Daily a month step KEEPS the
   * selected day (see goToMonth), so the default is also the mode in which
   * stepping does not reset the span.
   */
  const [period, setPeriod] = useState('week')

  /**
   * The day Daily and Weekly hang off.
   *
   * `selected` is cleared when the month changes on Monthly, so it cannot be
   * relied on: without a fallback the numbers would blank. Today if this is
   * today's month, otherwise the 1st — the same day the reader would pick.
   */
  const anchor = selected ?? (today >= from && today <= to ? today : from)

  const scope = useMemo(() => {
    if (period === 'day') return { from: anchor, to: anchor }
    // The anchor, so the week follows whatever date was clicked — in this month
    // or any other — and starts at today until one is.
    if (period === 'week') return rollingWeek(anchor)
    return { from, to }
  }, [period, anchor, from, to])

  /**
   * Is this date inside the counted span?
   *
   * Every period, Monthly included: the band means "these are the days the
   * tiles above are counting", and on Monthly that is the whole month.
   *
   * A band covering every tile loses its contrast, which is why hover and the
   * selected day are handled separately below rather than by shade alone.
   */
  const inScope = (date) => date >= scope.from && date <= scope.to

  /**
   * The chosen span in three numbers.
   *
   * THERE IS NO "PENDING" OR "CONFIRMED" HERE, and there cannot be. A booking
   * in this feed carries no status field — id, venue, date, time, customer,
   * guests, staffing, heavy_date, notes and nothing else. A booking exists or
   * it does not. Two tiles splitting that count into states the data does not
   * record would be numbers this screen invented, and a valet team would staff
   * a night against them.
   *
   * STAFF is summed from Ambria's snapshots and never recomputed — an admin can
   * override one booking's staffing by hand, and re-deriving it from guest
   * counts would quietly disagree with the number they decided on.
   *
   * FILTERED BY DATE, not taken from the whole response. The fetch reaches a
   * week either side of the month, so summing everything it returned would make
   * the Monthly total wrong.
   */
  const totals = useMemo(() => {
    const list = (feed?.bookings ?? []).filter(
      (b) => b.event_date >= scope.from && b.event_date <= scope.to,
    )
    const codes = new Set(list.map((b) => b.property))
    return {
      bookings: list.length,
      venueCodes: codes,
      venues: codes.size,
      staff: list.reduce((sum, b) => sum + Number(b.staff_total ?? 0), 0),
    }
  }, [feed, scope])

  /**
   * The booked venues, in Ambria's own order.
   *
   * Filtering `properties` rather than mapping the bookings dedupes AND fixes
   * the order, so the names under the tile match the legend by the calendar.
   */
  const bookedVenues = useMemo(
    () => properties.filter((p) => totals.venueCodes.has(p.code)),
    [properties, totals],
  )

  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN' : 'en-GB', {
        month: 'long',
        year: 'numeric',
      }).format(new Date(year, month, 1)),
    [lang, year, month],
  )

  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN' : 'en-GB', { weekday: 'short' })
    // 2024-01-01 was a Monday, which is where this grid starts.
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)))
  }, [lang])

  /** The span in words, so the numbers above cannot be misread. */
  const scopeLabel = useMemo(() => {
    const fmt = (d, opts) =>
      new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN' : 'en-GB', opts).format(
        new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))),
      )
    if (scope.from === scope.to) {
      return fmt(scope.from, { weekday: 'long', day: 'numeric', month: 'long' })
    }
    // The month is dropped from the left half only when both ends share it —
    // "1 – 7 September" reads better, and "31 August – 6 September" has to keep
    // both or it says the wrong thing.
    const sameMonth = scope.from.slice(0, 7) === scope.to.slice(0, 7)
    return `${fmt(scope.from, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })} – ${fmt(
      scope.to,
      { day: 'numeric', month: 'long' },
    )}`
  }, [scope, lang])

  /**
   * The one way the calendar moves to a month, whether by arrow or by picker.
   *
   * ── THE SPAN SURVIVES A MONTH CHANGE, ON DAILY AND WEEKLY ─────────
   * A week anchored on the 30th of September runs into October, and the obvious
   * way to see the rest is to move to October. Clearing the selection there
   * would move the anchor to the 1st and the band would jump to a different
   * week — losing the thing the reader moved forward for.
   *
   * On Monthly it still clears: nothing is banded, the day panel is about one
   * day, and a day from the month you just left is not the answer to "what is
   * on this month".
   */
  const goToMonth = (y, m) => {
    const next = new Date(y, m, 1)
    setYear(next.getFullYear())
    setMonth(next.getMonth())
    if (period === 'month') setSelected(null)
  }

  const step = (delta) => goToMonth(year, month + delta)

  const goToday = () => {
    setYear(Number(today.slice(0, 4)))
    setMonth(Number(today.slice(5, 7)) - 1)
    setSelected(today)
    setJump((n) => n + 1)
  }

  // ── RENDER ──────────────────────────────────────────────────────────
  if (loading && !feed) return <PageSpinner label={t('bookings.loading')} />

  const header = (
    <Header
      t={t}
      monthLabel={monthLabel}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
      onPick={goToMonth}
      year={year}
      month={month}
      lang={lang}
      onToday={goToday}
      properties={properties}
      venue={venue}
      setVenue={setVenue}
      fetchedAt={fetchedAt}
    />
  )

  if (error && !feed) {
    return (
      <>
        {header}
        <EmptyState
          variant="error"
          icon="alert"
          title={error.isSetup ? t('bookings.setupNeeded') : t('bookings.failed')}
          description={error.message}
          // No Retry against a missing secret: the button cannot work until
          // somebody opens the dashboard, and offering it sends whoever is
          // looking round the same loop instead of to the fix.
          action={
            error.isSetup ? null : (
              <Button variant="secondary" icon="refresh" onClick={() => load({})}>
                {t('bookings.retry')}
              </Button>
            )
          }
        />
      </>
    )
  }

  // The month heading has already changed; the data has not caught up.
  const stale = shownRange !== rangeKey

  // Once per render, not once per tile.
  const lead = firstWeekday(year, month)
  const days = daysInMonth(year, month)
  const tail = (7 - ((lead + days) % 7)) % 7

  return (
    <>
      {header}

      {/* A background poll failed while good data is on screen. Said quietly,
          because the numbers below are still the ones Ambria last gave us. */}
      {error && feed && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-soft px-4 py-2.5 text-sm text-ink">
          <Icon name="alert" className="mt-0.5 shrink-0 text-warning" size={16} />
          <span>{error.message}</span>
        </div>
      )}

      {/* ── THE SWITCH, AND WHAT IT SELECTED ──────────────────────────
          A segmented control, not three buttons: the three are mutually
          exclusive and one is always on, which is what a segmented control
          means and what a row of buttons does not.

          The span is printed beside it because a staffing number is meaningless
          without one. "18 staff" is a different instruction for a Saturday than
          for September. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          role="group"
          aria-label={t('bookings.period')}
          className="inline-flex items-center rounded-xl border border-line-strong bg-surface p-1"
        >
          {[
            ['day', 'bookings.periodDay'],
            ['week', 'bookings.periodWeek'],
            ['month', 'bookings.periodMonth'],
          ].map(([value, key]) => (
            <button
              key={value}
              type="button"
              onClick={() => setPeriod(value)}
              aria-pressed={period === value}
              className={[
                'rounded-lg px-3 py-1.5 text-xs font-bold transition-colors',
                period === value
                  ? 'bg-brand text-ink-inverse'
                  : 'text-ink-muted hover:bg-brand-soft hover:text-ink',
              ].join(' ')}
            >
              {t(key)}
            </button>
          ))}
        </div>
        <span className="text-sm font-semibold text-ink-muted">{scopeLabel}</span>
      </div>

      <StatRow className="mb-4">
        <StatTile
          icon="calendar"
          label={t('bookings.statBookings')}
          value={totals.bookings}
          loading={stale}
        />
        <StatTile
          icon="building"
          label={t('bookings.statVenues')}
          value={totals.venues}
          tone="info"
          loading={stale}
          // Each name carries its calendar colour, so the tile and the grid
          // are read with the same key. Nothing while a month loads — a stale
          // list of names under a skeleton number is a small lie.
          hint={
            !stale && bookedVenues.length > 0 ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {bookedVenues.map((p) => (
                  <span key={p.code} className="inline-flex items-center gap-1">
                    <span
                      aria-hidden
                      style={{ background: p.color }}
                      className="h-1.5 w-1.5 rounded-full ring-1 ring-inset ring-black/10"
                    />
                    {p.name}
                  </span>
                ))}
              </span>
            ) : null
          }
        />
        <StatTile
          icon="users"
          label={t('bookings.statStaff')}
          value={totals.staff}
          tone="success"
          loading={stale}
        />
      </StatRow>

      {/* ── WHAT THE COLOURS MEAN ─────────────────────────────────────
          A colour-coded calendar without a key is a puzzle. The hover title on
          each dot names its venue, but hover does not exist on the phone this
          is mostly read on, and a colour nobody can decode is decoration.

          ABOVE BOTH COLUMNS, not inside the left one. Inside the column it
          pushed only the calendar down, so the day panel beside it began a
          legend-height higher and the two never lined up. A spacer above the
          panel would have matched them only until somebody changed the legend;
          one row above both cannot drift out of step. */}
      {properties.length > 1 && (
        // A 3-COLUMN GRID WHILE IT HAS TO WRAP, a plain row once it fits.
        //
        // As a wrapping flex row the break point followed each name's width, so
        // the second line started wherever the first happened to run out —
        // Janakpuri sat under Exotica by a few pixels rather than under it. A
        // grid gives the five names fixed columns, so what is on the second row
        // lines up with what is on the first.
        //
        // Three columns, not five: five would leave a lone name stranded on the
        // second row of a six-venue property. And the count is never hardcoded
        // — from `sm` up it becomes a flex row and takes however many venues
        // the feed sends, which is the array the brief says to trust.
        <div className="mb-2 grid grid-cols-3 items-center gap-x-4 gap-y-2 sm:flex sm:flex-wrap">
          {properties.map((p) => {
            const isFiltered = venue === p.code
            return (
              <button
                key={p.code}
                type="button"
                // The legend doubles as the filter. It is already a row of venue
                // names beside the control that filters by venue; making it
                // inert would be the surprising choice.
                onClick={() => setVenue(isFiltered ? '' : p.code)}
                className={[
                  // justify-self-start: a grid child fills its column by
                  // default, which would stretch the pill's tinted background
                  // across the whole column when it is the filtered one.
                  'inline-flex items-center justify-self-start gap-1.5 rounded-full px-2 py-1 text-xs font-semibold transition-colors',
                  isFiltered ? 'bg-brand-soft text-ink' : 'text-ink-muted hover:text-ink',
                ].join(' ')}
                aria-pressed={isFiltered}
              >
                <span
                  style={{ background: p.color }}
                  className="h-2.5 w-2.5 rounded-full ring-1 ring-inset ring-black/10"
                />
                {p.name}
              </button>
            )
          })}
        </div>
      )}

      {/* ── CALENDAR AND THE DAY, SIDE BY SIDE ────────────────────────
          items-start so the sidebar keeps its own height instead of stretching
          to match a six-row calendar. Below xl they stack, calendar first,
          which is the same reading order. */}
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem] xl:items-start">
        <div className="min-w-0">
          {/* ── THE GRID IS ALWAYS THE GRID ────────────────────────────
              While a month loads the tiles show a placeholder rather than the
              whole calendar being swapped for a spinner card. The tiles must
              not show the PREVIOUS month's data — the dates would not match,
              every tile would come out empty, and an empty calendar does not
              read as "loading", it reads as "nothing is booked this month". And
              a spinner card is a different height from six rows of tiles, so
              the page jumped every time a month landed. */}
          <Card padded={false}>
            <div className="grid grid-cols-7 border-b border-line bg-brand-soft/40 text-center text-[0.6rem] font-bold uppercase tracking-[0.08em] text-ink-subtle">
              {weekdays.map((d) => (
                <div key={d} className="px-1 py-3">
                  {d}
                </div>
              ))}
            </div>
            <div
              className="grid grid-cols-7"
              aria-busy={stale || undefined}
              aria-label={stale ? t('bookings.loading') : undefined}
            >
              {/* Blanks before the 1st, so dates sit under the right weekday. */}
              {Array.from({ length: lead }, (_, i) => (
                <div
                  key={`pad-${i}`}
                  className="min-h-24 border-b border-r border-line/60 bg-brand-soft/20 sm:min-h-28"
                />
              ))}

              {Array.from({ length: days }, (_, i) => {
                const date = dayKey(year, month, i + 1)

                if (stale) {
                  return (
                    <div
                      key={date}
                      className="flex min-h-24 items-center justify-center border-b border-r border-line/60 p-2 sm:min-h-28"
                    >
                      <span className="block h-6 w-6 animate-pulse rounded bg-brand-soft" />
                    </div>
                  )
                }

                const dayBookings = byDay.bookings.get(date) ?? []
                const colours = dayBookings
                  .map((b) => venueOf.get(b.property)?.color)
                  .filter(Boolean)
                const isToday = date === today
                const isSelected = date === selected
                const counted = inScope(date)
                // WHICH DAY GETS THE RING.
                //
                // On Daily and Weekly it is the start of the span — not always
                // `selected`, because after a month step nothing is selected and
                // the span falls back to the 1st, which still has to look like
                // where it begins.
                //
                // On Monthly the span starts at the 1st and covers everything,
                // so ringing its first day would mark a date nobody chose. There
                // the ring follows the click, the only selection that exists.
                const ringed = period === 'month' ? isSelected : counted && date === scope.from
                const n = dayBookings.length

                return (
                  <button
                    key={date}
                    type="button"
                    onClick={() => {
                      setSelected(date)
                      setJump((n2) => n2 + 1)
                    }}
                    className={[
                      'relative flex min-h-24 flex-col items-center justify-center gap-1.5 border-b border-r border-line/60 p-2 text-center sm:min-h-28',
                      'transition-colors',
                      'focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand',
                      // Hover as a RING on a banded tile: there is no darker
                      // shade of brand-soft to move to, and a whole month of
                      // banded tiles would otherwise give no feedback under the
                      // cursor.
                      counted
                        ? 'bg-brand-soft hover:ring-1 hover:ring-inset hover:ring-brand/40'
                        : 'hover:bg-brand-soft/50',
                      ringed ? 'z-10 ring-2 ring-inset ring-brand' : '',
                    ].join(' ')}
                    aria-current={isToday ? 'date' : undefined}
                    aria-pressed={counted}
                  >
                    {/* THE VENUE SHADING. Every dot has a matching band of
                        colour behind it, so a day's venues are readable from
                        across the room rather than by finding two 10px dots.

                        pointer-events-none: it covers the whole tile, and
                        without this it would swallow the click. */}
                    {colours.length > 0 && (
                      <span
                        aria-hidden
                        style={{ background: tileBackground(colours) }}
                        className="pointer-events-none absolute inset-0"
                      />
                    )}

                    {/* THE PILL IS TAKEN OUT OF THE FLOW.
                        It shared a row with the date and pushed it off centre, so
                        today's number sat somewhere no other number did — on the
                        one tile a reader looks for first. */}
                    {isToday && (
                      <span className="absolute right-1.5 top-1.5 z-10 rounded-full bg-brand px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-wider text-white">
                        {t('bookings.todayPill')}
                      </span>
                    )}

                    <span
                      className={[
                        'relative text-base tabular-nums sm:text-lg',
                        // Bold ink on all 31 dates competes with the counts that
                        // actually say something. Today is the one that earns it.
                        isToday ? 'font-bold text-brand' : 'font-semibold text-ink-muted',
                      ].join(' ')}
                    >
                      {i + 1}
                    </span>

                    {/* ONE DOT PER BOOKING, then the count in words.
                        THE CALENDAR SHOWS BOOKINGS ONLY — an orange count of
                        unbooked CRM events used to sit in the corner of every
                        tile and came off on request. The grid answers one
                        question, which days are booked, and a second marker in a
                        second colour made it answer two at once. The events still
                        live in the day panel, where there is room to say what
                        they are.

                        Every dot is one booking. There used to be an extra dot
                        in front of the words carrying the FIRST booking's colour,
                        which on a two-venue day read as a claim it was never
                        making. */}
                    {n > 0 && (
                      <span className="relative flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1">
                        <span className="flex shrink-0 items-center gap-1">
                          {dayBookings.map((b) => (
                            <span
                              key={b.id}
                              title={b.property_name ?? b.property}
                              style={{ background: venueOf.get(b.property)?.color }}
                              className="h-2.5 w-2.5 rounded-full ring-1 ring-inset ring-black/10"
                            />
                          ))}
                        </span>
                        <span className="text-xs font-semibold leading-snug text-ink">
                          {n === 1 ? t('bookings.oneBooking') : t('bookings.nBookings', { n })}
                        </span>
                      </span>
                    )}
                  </button>
                )
              })}

              {/* Closing blanks. Without them the last week ends mid-row and the
                  card's bottom border runs under nothing — the grid reads as
                  unfinished rather than as a month that ended on a Wednesday. */}
              {Array.from({ length: tail }, (_, i) => (
                <div
                  key={`tail-${i}`}
                  className="min-h-24 border-b border-r border-line/60 bg-brand-soft/20 sm:min-h-28"
                />
              ))}
            </div>
          </Card>
        </div>

        {/* ── THE DAY, AS A SIDEBAR ─────────────────────────────────── */}
        <div ref={detailRef} className="min-w-0 scroll-mt-4">
          {stale ? null : selected ? (
            <DayPanel
              t={t}
              date={selected}
              lang={lang}
              bookings={byDay.bookings.get(selected) ?? []}
              venueOf={venueOf}
            />
          ) : (
            <EmptyState icon="calendar" title={t('bookings.pickADay')} compact />
          )}
        </div>
      </div>
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// HEADER — venue filter, month stepper, and the read-only label
// ═══════════════════════════════════════════════════════════════════════
function Header({
  t,
  monthLabel,
  onPrev,
  onNext,
  onPick,
  year,
  month,
  lang,
  onToday,
  properties,
  venue,
  setVenue,
  fetchedAt,
}) {
  return (
    <PageHeader
      title={t('bookings.title')}
      // ── METADATA BELONGS UNDER THE TITLE, NOT IN THE ACTIONS ──────────
      // "Read only" and the sync time are not controls: one is a standing fact
      // about the whole screen, the other a status. Putting them in the action
      // row gave it five items of four different heights.
      subtitle={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5 font-semibold text-ink-muted">
            <span aria-hidden className="h-2 w-2 rounded-full bg-success" />
            {t('bookings.readOnly')}
          </span>
          <span aria-hidden className="text-line-strong">
            |
          </span>
          <span>{t('bookings.subtitle')}</span>
          {fetchedAt && (
            <span className="tabular-nums">
              · {t('bookings.synced', { time: formatTime(fetchedAt) })}
            </span>
          )}
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {properties.length > 0 && (
            <div className="relative">
              <Icon
                name="building"
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
              />
              <select
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                className="h-10 appearance-none rounded-xl border border-line-strong bg-surface pl-9 pr-10 text-sm font-semibold text-ink"
                aria-label={t('bookings.venue')}
              >
                <option value="">{t('bookings.allVenues')}</option>
                {properties.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Icon
                name="chevron-down"
                size={16}
                className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-subtle"
              />
            </div>
          )}

          <div className="flex h-10 items-center rounded-xl border border-line-strong bg-surface px-1">
            <button
              type="button"
              onClick={onPrev}
              className="rounded-lg p-1.5 text-ink-muted hover:bg-brand-soft hover:text-ink"
              aria-label={t('bookings.prevMonth')}
            >
              <Icon name="arrow-left" size={16} />
            </button>
            <MonthPicker
              t={t}
              lang={lang}
              year={year}
              month={month}
              monthLabel={monthLabel}
              onPick={onPick}
            />
            <button
              type="button"
              onClick={onNext}
              className="rounded-lg p-1.5 text-ink-muted hover:bg-brand-soft hover:text-ink"
              aria-label={t('bookings.nextMonth')}
            >
              <Icon name="arrow-right" size={16} />
            </button>
          </div>

          {/* ALWAYS PRESENT, on request. A control that comes and goes moves
              everything beside it, and even on today's month it reselects today
              and brings the day panel back to it. Filled, because it is the one
              action on this screen rather than another bordered box. */}
          <button
            type="button"
            onClick={onToday}
            className="h-10 shrink-0 rounded-xl bg-brand px-4 text-sm font-bold text-ink-inverse hover:opacity-90"
          >
            {t('bookings.today')}
          </button>
        </div>
      }
    />
  )
}

/**
 * The month label, as a picker.
 *
 * The arrows either side of it remain, and that is deliberate: stepping to the
 * next month is one tap and by far the commonest move, while jumping to
 * February is two. Replacing the arrows with the picker would have made the
 * common case slower to make the rare case possible.
 *
 * ── THE YEAR IS BROWSED, NOT COMMITTED ──────────────────────────────
 * `shownYear` is local to the open panel. Stepping the year has to be able to
 * show 2027's months without moving the calendar to 2027 — otherwise every tap
 * of the year arrow fires a fetch for a month nobody asked to see, and passing
 * through 2029 on the way to 2030 would load four months on the way. It is
 * reset from the real year each time the panel opens, so it never drifts.
 */
function MonthPicker({ t, lang, year, month, monthLabel, onPick }) {
  const [open, setOpen] = useState(false)
  const [shownYear, setShownYear] = useState(year)
  const boxRef = useRef(null)
  const triggerRef = useRef(null)

  const months = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN' : 'en-GB', { month: 'short' })
    // Day 1 of each month of a leap year — safe for every month length.
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2024, i, 1)))
  }, [lang])

  // ── CLOSING IT ──────────────────────────────────────────────────────
  // Both routes, because a popover that closes only one way is a trap: a
  // pointer down anywhere outside, and Escape for the keyboard. `pointerdown`
  // rather than `click` so it closes on press instead of waiting for a release
  // that may land somewhere else entirely.
  useEffect(() => {
    if (!open) return

    const onOutside = (e) => {
      if (!boxRef.current?.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      // Focus goes back where it came from, or the next Tab starts from the top
      // of the document.
      triggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', onOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span ref={boxRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          // Reset on OPEN, not on close: the panel should always start on the
          // year being looked at, however far the last visit browsed.
          setShownYear(year)
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        aria-haspopup="true"
        className="flex min-w-36 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-bold text-ink hover:bg-brand-soft"
      >
        <Icon name="calendar" size={14} className="text-ink-subtle" />
        {monthLabel}
        <Icon
          name="chevron-down"
          size={14}
          className={['text-ink-subtle transition-transform', open ? 'rotate-180' : ''].join(' ')}
        />
      </button>

      {open && (
        <div
          // z-20 clears the calendar tiles, which take z-10 when banded or
          // focused — without it the panel opens behind the first week.
          className="absolute left-1/2 top-full z-20 mt-2 w-64 -translate-x-1/2 rounded-2xl border border-line-strong bg-surface p-3 shadow-raised"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShownYear((y) => y - 1)}
              className="rounded-lg p-1.5 text-ink-muted hover:bg-brand-soft hover:text-ink"
              aria-label={t('bookings.prevYear')}
            >
              <Icon name="arrow-left" size={15} />
            </button>
            <span className="text-sm font-bold tabular-nums text-ink">{shownYear}</span>
            <button
              type="button"
              onClick={() => setShownYear((y) => y + 1)}
              className="rounded-lg p-1.5 text-ink-muted hover:bg-brand-soft hover:text-ink"
              aria-label={t('bookings.nextYear')}
            >
              <Icon name="arrow-right" size={15} />
            </button>
          </div>

          <div className="grid grid-cols-4 gap-1">
            {months.map((label, i) => {
              const isCurrent = shownYear === year && i === month
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    onPick(shownYear, i)
                    setOpen(false)
                  }}
                  aria-pressed={isCurrent}
                  className={[
                    'rounded-lg px-1 py-2 text-xs font-bold transition-colors',
                    isCurrent
                      ? 'bg-brand text-ink-inverse'
                      : 'text-ink-muted hover:bg-brand-soft hover:text-ink',
                  ].join(' ')}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </span>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// THE DAY PANEL
//
// A narrow column, so everything stacks. The horizontal booking row this
// replaces — time, venue, customer, guests and badges across one line — cannot
// survive 22rem, and shrinking it to fit is how a name ends up as "Vikram B…".
// ═══════════════════════════════════════════════════════════════════════
function DayPanel({ t, date, lang, bookings, venueOf }) {
  const heading = useMemo(
    () =>
      new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN' : 'en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(
        new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))),
      ),
    [lang, date],
  )

  // SUMMED, never recomputed — Ambria's snapshots, and an admin may have
  // overridden one of them by hand.
  const dayStaff = bookings.reduce((sum, b) => sum + Number(b.staff_total ?? 0), 0)
  const dayGuests = bookings.reduce((sum, b) => sum + Number(b.guests ?? 0), 0)
  const nothingAtAll = bookings.length === 0

  const venues = new Set(bookings.map((b) => b.property)).size

  /**
   * THE TOTALS ONLY EARN THEIR PLACE WHEN THERE IS SOMETHING TO TOTAL.
   *
   * On a day with one booking they were a restatement of the row directly
   * beneath them — 80 guests, 4 staff and 1 venue, sitting ten pixels above a
   * row reading 80, 4 staff and Restro. Three chips saying what the row already
   * said is not a summary, it is the same sentence twice, and it pushed the
   * actual booking down the panel to make room.
   *
   * From two bookings up they are doing arithmetic the reader would otherwise
   * do by eye, which is the whole point of a summary.
   */
  const showTotals = bookings.length > 1

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-4">
        {/* NOT UPPERCASE. The shape of "Sunday" is what the eye recognises, and
            capitals throw that shape away — the same reason the heading in the
            old two-column panel stopped being a SectionHeading. */}
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-bold text-ink">
          <Icon name="calendar" size={15} className="shrink-0 text-ink-subtle" />
          <span className="truncate">{heading}</span>
        </h2>
        {bookings.length > 0 && (
          <Badge tone="neutral" size="sm">
            {bookings.length === 1
              ? t('bookings.oneBooking')
              : t('bookings.nBookings', { n: bookings.length })}
          </Badge>
        )}
      </div>

      <div className="space-y-3 p-4">
        {nothingAtAll ? (
          <EmptyState icon="inbox" title={t('bookings.nothingOnDay')} compact />
        ) : (
          <>
            {showTotals && (
              <div className="grid grid-cols-3 items-stretch gap-2">
                <DayStat icon="users" value={dayGuests} label={t('bookings.totalGuests')} />
                <DayStat icon="user" value={dayStaff} label={t('bookings.statStaff')} />
                <DayStat
                  icon="building"
                  value={venues}
                  // "1 VENUES" was simply wrong, and a stat label is exactly
                  // where a reader notices it.
                  label={venues === 1 ? t('bookings.oneVenueLabel') : t('bookings.statVenues')}
                />
              </div>
            )}

            {/* NO SECTION HEADING. There is one section left in this panel now
                that the events list has gone, and its count is already on the
                pill beside the date — "VALET BOOKING (1)" under a header
                reading "1 valet booking" was the count printed twice, a
                centimetre apart. */}
            <div className="space-y-2">
              {bookings.map((b) => (
                <BookingRow key={b.id} t={t} booking={b} venue={venueOf.get(b.property)} />
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

function DayStat({ icon, value, label }) {
  return (
    // h-full so the tile fills whatever height the grid row settles on. Without
    // it a tile with a one-line label is shorter than its neighbours, and the
    // row's own stretching is what was making one of the three stand proud.
    <div className="flex h-full flex-col items-center rounded-xl border border-line bg-surface px-2 py-2.5 text-center">
      <Icon name={icon} size={14} className="text-ink-subtle" />
      <p className="mt-1 text-lg font-extrabold leading-none tracking-tight tabular-nums text-ink">
        {value}
      </p>
      {/* TWO LINES' WORTH OF SPACE, ALWAYS.
          "Total guests" fits on one line and "Valet staff needed" does not, so
          the wrapping label made its own tile taller and pushed the numbers out
          of line with each other. Reserving the same block on every tile keeps
          the three numbers on one baseline whatever the label says — including
          in Hindi, where these words are longer and the wrap point differs. */}
      <p className="mt-1 flex min-h-[2.2em] items-start justify-center text-[0.6rem] font-semibold uppercase leading-tight tracking-wide text-ink-subtle">
        {label}
      </p>
    </div>
  )
}

/** One booking, stacked for a narrow column. */
function BookingRow({ t, booking, venue }) {
  // FILTERED TO count > 0. Roles a venue does not use come through as zero, and
  // "Guard: 0, Rider: 0" looks like a mistake rather than an absence.
  // staff_breakdown is also null on older bookings — then the total is still
  // right and the chips are simply skipped.
  const roles = (booking.staff_breakdown ?? []).filter((r) => Number(r.count) > 0)

  return (
    <div
      // The venue's OWN colour as the left rail, inline rather than through
      // Card's `accent`, which only knows the app's named tones. These come from
      // the feed and are what Ambria shades its calendar with, so the two
      // screens read as one product.
      style={venue?.color ? { borderLeftColor: venue.color } : undefined}
      className={[
        'rounded-xl border border-line bg-surface p-3',
        venue?.color ? 'border-l-[3px]' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <Meta icon="clock" label={t('bookings.time')} value={prettyEventTime(booking.event_time)} />
        {/* Genuinely 0 for some events, and shown as 0. Ambria shows 0 too, and
            the two apps disagreeing about the same event is the confusing
            outcome — so no hiding and no substituting. */}
        <Meta icon="users" label={t('bookings.guests')} value={String(booking.guests ?? 0)} />
      </div>

      <span className="mt-2 flex min-w-0 items-center gap-1.5">
        {venue?.color && (
          <span
            style={{ background: venue.color }}
            className="h-2 w-2 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
          />
        )}
        <span className="truncate text-xs font-semibold text-ink-muted">
          {booking.property_name ?? venue?.name ?? booking.property}
        </span>
      </span>

      <p className="mt-0.5 truncate text-sm font-bold tracking-tight text-ink">
        {booking.customer_name}
      </p>

      {/* ── THE STAFFING, AS ONE LINE ─────────────────────────────────
          There were three badges here and one of them was the sum of the other
          two: "4 staff", "Key Man · 1", "Driver · 3". Three chips of equal
          weight for one fact and its own breakdown, and at that size a row of
          five chips stops being readable as anything.

          Now the total is the badge — it is the number somebody acts on, and
          the only one that survives when staff_breakdown is null on an older
          booking — and the roles are plain muted text behind it. Same
          information, one focal point. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line pt-2">
        <Badge tone="info" size="sm" icon="users">
          {t('bookings.nStaff', { n: booking.staff_total ?? 0 })}
        </Badge>
        {roles.length > 0 && (
          <span className="min-w-0 text-xs text-ink-muted">
            {roles.map((r) => `${r.role} ${r.count}`).join(' · ')}
          </span>
        )}
        {booking.heavy_date && (
          // A LABEL, not a multiplier. The staffing snapshot already includes
          // the extra drivers this flag adds; applying it again would
          // double-count them.
          <Badge tone="warning" size="sm" icon="trend" className="ml-auto">
            {t('bookings.heavyDate')}
          </Badge>
        )}
      </div>

      {booking.notes && <p className="mt-2 text-xs text-ink-muted">{booking.notes}</p>}
    </div>
  )
}

/**
 * One fact, icon-led.
 *
 * The label is there for a screen reader and gone for everybody else: an
 * uppercase "TIME" above "6:00 PM" doubles the height of the row to say
 * something a clock icon already says.
 */
function Meta({ icon, label, value }) {
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1.5">
      <Icon name={icon} size={14} className="shrink-0 text-ink-subtle" />
      <span className="sr-only">{label}: </span>
      <span className="truncate text-sm font-semibold tabular-nums text-ink">{value}</span>
    </span>
  )
}
