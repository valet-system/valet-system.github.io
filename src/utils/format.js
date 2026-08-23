/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/utils/format.js                                           │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Every conversion between what the DATABASE stores and what a       │
 * │   HUMAN reads. Phones, car numbers, dates, times, durations.         │
 * │                                                                     │
 * │ WHY IT EXISTS — the two rules it enforces                             │
 * │                                                                     │
 * │   RULE 1: phones are stored as 10 bare digits, never with '91'.      │
 * │   Spec rule 11. The '91' is added only when handing a number to      │
 * │   WhatsApp, by toWhatsAppNumber(). If a '91' ever leaks into the DB  │
 * │   you get two rows for the same guest and a 12-digit number in a     │
 * │   column that other rows have 10 digits in — every lookup by phone   │
 * │   then silently misses.                                              │
 * │                                                                     │
 * │   RULE 2: the database is UTC, every date a human sees is IST.       │
 * │   istToday() below must return the SAME value as the SQL function    │
 * │   public.ist_today(). If they disagree, the operator's "Today's      │
 * │   cars" list and the server's service_date filter disagree, and      │
 * │   cars vanish from the list between 00:00 and 05:30 IST.             │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   operator/CheckIn (phone + car number), every list that shows a     │
 * │   time, useTimer (countdown), admin/Reviews (masked phone + CSV).    │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/types (PHONE_REGEX, COUNTRY_CODE, TIMEZONE),                   │
 * │   src/i18n/activeLang — the relative-time phrases ("5 min ago") are  │
 * │   the only translated text in here. It reads the language from a     │
 * │   plain module rather than a hook because this file is called from   │
 * │   inside JSX expressions, not from component bodies.                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { getActiveLang, pickLang } from '@/i18n/activeLang'
import { COUNTRY_CODE, PHONE_LENGTH, PHONE_REGEX, TIMEZONE } from '@/types'

// ═══════════════════════════════════════════════════════════════════
// PHONE
// ═══════════════════════════════════════════════════════════════════

/**
 * Cleans anything a human might type OR PASTE into the 10 digits we store.
 *
 * This is the single limiter on every phone input in the app — none of them
 * carry a maxLength, because maxLength counts raw characters and the browser
 * truncates a pasted "+91 98765 43210" to "+91 98765" BEFORE any handler runs.
 * See the note in pages/Login.jsx.
 *
 * Handles, in order:
 *   "+91 98765 43210"   -> 9876543210   (country code + spaces)
 *   "+91-98765-43210"   -> 9876543210   (dashes)
 *   "0091 9876543210"   -> 9876543210   (00 international prefix)
 *   "098765 43210"      -> 9876543210   (leading 0, landline habit)
 *   "(+91) 9876543210"  -> 9876543210   (brackets)
 *   "9876543210"        -> 9876543210
 */
export function normalisePhone(input) {
  if (input == null) return ''
  let digits = String(input).replace(/\D/g, '')

  // "00" + country code, as written on business cards.
  if (digits.length === 14 && digits.startsWith(`00${COUNTRY_CODE}`)) digits = digits.slice(4)
  // Country code with a leading 0 after it — seen in pasted contact exports.
  if (digits.length === 13 && digits.startsWith(`${COUNTRY_CODE}0`)) digits = digits.slice(3)
  // Plain country code.
  if (digits.length === 12 && digits.startsWith(COUNTRY_CODE)) digits = digits.slice(2)
  // Leading 0, from landline habit.
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)

  return digits.slice(0, PHONE_LENGTH)
}

/** Indian mobile: exactly 10 digits, first digit 6-9. */
export function isValidPhone(input) {
  return PHONE_REGEX.test(normalisePhone(input))
}

/**
 * Adds the country code. The ONLY place '91' is ever prepended.
 * Returns null for an invalid number so a caller cannot accidentally send a
 * malformed number to Meta (which bills for the attempt).
 */
export function toWhatsAppNumber(input) {
  const digits = normalisePhone(input)
  if (!PHONE_REGEX.test(digits)) return null
  return `${COUNTRY_CODE}${digits}`
}

/** Display form: "98765 43210". Easier to read back to a guest aloud. */
export function formatPhone(input) {
  const d = normalisePhone(input)
  if (d.length !== PHONE_LENGTH) return d
  return `${d.slice(0, 5)} ${d.slice(5)}`
}

/**
 * The same 5-5 grouping, but for a field being TYPED into: "8888" -> "8888",
 * "888889" -> "88888 9".
 *
 * formatPhone() above gives up on anything that is not exactly ten digits,
 * which is right for read-only text — a half-number should not be dressed up
 * as a whole one. An input is the opposite case: the grouping has to appear as
 * the digits arrive, or it snaps into place on the tenth keystroke and makes
 * the field jump under the operator's thumb.
 *
 * The VALUE behind the field stays ten bare digits. Only what is shown is
 * grouped, and normalisePhone strips the space straight back out on the way
 * in, so nothing downstream ever sees it.
 */
export function groupPhone(input) {
  const d = normalisePhone(input)
  return d.length > 5 ? `${d.slice(0, 5)} ${d.slice(5)}` : d
}

/**
 * Backspace that lands on the separator should delete the DIGIT, not stall.
 *
 * Without this the space is removed from the text, normalisePhone puts the
 * same ten digits back, the field re-renders identically — and the operator
 * has pressed backspace and watched nothing happen. Nudging the caret one to
 * the left first lets the browser's own deletion land on the digit before it.
 *
 * Attach as onKeyDown alongside whatever else the field needs.
 */
export function skipPhoneSeparator(event) {
  if (event.key !== 'Backspace') return
  const el = event.currentTarget
  // Only for a plain caret. With a selection the browser deletes the range,
  // which is already what the operator asked for.
  if (el.selectionStart !== el.selectionEnd) return
  if (el.selectionStart > 0 && el.value[el.selectionStart - 1] === ' ') {
    el.setSelectionRange(el.selectionStart - 1, el.selectionStart - 1)
  }
}

/**
 * Masked form for the reviews table: "98765XXXXX".
 * Reviews are guest data an operator has no operational need to read, so it
 * is masked by default — least privilege applied to the UI, not just the DB.
 */
export function maskPhone(input) {
  const d = normalisePhone(input)
  if (d.length !== PHONE_LENGTH) return d || '—'
  return `${d.slice(0, 5)}${'X'.repeat(5)}`
}

// ═══════════════════════════════════════════════════════════════════
// CAR NUMBER
// ═══════════════════════════════════════════════════════════════════

/**
 * Uppercase, no spaces or dashes. "dl 8c af 1234" -> "DL8CAF1234".
 *
 * Why normalise at all: without it the same car checked in twice is two
 * different strings, so search fails and duplicate detection is impossible.
 * We deliberately do NOT validate against the Indian plate format — the
 * system must still work for a temporary registration, a diplomatic plate,
 * or a car from Nepal, and blocking check-in at the gate is worse than
 * storing an unusual string.
 */
export function formatCarNumber(input) {
  if (!input) return ''
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Display form: "DL8C AF1234" — grouped so it is readable at a glance. */
export function prettyCarNumber(input) {
  const c = formatCarNumber(input)
  if (c.length <= 4) return c
  return `${c.slice(0, 4)} ${c.slice(4)}`
}

// ═══════════════════════════════════════════════════════════════════
// DATES & TIMES  — all rendered in IST regardless of device timezone
// ═══════════════════════════════════════════════════════════════════

/**
 * When a service day begins, in hours past IST midnight.
 *
 * ── THE DAY RUNS 05:30 -> 05:30, NOT MIDNIGHT -> MIDNIGHT ──────────────
 * A party runs past midnight. Cutting the day at 00:00 took a car handed over
 * at 01:00 and called it tomorrow's: it drew a token from tomorrow's range,
 * disappeared from Today's Cars while the guest was still inside, and split
 * one night across two rows in every report.
 *
 * MUST equal the offset inside public.ist_today() — migration 0026. If these
 * two ever disagree, a car lands on one date and its token range on another,
 * and check-in fails with nothing on screen explaining why.
 * scripts/check-service-day.mjs is what stops that happening quietly.
 */
const SERVICE_DAY_START_MS = 5.5 * 60 * 60 * 1000

/** 'YYYY-MM-DD' in IST for any instant, honouring the 05:30 boundary. */
function serviceDateOf(at) {
  // Shifting the INSTANT back by 5h30m and then formatting in IST gives the
  // same answer as shifting the IST wall clock, which is what the SQL does.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at - SERVICE_DAY_START_MS))
}

/**
 * Today's SERVICE date as 'YYYY-MM-DD' in IST.
 *
 * MUST match public.ist_today() in SQL. 'en-CA' is used because it is the
 * locale that formats as YYYY-MM-DD, which is also Postgres's date literal
 * format — so the string can be passed straight into a .eq('service_date', …)
 * filter with no parsing.
 */
export function istToday() {
  return serviceDateOf(Date.now())
}

/** N service days before today, as an IST 'YYYY-MM-DD' string. */
export function istDaysAgo(days) {
  return serviceDateOf(Date.now() - days * 24 * 60 * 60 * 1000)
}

/**
 * The instant a service day begins, as a Postgres-parseable string:
 * '2026-08-08T05:30:00+05:30'.
 *
 * For the queries that filter on created_at rather than service_date — the
 * notification feed, "completed today". Those used to cut at midnight, which
 * put the small hours of a party on the wrong side of every boundary the rest
 * of the screen was using.
 *
 * Mirrors public.ist_day_start() in SQL.
 */
export function istDayStart(day) {
  return `${day ?? istToday()}T05:30:00+05:30`
}

/** The exclusive END of a service day: 05:30 IST the following morning. */
export function istDayEnd(day) {
  const next = new Date(`${day ?? istToday()}T05:30:00+05:30`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString()
}

/** "9:42 PM" */
export function formatTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleTimeString('en-IN', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * A whole clock hour, 12-hour: hour12(15) -> "3 pm", hour12(0) -> "12 am".
 *
 * am/pm stays in English in Hindi too, and that is not an oversight —
 * formatTime() above pins 'en-IN' for every timestamp in the app, so a Records
 * row already reads "9:42 pm" on a Hindi screen. Translating it only here would
 * make one chart disagree with every other time the operator sees.
 *
 * @param compact drops the space, for a crowded chart axis: "3pm".
 */
export function hour12(hour, { compact = false } = {}) {
  const h = ((Number(hour) % 24) + 24) % 24
  const shown = h % 12 === 0 ? 12 : h % 12
  const half = h < 12 ? 'am' : 'pm'
  return compact ? `${shown}${half}` : `${shown} ${half}`
}

/**
 * One clock hour as a range: hourRange12(15) -> "3–4 pm".
 *
 * The am/pm is written once when both ends share it, because "3 pm – 4 pm" is
 * the same fact said twice. It is written twice when the hour crosses noon or
 * midnight — "11 am – 12 pm", "11 pm – 12 am" — where collapsing it would be
 * ambiguous or plainly wrong.
 */
export function hourRange12(hour) {
  const h = ((Number(hour) % 24) + 24) % 24
  const next = (h + 1) % 24
  const from = h % 12 === 0 ? 12 : h % 12
  const to = next % 12 === 0 ? 12 : next % 12

  if (h < 12 === next < 12) return `${from}–${to} ${h < 12 ? 'am' : 'pm'}`
  return `${from} ${h < 12 ? 'am' : 'pm'} – ${to} ${next < 12 ? 'am' : 'pm'}`
}

/** "31 Jul 2026" */
export function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-IN', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

/** "31 Jul, 9:42 PM" — for tables that span more than one day. */
export function formatDateTime(value) {
  if (!value) return '—'
  return `${new Date(value).toLocaleDateString('en-IN', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: 'short',
  })}, ${formatTime(value)}`
}

/** The hour 0-23 in IST. Used to bucket the peak-hours chart. */
export function istHour(value) {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      hour12: false,
    }).format(new Date(value)),
  )
}

/**
 * "just now" / "3 min ago" / "2 h ago" / "31 Jul".
 *
 * The admin queue lives on this — "how long has this guest been waiting" is
 * the single most important number on that screen, and an absolute timestamp
 * makes you do the subtraction in your head.
 */
export function timeAgo(value) {
  if (!value) return '—'
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000)

  // Hindi puts the "ago" in front — "5 मिनट पहले" — and the digits stay
  // Western on purpose (see i18n/index.jsx: tokens are read off paper stubs).
  if (seconds < 10) return pickLang('just now', 'अभी')
  if (seconds < 60) return pickLang(`${seconds}s ago`, `${seconds} सेकंड पहले`)

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return pickLang(`${minutes} min ago`, `${minutes} मिनट पहले`)

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return pickLang(`${hours} h ago`, `${hours} घंटे पहले`)

  return formatDate(value)
}

/**
 * The name to PRINT for a staff member.
 *
 * Two arguments rather than an object, so it works with whatever shape the
 * caller has: a user_roles row (`name` / `name_hi`), an analytics row
 * (`operator_name` / `operator_name_hi`), or two plain strings off a record.
 *
 * ── WHY THIS IS A FUNCTION AND NOT AN INLINE TERNARY ──────────────────
 * `hi && x.name_hi ? x.name_hi : x.name` written at fifteen call sites is
 * fifteen chances to get the fallback backwards, and the failure is silent —
 * a blank name where a person should be. One function, one rule.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────
 * Hindi only when BOTH the reader chose Hindi and a Hindi spelling exists.
 * A missing name_hi is the normal case for everyone added before this
 * feature, so it must read as "use the English one", never as "show nothing".
 *
 * @param name   the English name
 * @param nameHi the Hindi spelling, or null
 */
export function personName(name, nameHi) {
  if (getActiveLang() === 'hi' && nameHi && nameHi.trim()) return nameHi.trim()
  return name ?? ''
}

/**
 * A parking place's name in the reading language: placeName('back side', 'बैक साइड').
 *
 * Same rule as personName above, and the same fallback: no Hindi spelling means
 * show the English one. A place with no label_hi is normal — the admin may
 * simply not have got to it — and an empty chip would be far worse than an
 * untranslated one.
 */
export function placeName(label, labelHi) {
  if (getActiveLang() === 'hi' && labelHi && labelHi.trim()) return labelHi.trim()
  return label ?? ''
}

/**
 * The Hindi name for a place the operator ALREADY parked in.
 *
 * parked_vehicles.parking_location is free text copied at park time — see
 * migration 0016 — so a stored "back side" has to be matched back to a place to
 * find its Hindi. Matched case- and space-insensitively, the same way
 * parking_space_usage() counts occupancy, so the two can never disagree.
 *
 * Free text the admin never listed ("behind the kitchen", typed by hand) simply
 * comes back unchanged. That is the escape hatch working: the point is to record
 * where the car is, not to force it into a list.
 *
 * @param spaces [{ label, labelHi }] — from useParkingSpaces
 */
export function storedPlaceName(location, spaces) {
  if (getActiveLang() !== 'hi' || !location) return location ?? ''

  const needle = location.trim().toLowerCase()
  const match = spaces?.find((s) => (s.label ?? '').trim().toLowerCase() === needle)

  return match?.labelHi?.trim() || location
}

/**
 * Seconds -> "09:58" for the pickup countdown.
 * Clamped at 0 so an expired timer shows "00:00", never "-00:07".
 */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/** "4 min" / "1 h 12 min" — for average-wait analytics. */
export function formatMinutes(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return '—'
  const m = Math.round(minutes)
  if (m < 60) return pickLang(`${m} min`, `${m} मिनट`)
  return pickLang(
    `${Math.floor(m / 60)} h ${m % 60} min`,
    `${Math.floor(m / 60)} घंटे ${m % 60} मिनट`,
  )
}

/** Whole minutes between two timestamps. Null-safe for open tasks. */
export function minutesBetween(from, to) {
  if (!from || !to) return null
  return (new Date(to).getTime() - new Date(from).getTime()) / 60000
}

// ═══════════════════════════════════════════════════════════════════
// MISC
// ═══════════════════════════════════════════════════════════════════

/** "Rahul Kumar Sharma" -> "RK" for compact avatars. */
export function initials(name) {
  if (!name) return '?'
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

/** Long guest names truncated for table cells. */
export function truncate(text, max = 22) {
  if (!text) return '—'
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** 0.4567 -> "46%". Guards against a 0/0 division producing "NaN%". */
export function percent(part, whole, decimals = 0) {
  if (!whole) return '0%'
  return `${((part / whole) * 100).toFixed(decimals)}%`
}

/**
 * Builds a CSV and triggers a download. Used by system/Records and admin/Reviews.
 *
 * @param filename e.g. 'valet-guests-2026-08-23.csv'
 * @param rows     plain objects. Object.keys() of the FIRST row becomes the
 *                 header, so the keys are the column titles.
 * @param options  { text: ['Number'] } — columns Excel must not treat as numbers.
 *
 * ── WHY `text` HAS TO EXIST ───────────────────────────────────────────
 * CSV carries no cell types, so Excel guesses, and it guesses "number" for a
 * phone. MEASURED, from a real export opened in Excel:
 *
 *     Guest name   Number        Car tier
 *     Kbks         6.576E+09     Standard
 *     Msm          1E+10         VIP
 *
 * The digits are still in the file — Excel is only displaying them that way —
 * but nobody can read the column, and widening it is a per-open workaround, not
 * a fix. A leading zero would additionally be lost for real.
 *
 * A previous version of this comment claimed the wrapper below was already
 * being applied. It was not: the code had no such branch, so every phone
 * exported as a bare number. The comment was the only thing protecting them.
 */
export function downloadCsv(filename, rows, options = {}) {
  if (!rows?.length) return

  const headers = Object.keys(rows[0])
  const asText = new Set(options.text ?? [])

  const cell = (header, value) => {
    // '' as well as null, and the empty string is the one that matters: callers
    // write `r.guest_phone ?? ''`, so a guest with no number arrives here as ''.
    // Left to fall through, a text column would emit ="" — which LOOKS blank in
    // Excel but is a formula, so ISBLANK and COUNTA both disagree with the eye.
    if (value == null || value === '') return ''
    const s = String(value)
    const needsQuoting = /[",\n\r]/.test(s)

    // ="…" is read by Excel as a formula returning a string, which pins the
    // value to TEXT: no scientific notation, no lost leading zero, and no
    // dependence on how wide the column happens to be.
    //
    // It must go in UNQUOTED — wrapping it in quotes makes Excel show the
    // literal ="9876543210", which is worse than the problem. That is why the
    // needsQuoting check comes first: a value with a comma in it would break the
    // row, so it falls through to ordinary quoting instead. Phone numbers,
    // tokens and registrations never contain one, so in practice this always
    // takes the text path — but it degrades safely rather than corrupting a row.
    if (asText.has(header) && !needsQuoting) return `="${s}"`

    // Quote if it contains a comma, quote or newline; double any inner quotes.
    return needsQuoting ? `"${s.replace(/"/g, '""')}"` : s
  }

  const csv = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => cell(h, row[h])).join(',')),
  ].join('\r\n')

  // BOM so Excel detects UTF-8 and renders Hindi names correctly.
  downloadBlob(filename, new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' }))
}

/**
 * Hands a Blob to the user as a file.
 *
 * Extracted when a spreadsheet export briefly shared it. That is gone now, but
 * this stays separate from downloadCsv above: the revoke timing below is the
 * part worth having in one place, and it is the part everyone gets wrong.
 */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename

  // ── IN the document, and revoked LATER ────────────────────────────────
  // This used to create a detached <a>, click it, and revoke the object URL on
  // the very next line. Both halves of that are unreliable, and it failed in the
  // way that is hardest to report: the toast said the export had worked and no
  // file ever appeared.
  //
  //   1. A detached anchor is not guaranteed to trigger a download. Chrome
  //      usually obliges; other browsers ignore a click on an element that is
  //      not in the document.
  //
  //   2. revokeObjectURL in the same tick is a race. The browser reads the blob
  //      asynchronously AFTER the click returns, and revoking pulls the data out
  //      from under it. A few rows normally win the race, which is why this
  //      looked fine in testing — a thousand-row export does not.
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()

  // ── WHEN TO REVOKE: not on a short timer ──────────────────────────────
  // A one-second delay was tried and MEASURED failing. Driving this from a real
  // browser, a 1200-row export reported:
  //
  //     download begin  valet-guests-2026-08-17.csv
  //     download inProgress   (x5)
  //     download canceled
  //
  // The browser writes the file asynchronously and takes longer than a second to
  // finish even for a small CSV, so revoking on a timer cancels a download that
  // had already started — and nothing surfaces, because the click succeeded and
  // the success toast has already been shown.
  //
  // So the URL is released when the page goes away instead of on a guess about
  // how long a write takes. One blob of a few hundred KB, held until navigation,
  // on an admin action nobody performs twice a minute.
  //
  // pagehide, not beforeunload: beforeunload does not fire reliably on mobile
  // Safari, which is where a tab is most likely to be discarded rather than
  // closed.
  const release = () => {
    URL.revokeObjectURL(url)
    window.removeEventListener('pagehide', release)
  }
  window.addEventListener('pagehide', release)
}
