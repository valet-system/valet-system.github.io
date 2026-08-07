/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/i18n/activeLang.js                                        │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The current language code, readable from code that is not a React │
 * │   component. Four lines of state, and it exists for exactly one     │
 * │   reason.                                                          │
 * │                                                                     │
 * │ ── WHY NOT JUST USE useI18n() ───────────────────────────────────────│
 * │   utils/format is a plain module — timeAgo(), formatMinutes(),       │
 * │   formatDate() — called from about forty places, most of them inside │
 * │   JSX expressions rather than at the top of a component. Threading a │
 * │   t() through all of them would mean touching every call site to     │
 * │   translate three phrases ("just now", "5 min ago", "2 h ago").      │
 * │                                                                     │
 * │   So the provider PUSHES the language here whenever it changes, and  │
 * │   format.js READS it. One writer, many readers.                      │
 * │                                                                     │
 * │ ── THE ONE THING TO KNOW ────────────────────────────────────────────│
 * │   This is not reactive. Nothing re-renders when it changes. That is  │
 * │   fine for the things that read it: timeAgo output is recomputed on  │
 * │   the next render anyway, and the provider's own setState is what    │
 * │   triggers that render. It would NOT be fine to build a component    │
 * │   that reads this instead of useI18n() — that component would go     │
 * │   stale. Use the hook in components. Always.                         │
 * │                                                                     │
 * │ ── WHY ITS OWN FILE ─────────────────────────────────────────────────│
 * │   utils/format cannot import from i18n/index.jsx: index.jsx pulls in │
 * │   React and the dictionaries, and format.js is imported by almost    │
 * │   everything, so that edge would be a cycle. This module imports     │
 * │   nothing at all, so it can never be part of one.                    │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   i18n/index.jsx (writes), utils/format (reads)                      │
 * └─────────────────────────────────────────────────────────────────────┘
 */

/**
 * Defaults to English so anything that runs before the provider mounts still
 * returns readable text rather than undefined.
 */
let active = 'en'

export function setActiveLang(code) {
  active = code
}

export function getActiveLang() {
  return active
}

/** Sugar for the `cond ? hi : en` shape that every caller in format.js uses. */
export function pickLang(en, hi) {
  return active === 'hi' ? hi : en
}
