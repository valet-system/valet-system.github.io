/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: scripts/check-icons.mjs                                       │
 * │                                                                     │
 * │ WHAT THIS CHECKS                                                    │
 * │   That every icon name used anywhere in src/ is actually defined in  │
 * │   components/ui/Icon.jsx.                                           │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Icon returns null for a name it does not know. In production that  │
 * │   is deliberate — a typo must never crash a page mid-shift — but it  │
 * │   also means the failure is COMPLETELY SILENT: no error, no warning,  │
 * │   no missing-glyph box. Just nothing where a glyph should be.        │
 * │                                                                     │
 * │   Two of these shipped. StaffManager asked for "map-pin", which has  │
 * │   never existed (the icon is called "location"), in two places: the  │
 * │   property picker and the property chip on every staff row. Both     │
 * │   rendered an empty gap for however long they had been there, and    │
 * │   the console.error only fires in DEV, on a page somebody happens    │
 * │   to have open.                                                     │
 * │                                                                     │
 * │   A build-time check is the right place for this. The name is a      │
 * │   string literal in almost every case, so it can be read without    │
 * │   running anything.                                                 │
 * │                                                                     │
 * │ WHAT IT CANNOT SEE                                                  │
 * │   A name built at runtime — `icon={`arrow-${dir}`}` or a name from   │
 * │   an API. Nothing in this codebase does that today. If something     │
 * │   ever does, this check will not catch it and the comment above the  │
 * │   null return in Icon.jsx is the only warning left.                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'src'
const ICON_FILE = 'src/components/ui/Icon.jsx'

// ── What Icon.jsx defines ──────────────────────────────────────────────
// Read from the PATHS object only. Reading the whole file would also pick up
// every other object key in it and quietly widen what counts as "defined".
const iconSource = readFileSync(ICON_FILE, 'utf8')
const pathsStart = iconSource.indexOf('const PATHS')
if (pathsStart === -1) {
  console.error(`FAIL — could not find "const PATHS" in ${ICON_FILE}`)
  process.exit(1)
}
const pathsBlock = iconSource.slice(pathsStart, iconSource.indexOf('\n}', pathsStart))

const defined = new Set(
  [...pathsBlock.matchAll(/^\s+'?([a-zA-Z][a-zA-Z0-9-]*)'?\s*:/gm)].map((m) => m[1]),
)

// ── Every name used ────────────────────────────────────────────────────
function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.jsx?$/.test(entry) ? [full] : []
  })
}

/**
 * Both spellings, and the ternary in between.
 *
 *   icon="close"                                    -> close
 *   <Icon name="location" />                        -> location
 *   icon={person.is_active ? 'x-circle' : 'check'}  -> x-circle, check
 *
 * The braced form has its comparison right-hand sides removed first, then every
 * remaining literal is taken — so both branches of a ternary are checked and the
 * string being COMPARED against is not mistaken for a glyph.
 */
const problems = []

for (const file of walk(ROOT)) {
  // Icon.jsx itself lists names in its own ICON_NAMES export.
  if (file.replace(/\\/g, '/') === ICON_FILE) continue

  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')

  lines.forEach((line, i) => {
    const attrs = [...line.matchAll(/(?:\bicon|\biconRight|\bname)\s*=\s*(?:"([^"]*)"|\{([^}]*)\})/g)]

    for (const [, quoted, braced] of attrs) {
      // In a ternary the COMPARISON is a quoted string too, and it is not an
      // icon name:
      //
      //   icon={kind === 'cars' ? 'car' : 'users'}
      //                  ^^^^^^ this is the test, not a glyph
      //
      // So comparison right-hand sides come out first, and whatever literals
      // are left are the branches — which is what actually gets rendered.
      const expr = (braced ?? '').replace(/[=!]==?\s*'[^']*'/g, '')
      const names = quoted ? [quoted] : [...expr.matchAll(/'([^']*)'/g)].map((m) => m[1])

      for (const name of names) {
        // Only things that look like an icon name. `name="guestPhone"` on an
        // <input> and `name={fullName}` are not icons, and the codebase has
        // plenty of both.
        if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) continue
        if (defined.has(name)) continue

        // A lowercase-hyphen string that is not an icon: form field names,
        // autocomplete tokens, and so on. Only flag it when the line is
        // plausibly an icon — either the Icon component or an icon prop.
        const looksLikeIcon = /<Icon\b/.test(line) || /\bicon(Right)?\s*=/.test(line)
        if (!looksLikeIcon) continue

        problems.push({ file: relative('.', file), line: i + 1, name, text: line.trim() })
      }
    }
  })
}

if (problems.length === 0) {
  console.log(`OK - every icon name used in src/ is one of the ${defined.size} defined in Icon.jsx.`)
  process.exit(0)
}

console.error(`\n${problems.length} icon name(s) used but NOT defined in Icon.jsx:\n`)
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  "${p.name}"`)
  console.error(`      ${p.text}`)
}
console.error(`\nDefined names:\n  ${[...defined].sort().join(' ')}\n`)
console.error('Icon renders NOTHING for an unknown name, so this is invisible at runtime.')
process.exit(1)
