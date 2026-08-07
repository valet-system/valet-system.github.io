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

// ── the cron has to run AFTER the boundary, not before it ─────────────

const cron = sql.match(/'daily-token-reset',\s*\n\s*'([^']+)'/)
if (!cron) {
  failed += 1
  console.error('Could not find the daily-token-reset schedule in the migration.')
} else {
  const [minute, hour] = cron[1].split(' ')
  const utcMinutes = Number(hour) * 60 + Number(minute)
  // The job creates the NEXT range, so it must fire after the day has turned.
  // 05:30 IST is 00:00 UTC, so anything in the first few minutes of UTC is right.
  const istMinutes = (utcMinutes + IST_OFFSET_MIN) % (24 * 60)
  if (istMinutes < sqlMinutes || istMinutes > sqlMinutes + 60) {
    failed += 1
    console.error(
      `FAIL  daily-token-reset runs at ${cron[1]} UTC = ` +
        `${String(Math.floor(istMinutes / 60)).padStart(2, '0')}:` +
        `${String(istMinutes % 60).padStart(2, '0')} IST, ` +
        `which is not just after the ${sqlMinutes / 60}:00-ish boundary.`,
    )
  }
}

// ── the UI must name the same time the cron actually runs ─────────────
//
// It did not, once: the job moved to 05:35 IST and Token Management went on
// telling the admin "created automatically at 00:05 IST", in both languages.
// A screen that states a fact confidently and wrongly is worse than one that
// says nothing at all.
if (cron) {
  const [minute, hour] = cron[1].split(' ')
  const istMinutes = (Number(hour) * 60 + Number(minute) + IST_OFFSET_MIN) % (24 * 60)
  const hhmm =
    `${String(Math.floor(istMinutes / 60)).padStart(2, '0')}:` +
    `${String(istMinutes % 60).padStart(2, '0')}`

  const dict = readFileSync('src/i18n/translations.js', 'utf8')
  for (const key of ['tokens.readyBody', 'tokens.noRangeTomorrowBody']) {
    // Both language blocks carry the key, so both copies get checked.
    const matches = [...dict.matchAll(new RegExp(`'${key}':([^\\n]*\\n?[^\\n]*)`, 'g'))]
    if (matches.length !== 2) {
      failed += 1
      console.error(`FAIL  expected ${key} in both language blocks, found ${matches.length}`)
      continue
    }
    for (const m of matches) {
      if (!m[1].includes(hhmm)) {
        failed += 1
        console.error(
          `FAIL  ${key} does not mention ${hhmm} IST, which is when the cron runs:\n` +
            `      ${m[1].trim()}`,
        )
      }
    }
  }
}

if (failed) {
  console.error(`\n${failed} failure(s).`)
  process.exit(1)
}
console.log(
  `OK - the service day starts at 05:30 IST, SQL and the browser agree on all ${cases.length} instants.`,
)
