/**
 * Proves selectOptional actually falls back.
 *
 * This exists because the alternative — assuming it works — is what caused the
 * bug it guards against: adding user_roles.name_hi to the profile read locked
 * every user out with "column does not exist" on a healthy database.
 *
 * src/supabase.js cannot be imported here (it reads import.meta.env and builds
 * a real client at module load), so the function's SOURCE is read and
 * evaluated in isolation. That is deliberate: evaluating a hand-copied
 * reimplementation would test the copy, not the shipped code.
 *
 * Run: node scripts/check-select-optional.mjs
 */
import { readFileSync } from 'node:fs'

const src = readFileSync('src/supabase.js', 'utf8')

const start = src.indexOf('export async function selectOptional')
if (start < 0) {
  console.error('selectOptional is not exported from src/supabase.js any more.')
  process.exit(1)
}
// Read to the closing brace of the function, which sits at column 0.
const end = src.indexOf('\n}\n', start)
if (end < 0) {
  console.error('Could not find the end of selectOptional.')
  process.exit(1)
}

const body = src.slice(start, end + 3).replace('export async function', 'async function')
// eslint-disable-next-line no-new-func
const selectOptional = new Function(`${body}; return selectOptional`)()

const missingColumn = { error: { code: '42703', message: 'column user_roles.name_hi does not exist' } }
const missingNoCode = { error: { message: 'column user_roles.name_hi does not exist' } }
// 42703 with wording the regex does NOT match. Without this case the two
// checks are redundant enough that disabling either one alone changes nothing,
// and the test would pass with half the guard deleted.
const missingCodeOnly = { error: { code: '42703', message: 'undefined column in relation' } }
const otherError = { error: { code: '42501', message: 'permission denied' } }
const success = { data: [{ id: 1 }], error: null }
const fallback = { data: [{ id: 1, viaFallback: true }], error: null }

/** [label, what the query returns, should the fallback run?] */
const cases = [
  ['42703 code', missingColumn, true],
  ['message only, no code', missingNoCode, true],
  ['code only, message does not say so', missingCodeOnly, true],
  ['unrelated error (42501)', otherError, false],
  ['success', success, false],
]

let failed = 0
const warn = console.warn
console.warn = () => {}

for (const [label, first, expectFallback] of cases) {
  let fallbackRan = false
  const result = await selectOptional(
    async () => first,
    async () => {
      fallbackRan = true
      return fallback
    },
    'user_roles.name_hi',
  )

  // Asserted explicitly, both ways round. Deriving "should it have run?" from
  // the result is how a test ends up agreeing with whatever the code did.
  if (fallbackRan !== expectFallback) {
    failed += 1
    warn(`FAIL  ${label}: fallback ${fallbackRan ? 'ran' : 'did not run'}, expected the opposite`)
  }
  const expected = expectFallback ? fallback : first
  if (result !== expected) {
    failed += 1
    warn(`FAIL  ${label}: returned the wrong result`)
  }
}

console.warn = warn

if (failed) {
  console.error(`
${failed} failure(s).`)
  process.exit(1)
}
console.log(`OK - selectOptional falls back on a missing column and only then (${cases.length} cases).`)
