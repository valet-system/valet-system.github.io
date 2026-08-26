/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: scripts/check-pwa-update.mjs                                  │
 * │                                                                     │
 * │ WHAT THIS CHECKS                                                    │
 * │   That the two halves of the PWA update flow still agree:            │
 * │     1. public/sw.js does NOT call skipWaiting() while installing.    │
 * │     2. src/pwa.js applyUpdate() always reaches a reload.             │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   The "Update" banner's button did nothing. Not an error, not a      │
 * │   half-update — a tap with no effect at all, reported only because   │
 * │   somebody noticed the banner would not go away.                     │
 * │                                                                     │
 * │   The cause was these two files disagreeing. src/pwa.js is built     │
 * │   around a new version WAITING so an operator mid-check-in is not    │
 * │   reloaded out of their form; the button's whole job is to end that  │
 * │   wait. But sw.js called skipWaiting() inside its install handler,   │
 * │   so the new worker never waited — it activated immediately and      │
 * │   claimed the page. By the time anyone tapped Update, pwa.js was     │
 * │   posting SKIP_WAITING to a worker that was already the controller,  │
 * │   where it is a no-op, so 'controllerchange' could never fire and    │
 * │   the reload never happened.                                        │
 * │                                                                     │
 * │   Neither file is wrong on its own reading, which is exactly why a   │
 * │   reviewer would not catch it. The contradiction only exists across  │
 * │   the two, so it needs checking across the two.                     │
 * │                                                                     │
 * │ WHAT IT CANNOT SEE                                                  │
 * │   Whether the reload actually loads the NEW build. That depends on   │
 * │   the browser's cache and the SW's fetch handler, and needs a real   │
 * │   browser: npm run build && npm run preview, then deploy twice.     │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { readFileSync } from 'node:fs'

const problems = []

// ── 1. sw.js must let a new version wait ──────────────────────────────
const sw = readFileSync('public/sw.js', 'utf8')

// Only the install handler matters. skipWaiting() in the message handler is
// the whole point — that is what the button triggers.
const installStart = sw.indexOf("self.addEventListener('install'")
if (installStart === -1) {
  problems.push('public/sw.js has no install handler — did the file move?')
} else {
  // To the next top-level addEventListener, which is 'activate'.
  const nextListener = sw.indexOf("self.addEventListener('", installStart + 10)
  const installBlock = sw.slice(installStart, nextListener === -1 ? sw.length : nextListener)

  // Strip comments first: this file EXPLAINS the bug at length inside that
  // very block, and the explanation names the call it is warning about.
  const code = installBlock.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  if (/skipWaiting\s*\(/.test(code)) {
    problems.push(
      'public/sw.js calls skipWaiting() while INSTALLING.\n' +
        '      That activates the new version immediately, so it never waits — and the\n' +
        '      Update button then posts SKIP_WAITING to a worker that is already the\n' +
        '      controller, where it does nothing. The button becomes dead.',
    )
  }
}

// A new version has to be able to take over when asked, or the button is dead
// in the other direction.
if (!/type\s*===\s*'SKIP_WAITING'/.test(sw)) {
  problems.push("public/sw.js no longer handles the 'SKIP_WAITING' message, so Update cannot work.")
}
if (!/clients\.claim\s*\(/.test(sw)) {
  problems.push('public/sw.js no longer calls clients.claim(), so an activated version never takes the page.')
}

// ── 2. applyUpdate() must always reach a reload ───────────────────────
const pwa = readFileSync('src/pwa.js', 'utf8')

const applyStart = pwa.indexOf('export function applyUpdate')
if (applyStart === -1) {
  problems.push('src/pwa.js has no applyUpdate() — did it get renamed?')
} else {
  const applyBlock = pwa.slice(applyStart, pwa.indexOf('\n}', applyStart))
  const code = applyBlock.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  // The watchdog is what guarantees a tap does SOMETHING. Without it every
  // path depends on an event that has two known states where it never fires.
  if (!/setTimeout\s*\(\s*reloadOnce/.test(code)) {
    problems.push(
      'src/pwa.js applyUpdate() has no setTimeout(reloadOnce, …) watchdog.\n' +
        '      Without it the reload depends entirely on controllerchange, which does not\n' +
        "      fire when the worker is already active or has gone redundant — and the tap\n" +
        '      then silently does nothing.',
    )
  }

  // And it must notice a worker that cannot be woken, rather than messaging it
  // and waiting.
  if (!/state\s*===\s*'activated'/.test(code)) {
    problems.push(
      "src/pwa.js applyUpdate() no longer checks for an already-'activated' worker.\n" +
        '      That was the reported bug: SKIP_WAITING to the current controller is a no-op.',
    )
  }
}

if (problems.length === 0) {
  console.log('OK - the service worker waits for the Update button, and the button always reloads.')
  process.exit(0)
}

console.error(`\n${problems.length} problem(s) in the PWA update flow:\n`)
for (const p of problems) console.error(`  - ${p}\n`)
console.error('A broken update flow is silent: the banner stays up and the tap does nothing.')
process.exit(1)
