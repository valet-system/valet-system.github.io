/**
 * The service day starts at 05:30 IST, and TWO places implement that rule:
 *
 *   public.ist_today()        migration 0026
 *   istToday()                src/utils/format.js
 *
 * If they ever disagree, a car is written with one service_date while the
 * token allocator looks up another — check-in fails, and nothing on screen
 * says why. This proves they agree, at the boundary, from both directions.
 *
 * The SQL is not executed; its expression is read out of the migration and
 * applied here. That is deliberate — it means the check runs in CI with no
 * database, and it compares the shipped SQL rather than a copy of it.
 *
 * Run: node scripts/check-service-day.mjs
 */
import { readFileSync } from 'node:fs'

const MIGRATION = 'supabase/migrations/20260731092600_service_day_0530.sql'
const FORMAT = 'src/utils/format.js'

// ── the offset each side actually ships ───────────────────────────────

const sql = readFileSync(MIGRATION, 'utf8')
const sqlFn = sql.slice(sql.indexOf('create or replace function public.ist_today()'))
const sqlOffset = sqlFn.match(/-\s*interval\s*'(\d+)\s*hours?\s*(\d+)\s*minutes?'/)
if (!sqlOffset) {
  console.error(`Could not find the interval in ${MIGRATION}. Did ist_today() change shape?`)
  process.exit(1)
}
const sqlMinutes = Number(sqlOffset[1]) * 60 + Number(sqlOffset[2])

const js = readFileSync(FORMAT, 'utf8')
const jsOffset = js.match(/SERVICE_DAY_START_MS\s*=\s*([\d.]+)\s*\*\s*60\s*\*\s*60\s*\*\s*1000/)
if (!jsOffset) {
  console.error(`Could not find SERVICE_DAY_START_MS in ${FORMAT}.`)
  process.exit(1)
}
const jsMinutes = Number(jsOffset[1]) * 60

let failed = 0

if (sqlMinutes !== jsMinutes) {
  failed += 1
  console.error(
    `MISMATCH  the two halves of the rule disagree\n` +
      `          ${MIGRATION}: ${sqlMinutes} minutes past midnight\n` +
      `          ${FORMAT}: ${jsMinutes} minutes past midnight`,
  )
}

if (sqlMinutes !== 330) {
  failed += 1
  console.error(`The service day should start at 05:30 IST (330 min), got ${sqlMinutes}.`)
}

// ── the boundary itself, computed the way each side computes it ───────

const IST_OFFSET_MIN = 330

/** What Postgres would return: shift the IST wall clock, take the date. */
function sqlServiceDate(utcIso) {
  const istWall = new Date(new Date(utcIso).getTime() + IST_OFFSET_MIN * 60000)
  const shifted = new Date(istWall.getTime() - sqlMinutes * 60000)
  return shifted.toISOString().slice(0, 10)
}

/** What src/utils/format.js does: shift the INSTANT, format in IST. */
function jsServiceDate(utcIso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(new Date(utcIso).getTime() - jsMinutes * 60000))
}

/** [what the clock says in IST, the UTC instant, the service date it belongs to] */
const cases = [
  ['07 Aug 22:00 IST — the party',        '2026-08-07T16:30:00Z', '2026-08-07'],
  ['08 Aug 00:01 IST — just past midnight', '2026-08-07T18:31:00Z', '2026-08-07'],
  ['08 Aug 01:00 IST — still that night',  '2026-08-07T19:30:00Z', '2026-08-07'],
  ['08 Aug 05:29 IST — one minute to go',  '2026-08-07T23:59:00Z', '2026-08-07'],
  ['08 Aug 05:30 IST — the new day',       '2026-08-08T00:00:00Z', '2026-08-08'],
  ['08 Aug 05:31 IST',                     '2026-08-08T00:01:00Z', '2026-08-08'],
  ['08 Aug 12:00 IST — midday',            '2026-08-08T06:30:00Z', '2026-08-08'],
  ['31 Dec 23:59 IST — year end',          '2026-12-31T18:29:00Z', '2026-12-31'],
  ['01 Jan 02:00 IST — new year, old day', '2026-12-31T20:30:00Z', '2026-12-31'],
]

for (const [label, utc, expected] of cases) {
  const fromSql = sqlServiceDate(utc)
  const fromJs = jsServiceDate(utc)

  if (fromSql !== expected) {
    failed += 1
    console.error(`FAIL  SQL   ${label}\n      want ${expected}, got ${fromSql}`)
  }
  if (fromJs !== expected) {
    failed += 1
    console.error(`FAIL  JS    ${label}\n      want ${expected}, got ${fromJs}`)
  }
  if (fromSql !== fromJs) {
    failed += 1
    console.error(`FAIL  SQL and JS disagree on ${label}: ${fromSql} vs ${fromJs}`)
  }
}

// ── the daily-token-reset cron, and the UI that once quoted its time ──
//
// Retired by migration 0071 (operator_token_ranges): token ranges are now
// assigned per operator, per night, by an admin — nothing auto-creates one
// any more, so daily-token-reset is unscheduled and Token Management no
// longer has copy naming when it used to run. The checks that used to live
// here (the cron fires just after the 05:30 boundary; tokens.readyBody and
// tokens.noRangeTomorrowBody quote that same time) went with it — both
// halves of what they compared are gone, not just one, so there is nothing
// left for them to catch out of step.
//
// The SQL/JS boundary-agreement check above is untouched: ist_today() and
// istToday() still have to agree, since operator_token_ranges.service_date
// and allocate_operator_token()'s own occupancy check both key off it.

if (failed) {
  console.error(`\n${failed} failure(s).`)
  process.exit(1)
}
console.log(
  `OK - the service day starts at 05:30 IST, SQL and the browser agree on all ${cases.length} instants.`,
)
