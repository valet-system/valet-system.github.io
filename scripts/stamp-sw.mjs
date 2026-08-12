/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: scripts/stamp-sw.mjs                                          │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Writes a build fingerprint into dist/sw.js, so a deploy actually   │
 * │   looks like a new service worker to the browser.                     │
 * │                                                                     │
 * │ ── WHY THIS IS NOT OPTIONAL ─────────────────────────────────────────│
 * │   A browser decides "is this a new service worker?" by BYTE          │
 * │   COMPARING the fetched sw.js against the installed one. public/sw.js │
 * │   is copied into dist verbatim by Vite and its VERSION was a literal, │
 * │   so every deploy shipped a byte-identical file.                      │
 * │                                                                     │
 * │   The consequence was subtle and total: registration.update() found   │
 * │   nothing, `updatefound` never fired, onUpdateReady() never emitted,  │
 * │   and the "a new version is ready" card in PwaStatus could never      │
 * │   appear — no matter how many times the app was deployed. The app     │
 * │   still picked up new code on a cold start, because navigations are   │
 * │   network-first, which is exactly why this went unnoticed: it looked  │
 * │   like updates worked.                                                │
 * │                                                                     │
 * │ ── WHY A CONTENT HASH AND NOT A TIMESTAMP ───────────────────────────│
 * │   A timestamp changes on every build, including rebuilds of identical │
 * │   source. Every operator would then be told to update for nothing,    │
 * │   and a prompt that cries wolf gets dismissed by reflex — so the one  │
 * │   that matters is dismissed too.                                      │
 * │                                                                     │
 * │   Vite already content-hashes asset FILENAMES, so hashing the sorted  │
 * │   filename list plus index.html gives an id that changes when, and    │
 * │   only when, something shipped actually differs.                      │
 * │                                                                     │
 * │ ── CACHE NAMES RIDE ALONG, DELIBERATELY ─────────────────────────────│
 * │   sw.js builds its cache names from VERSION, so a new fingerprint     │
 * │   means fresh shell and asset caches and the activate handler drops   │
 * │   the old ones. That is wanted: stale entries from the previous build  │
 * │   go away. PREFS_CACHE is a fixed name and is excluded from that      │
 * │   sweep, so the chosen language survives an update.                    │
 * │                                                                     │
 * │ RUN BY                                                              │
 * │   npm run build, after vite build. Fails the build if it cannot do    │
 * │   its job, because silently shipping an unstamped worker is the bug   │
 * │   this exists to prevent.                                             │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
const SW = join(DIST, 'sw.js')

function die(message) {
  console.error(`stamp-sw: ${message}`)
  process.exit(1)
}

// ── the fingerprint ──────────────────────────────────────────────────
function fingerprint() {
  const hash = createHash('sha256')

  // index.html names the entry chunks, so it changes whenever they do.
  try {
    hash.update(readFileSync(join(DIST, 'index.html')))
  } catch {
    die('dist/index.html not found. Run `vite build` first.')
  }

  // Sorted, because readdir order is not guaranteed and an unstable order
  // would produce a different hash for an identical build.
  let names = []
  try {
    names = readdirSync(join(DIST, 'assets')).sort()
  } catch {
    die('dist/assets not found. Run `vite build` first.')
  }
  if (names.length === 0) die('dist/assets is empty.')

  // Filenames only. Vite has already hashed the CONTENT into each name, so
  // reading every file back would be slower and prove the same thing.
  for (const name of names) hash.update(name)

  // ── AND THE WORKER'S OWN SOURCE ──────────────────────────────────────
  //
  // Missing this was a real bug. public/sw.js is copied to dist/ ROOT, not into
  // dist/assets, so editing the service worker — the push handler, the caching
  // rules, the one file whose version this is — left the fingerprint unchanged.
  // A build where sw.js grew by 1600 bytes still stamped the previous id.
  //
  // The VERSION line is stripped before hashing, or this could never settle: the
  // hash would go into the file, changing the file, changing the hash.
  hash.update(source.replace(PATTERN, ''))

  return hash.digest('hex').slice(0, 12)
}

// ── stamp it ─────────────────────────────────────────────────────────
let source
try {
  source = readFileSync(SW, 'utf8')
} catch {
  die(`${SW} not found. public/sw.js should have been copied by vite build.`)
}

// Matches the literal in public/sw.js. Anchored to the start of a line so a
// mention inside a comment cannot be rewritten instead.
const PATTERN = /^const VERSION = '([^']+)'$/m
const found = source.match(PATTERN)

if (!found) {
  die(
    "could not find `const VERSION = '...'` at the start of a line in dist/sw.js.\n" +
      '  public/sw.js must keep that exact shape — the service worker cannot be\n' +
      '  versioned without it, and an unversioned worker never updates.',
  )
}

const base = found[1].split('-')[0] // 'v6' from 'v6' or from an earlier stamp
const version = `${base}-${fingerprint()}`

writeFileSync(SW, source.replace(PATTERN, `const VERSION = '${version}'`), 'utf8')

// Proof it landed, read back off disk rather than trusting the write.
const after = readFileSync(SW, 'utf8').match(PATTERN)?.[1]
if (after !== version) die(`wrote ${version} but dist/sw.js reads ${after}`)

const size = statSync(SW).size
console.log(`OK - service worker stamped ${version} (${size} bytes). A deploy now reads as an update.`)
