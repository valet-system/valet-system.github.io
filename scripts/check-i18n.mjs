/**
 * Key parity for the two dictionaries, and for every t() call in the app.
 *
 * Three failures this catches, all of which ship silently otherwise:
 *   1. A key added to `en` but not `hi` — the screen falls back to English
 *      and nobody notices until an operator is standing in front of it.
 *   2. A key added to `hi` but not `en` — dead weight, usually a typo in one
 *      of the two.
 *   3. t('some.key') for a key that does not exist — renders the raw key,
 *      so the button reads "tasks.guestArrived".
 *
 * Run: node scripts/check-i18n.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src'
const DICT = 'src/i18n/translations.js'

const text = readFileSync(DICT, 'utf8')
const hiAt = text.indexOf('export const hi')
if (hiAt < 0) {
  console.error(`Could not find the hi block in ${DICT}`)
  process.exit(1)
}

// Split FIRST, then match. Both blocks use the same key names, so scanning the
// whole file at once cannot tell them apart.
const keysIn = (block) => new Set([...block.matchAll(/^ {2}'([\w.]+)':/gm)].map((m) => m[1]))
const enKeys = keysIn(text.slice(0, hiAt))
const hiKeys = keysIn(text.slice(hiAt))

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.jsx?$/.test(full)) out.push(full)
  }
  return out
}

const used = new Map()
for (const file of walk(SRC)) {
  if (file.includes(`i18n`)) continue
  const src = readFileSync(file, 'utf8')
  // Matches t('a.b'), translate('a.b') and ta('a.b'). The dotted shape is the
  // guard against picking up unrelated one-argument calls.
  for (const m of src.matchAll(/[a-z]{1,9}\(\s*'([a-z][\w]*\.[\w.]+)'/gi)) {
    if (!used.has(m[1])) used.set(m[1], file)
  }
  // FILTERS-style tables that hold a key rather than a literal.
  for (const m of src.matchAll(/(?:labelKey|titleKey|key):\s*'([\w.]+\.[\w.]+)'/g)) {
    if (!used.has(m[1])) used.set(m[1], file)
  }
}

const problems = []
for (const key of enKeys) if (!hiKeys.has(key)) problems.push(`no hi translation: ${key}`)
for (const key of hiKeys) if (!enKeys.has(key)) problems.push(`in hi but not en:   ${key}`)
for (const [key, file] of used) {
  if (!enKeys.has(key)) problems.push(`t('${key}') has no entry  (${file})`)
}

if (problems.length) {
  for (const line of problems) console.error(line)
  console.error(`
${problems.length} i18n problem(s).`)
  process.exit(1)
}

console.log(`OK - ${enKeys.size} keys in both languages, ${used.size} referenced, none missing.`)
