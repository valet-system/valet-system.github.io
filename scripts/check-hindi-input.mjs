/**
 * Truth table for HindiInput's follow/pin logic.
 *
 * This exists because that logic has shipped wrong twice: once auto-filling
 * over a stored spelling the moment Edit opened, and once leaving the "fill it
 * in for me" button with nothing to do. Both were obvious in a table and
 * invisible while reading the component.
 *
 * shouldFollow() is imported from the real file, not reimplemented — a
 * hand-copied version would only ever test the copy.
 *
 * Run: node scripts/check-hindi-input.mjs
 */
import { readFileSync } from 'node:fs'

// The component imports React and '@/...' aliases, so it cannot be imported
// directly under plain node. The exported pure function is lifted out by name.
const src = readFileSync('src/components/ui/HindiInput.jsx', 'utf8')
const start = src.indexOf('export function shouldFollow')
if (start < 0) {
  console.error('shouldFollow is no longer exported from HindiInput.jsx.')
  process.exit(1)
}
const end = src.indexOf('\n}\n', start)
const body = src.slice(start, end + 3).replace('export function', 'function')
// eslint-disable-next-line no-new-func
const shouldFollow = new Function(`${body}; return shouldFollow`)()

const ADD = { storedSource: null, storedValue: null }
const SAVED = { storedSource: 'Rajesh', storedValue: 'राजेश' }
const SAVED_NO_HI = { storedSource: 'Rajesh', storedValue: null }

// `value` is what the Hindi box currently reads. It matters: "untouched" means
// BOTH fields still show the stored pair, not just the English one.

/** [what is happening, args, should the field re-derive?] */
const cases = [
  // ── the Add dialog: always following until the admin types Hindi ──────
  ['add, empty', { ...ADD, source: '', value: '', pinnedFor: null }, true],
  ['add, typing a name', { ...ADD, source: 'Rajesh', value: '', pinnedFor: null }, true],
  [
    'add, admin corrected the Hindi',
    { ...ADD, source: 'Rajesh', value: 'राजेश', pinnedFor: 'Rajesh' },
    false,
  ],
  [
    'add, corrected the Hindi THEN fixed the English',
    { ...ADD, source: 'Rajesh Kumar', value: 'राजेश', pinnedFor: 'Rajesh' },
    true,
  ],

  // ── the Edit dialog on a row that already has a Hindi spelling ────────
  [
    'edit, nothing touched',
    { ...SAVED, source: 'Rajesh', value: 'राजेश', pinnedFor: null },
    false,
  ],
  [
    'edit, whitespace only differs',
    { ...SAVED, source: '  Rajesh  ', value: ' राजेश ', pinnedFor: null },
    false,
  ],
  [
    'edit, English name changed',
    { ...SAVED, source: 'Rajesh Kumar', value: 'राजेश', pinnedFor: null },
    true,
  ],
  [
    'edit, untouched but the admin asked for a refill',
    { ...SAVED, source: 'Rajesh', value: 'राजेश', pinnedFor: null, forced: true },
    true,
  ],
  [
    'edit, admin corrected the Hindi by hand',
    { ...SAVED, source: 'Rajesh', value: 'राजेश जी', pinnedFor: 'Rajesh' },
    false,
  ],
  [
    'edit, corrected the Hindi, then changed the English',
    { ...SAVED, source: 'Rajesh Kumar', value: 'राजेश जी', pinnedFor: 'Rajesh' },
    true,
  ],
  [
    'edit, corrected the Hindi and asked for a refill — the hand still wins',
    { ...SAVED, source: 'Rajesh', value: 'राजेश जी', pinnedFor: 'Rajesh', forced: true },
    false,
  ],

  // ── the box is empty even though the row HAS a spelling ───────────────
  // Reported from a real screen: the status read "as saved" over an empty
  // field and it stayed empty. Checking only the English name made that look
  // untouched. It is not — there is nothing in the box to protect.
  [
    'edit, stored Hindi exists but the box is empty',
    { ...SAVED, source: 'Rajesh', value: '', pinnedFor: null },
    true,
  ],

  // ── a row with no Hindi spelling yet: there is nothing to protect ─────
  [
    'edit, no stored Hindi, nothing touched',
    { ...SAVED_NO_HI, source: 'Rajesh', value: '', pinnedFor: null },
    true,
  ],
]

let failed = 0
for (const [label, args, expected] of cases) {
  const got = shouldFollow({ forced: false, ...args })
  if (got !== expected) {
    failed += 1
    console.error(`FAIL  ${label}\n      want ${expected}, got ${got}`)
  }
}

if (failed) {
  console.error(`\n${failed} failure(s).`)
  process.exit(1)
}
console.log(`OK - HindiInput follows the English name in the right ${cases.length} cases.`)
