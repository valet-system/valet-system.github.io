/**
 * Two checks over the automatic English -> Hindi layer.
 *
 * 1. It converts the sentences the DATABASE writes, and leaves the data inside
 *    those sentences alone.
 * 2. public/sw.js's hand-copied phrase table still matches src/i18n's.
 *
 * The second one especially: duplication with no check goes stale, and the
 * failure is invisible — the notification bell shows Hindi while the
 * lock-screen notification silently shows English.
 *
 * Run: node scripts/check-autotranslate.mjs
 */
import { readFileSync } from 'node:fs'
import { autoTranslate } from '../src/i18n/autoTranslate.js'

// ══════════════════════════════════════════════════════════════════════
// DRIFT GUARD
//
// public/sw.js cannot import anything — a worker woken by a push has no module
// graph to import through — so the phrases the database writes are duplicated
// there by hand. This is what keeps the two copies honest.
// ══════════════════════════════════════════════════════════════════════

function phrasesFrom(file, marker) {
  const src = readFileSync(file, 'utf8')
  const start = src.indexOf(marker)
  if (start < 0) throw new Error(`${marker} not found in ${file}`)

  const open = src.indexOf('{', start)
  const close = src.indexOf('\n}', open)
  const block = src.slice(open, close)

  const out = new Map()
  // Matches  'English': 'हिन्दी',  and the bare-identifier form  car: 'गाड़ी',
  for (const m of block.matchAll(/(?:'([^']+)'|(\w+))\s*:\s*'([^']+)'/g)) {
    out.set(m[1] ?? m[2], m[3])
  }
  return out
}

const appPhrases = phrasesFrom('src/i18n/autoTranslate.js', 'const SERVER_PHRASES')
const swPhrases = phrasesFrom('public/sw.js', 'const PUSH_HI')

/**
 * sw.js's own converter, lifted out and run for real.
 *
 * Comparing the two phrase TABLES was not enough: the patterns ("Token 47",
 * "by Rajesh") live in code, not in the table, so one file could grow a rule
 * the other lacked and the tables would still match. Running both
 * implementations over the same input compares what they actually DO.
 */
function swConverter() {
  const src = readFileSync('public/sw.js', 'utf8')
  const grab = (marker) => {
    const start = src.indexOf(marker)
    if (start < 0) throw new Error(`${marker} not found in public/sw.js`)
    return src.slice(start, src.indexOf('\n}', start) + 2)
  }
  return new Function(`${grab('const PUSH_HI')}\n${grab('function toHindi')}\nreturn toHindi`)()
}

const swToHindi = swConverter()

/** Text the DATABASE writes. Both implementations must agree on every one. */
const SHARED = [
  ...appPhrases.keys(),
  'Token 47',
  'Token ?',
  'by Rajesh',
  'Token 47 · 4821 · Basement 2 · by Rajesh',
  'Token 8 · car · by Sunil Kumar',
  'Token 12 · 9090 · park it again and confirm the spot',
]

let drift = 0
for (const input of SHARED) {
  const app = autoTranslate(input, 'hi')
  const sw = swToHindi(input)
  if (app !== sw) {
    drift += 1
    console.error(`DRIFT  ${JSON.stringify(input)}\n       app: ${app}\n       sw : ${sw}`)
  }
}
if (drift) {
  console.error(
    `\n${drift} drift problem(s): public/sw.js and src/i18n/autoTranslate.js disagree.`,
  )
  process.exit(1)
}

// ══════════════════════════════════════════════════════════════════════
// CONVERSION
// ══════════════════════════════════════════════════════════════════════

const cases = [
  // ── the notification titles the SQL triggers write ────────────────────
  ['Car requested', 'गाड़ी माँगी गई'],
  ['Fetch a car', 'गाड़ी लानी है'],
  ['Guest did not arrive', 'गेस्ट नहीं आए'],
  ['Car parked', 'गाड़ी पार्क हो गई'],
  ['Car delivered', 'गाड़ी गेस्ट को दे दी'],
  ['Car re-parked', 'गाड़ी दोबारा पार्क हो गई'],

  // ── bodies: ours converts, the car and the place survive untouched ───
  ['Token 47 · 4821', 'टोकन 47 · 4821'],
  ['Token 47 · 4821 · Basement 2', 'टोकन 47 · 4821 · Basement 2'],
  ['Token 8 · car', 'टोकन 8 · गाड़ी'],
  ['Token ? · 1234', 'टोकन ? · 1234'],

  // ── who did it (migration 0024). The NAME is never touched. ──────────
  ['by Rajesh', 'Rajesh ने'],
  ['Token 47 · 4821 · Basement 2 · by Rajesh', 'टोकन 47 · 4821 · Basement 2 · Rajesh ने'],
  [
    'Token 12 · 9090 · park it again and confirm the spot',
    'टोकन 12 · 9090 · दोबारा पार्क करके जगह बताइए',
  ],

  // ── learned from the dictionary, with no server phrase written ───────
  ['Try again', 'दोबारा कोशिश करें'],
  ['Mark all read', 'सब पढ़ी हुई मार्क करें'],

  // ── a {var} entry becomes a pattern, and the value comes back ────────
  ['3 new', '3 नई'],

  // ── MUST NOT be touched: data, not text we wrote ─────────────────────
  ['Basement 2', 'Basement 2'],
  ['Rohit Sharma', 'Rohit Sharma'],
  ['4821', '4821'],
  ['Some sentence nobody translated', 'Some sentence nobody translated'],
]

let failed = 0
for (const [input, expected] of cases) {
  const got = autoTranslate(input, 'hi')
  if (got !== expected) {
    failed += 1
    console.error(
      `FAIL  ${JSON.stringify(input)}\n      want ${JSON.stringify(expected)}\n      got  ${JSON.stringify(got)}`,
    )
  }
}

// English must be a no-op, whatever the input.
for (const [input] of cases) {
  if (autoTranslate(input, 'en') !== input) {
    failed += 1
    console.error(`FAIL  en changed ${JSON.stringify(input)}`)
  }
}

if (failed) {
  console.error(`\n${failed} failure(s).`)
  process.exit(1)
}
console.log(
  `OK - ${cases.length} phrases convert correctly, English is untouched, ` +
    `and sw.js agrees with src/i18n on all ${SHARED.length} shared inputs.`,
)
