/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/utils/theme.js                                            │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Which of the two palettes in index.css is on.                      │
 * │                                                                     │
 * │     getResolved()    'light' | 'dark'   — what is SHOWING            │
 * │     toggleTheme()                       — flip it, the only action   │
 * │     subscribe(fn)                                                    │
 * │                                                                     │
 * │ ── THREE VALUES INSIDE, TWO ON THE TOGGLE ───────────────────────────│
 * │   getPreference() can also return 'system', which is what somebody   │
 * │   who has never tapped the toggle has: a phone set to dark opens the │
 * │   app dark, and follows the OS if that changes at sunset.            │
 * │                                                                     │
 * │   But 'system' is NOT a stop on the control. It was, and on a phone  │
 * │   already dark the cycle showed dark twice — once chosen, once        │
 * │   inherited — so two of three stops were indistinguishable and the   │
 * │   toggle looked broken. toggleTheme() flips whatever is on screen to │
 * │   its opposite and stores that, so tapping always visibly changes    │
 * │   something.                                                         │
 * │                                                                     │
 * │ ── WHY THIS WRITES A CONCRETE ATTRIBUTE ─────────────────────────────│
 * │   index.css has ONE dark block, keyed on [data-theme='dark']. The    │
 * │   usual alternative needs the dark palette written twice — once in a │
 * │   prefers-color-scheme media query, once for the override — and two  │
 * │   copies of forty values drift. So 'system' is resolved HERE and a   │
 * │   concrete light/dark is written onto <html>. See the note in        │
 * │   index.css.                                                        │
 * │                                                                     │
 * │ ── THE FLASH ────────────────────────────────────────────────────────│
 * │   Nothing here runs before the first paint, so on its own this shows │
 * │   a light page for one frame before turning dark. The inline script  │
 * │   in index.html applies the attribute first; this module then agrees │
 * │   with it. Both read the same key and the same fallback — if you     │
 * │   change one, change the other.                                     │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   components/ThemeToggle, main.jsx                                   │
 * └─────────────────────────────────────────────────────────────────────┘
 */

/** Shared with the inline script in index.html. Keep both in step. */
export const THEME_KEY = 'valet-theme'

const listeners = new Set()

function systemPrefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/** What the operator chose. 'system' when they have never chosen. */
export function getPreference() {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    // Private mode, or storage disabled. Follow the system and carry on —
    // a theme is not worth an exception on boot.
    return 'system'
  }
}

/** What is actually on screen right now. */
export function getResolved() {
  const preference = getPreference()
  if (preference !== 'system') return preference
  return systemPrefersDark() ? 'dark' : 'light'
}

function apply() {
  document.documentElement.dataset.theme = getResolved()
  for (const fn of listeners) fn(getResolved())
}

/**
 * Flips to the opposite of what is ON SCREEN, and stores that.
 *
 * ── WHY THIS AND NOT A THREE-WAY CYCLE ────────────────────────────────
 * It was light → dark → system, and on a phone already set to dark that
 * showed DARK TWICE: once as the explicit choice and once as 'system'
 * resolving to it. Two of the three stops looked identical, so the control
 * read as broken.
 *
 * 'system' still exists — it is what an operator who has never touched this
 * gets, so a phone on dark opens the app dark — but it is no longer a stop on
 * the toggle. Flipping from it lands on a concrete choice, which is what
 * somebody reaching for the toggle wants.
 */
export function toggleTheme() {
  setPreference(getResolved() === 'dark' ? 'light' : 'dark')
}

export function setPreference(preference) {
  try {
    if (preference === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, preference)
  } catch {
    // Not fatal: the theme still applies for this session, it just will not
    // survive a reload. Better than refusing to switch at all.
  }
  apply()
}

/** Called once from main.jsx. */
export function initTheme() {
  apply()

  // Follow the OS while the choice is 'system' — a phone that goes dark at
  // sunset takes the app with it, without a reload.
  const query = window.matchMedia?.('(prefers-color-scheme: dark)')
  query?.addEventListener?.('change', () => {
    if (getPreference() === 'system') apply()
  })
}

/** @returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
