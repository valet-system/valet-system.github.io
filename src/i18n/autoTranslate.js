/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/i18n/autoTranslate.js                                     │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Automatic English → Hindi for text that arrives at RUNTIME and has │
 * │   no translation key to look up.                                     │
 * │                                                                     │
 * │     autoTranslate('Car requested', 'hi')      -> 'गाड़ी माँगी गई'      │
 * │     autoTranslate('Token 47 · 4821 · B2','hi')-> 'टोकन 47 · 4821 · B2'│
 * │                                                                     │
 * │ ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────│
 * │   t('some.key') only works for text WE write in JSX. Two sources of  │
 * │   English are not like that:                                        │
 * │                                                                     │
 * │     1. The database. enqueue_task_push() (migrations 0014 and 0019)  │
 * │        composes the notification title and body in SQL and stores    │
 * │        them in push_outbox. By the time the bell renders them they   │
 * │        are already finished English sentences.                       │
 * │     2. Screens not yet keyed, where an English literal is passed     │
 * │        straight to a component.                                     │
 * │                                                                     │
 * │ ── HOW IT WORKS, AND WHY IT IS SAFE ─────────────────────────────────│
 * │   NOT machine translation. There is no API call, nothing to pay for, │
 * │   and it works with the phone in flight mode — which matters,        │
 * │   because a push arriving on a locked phone in a basement is exactly │
 * │   the case this is for.                                             │
 * │                                                                     │
 * │   It is a lookup, and the table builds ITSELF from the dictionaries  │
 * │   in translations.js: every English value there becomes a key        │
 * │   pointing at its Hindi twin. Translate a string once for a screen   │
 * │   and the same sentence is auto-converted everywhere else, for free  │
 * │   and permanently in sync.                                          │
 * │                                                                     │
 * │   Entries with {vars} compile to patterns, so 'Token {token}         │
 * │   requested' matches 'Token 47 requested' and puts the 47 back.      │
 * │                                                                     │
 * │ ── THE PART THAT MATTERS MOST: WHAT IT REFUSES TO TOUCH ─────────────│
 * │   Anything it does not recognise comes back UNCHANGED. Never a       │
 * │   guess, never a partial word-by-word mangle.                        │
 * │                                                                     │
 * │   That is a correctness requirement, not caution. The notification   │
 * │   body is 'Token 47 · 4821 · Basement 2' — a token, a number plate,  │
 * │   and a place name the admin typed themselves. A translator that     │
 * │   had a go at "Basement 2" would be rewriting data. So the body is   │
 * │   split on ' · ' and each piece is looked up on its own: the parts   │
 * │   we wrote get converted, the parts a human or a car owns are left   │
 * │   exactly as they are.                                              │
 * │                                                                     │
 * │ SEE ALSO                                                            │
 * │   public/sw.js carries a HAND-COPIED subset of SERVER_PHRASES,       │
 * │   because a service worker woken by a push cannot import this file.  │
 * │   Change one, change the other — the header there says so too.       │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   i18n/index.jsx (exposes it as useAutoT), components/NotificationBell│
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   ./translations                                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { en, hi } from './translations.js'

/**
 * Text the DATABASE writes, which therefore has no key in translations.js.
 *
 * Every line here is a literal lifted out of a migration — the comment says
 * which. If you change the SQL, change this, or the bell quietly goes back to
 * English.
 *
 * KEEP IN SYNC WITH public/sw.js.
 */
const SERVER_PHRASES = {
  // ── titles: migration 0014 (push_notifications) ────────────────────
  'Car requested': 'गाड़ी माँगी गई',
  'Fetch a car': 'गाड़ी लानी है',
  'Guest did not arrive': 'गेस्ट नहीं आए',
  // ── title: migration 0019 (car_parked_push) ────────────────────────
  'Car parked': 'गाड़ी पार्क हो गई',
  // ── title: migration 0023 (car_delivered_push) ─────────────────────
  'Car delivered': 'गाड़ी गेस्ट को दे दी',
  // ── title: migration 0025 (car_reparked_push) ──────────────────────
  'Car re-parked': 'गाड़ी दोबारा पार्क हो गई',

  // ── body fragments ─────────────────────────────────────────────────
  // The coalesce fallback when a car has no number plate recorded.
  car: 'गाड़ी',
  'park it again and confirm the spot': 'दोबारा पार्क करके जगह बताइए',

  // ── what the service worker shows when a payload arrives empty ─────
  'Ambria Valet': 'एंब्रिया वैले',
  'You have a new task.': 'आपके लिए नया काम है।',
}

/**
 * Templated text, where a number or a name sits in the middle.
 *
 * Written by hand only for the shapes the DATABASE produces. Everything
 * templated on the app side is generated from the dictionary below instead.
 */
const SERVER_PATTERNS = [
  // 'Token 47', and 'Token ?' when the vehicle row could not be read.
  [/^Token (\d+|\?)$/, (m) => `टोकन ${m[1]}`],
  // 'by Rajesh' — who parked or delivered the car (migration 0024). The name
  // itself is never touched; only the preposition around it is.
  [/^by (.+)$/, (m) => `${m[1]} ने`],
]

// ═══════════════════════════════════════════════════════════════════
// THE TABLE, BUILT FROM THE DICTIONARIES
// ═══════════════════════════════════════════════════════════════════

/** Exact English sentence -> Hindi sentence. */
const EXACT = new Map()

/** [regex, hiTemplate, varNames] for dictionary entries containing {vars}. */
const PATTERNS = []

/**
 * English strings that mean two different things in two places, so converting
 * them automatically would be a coin flip. Dropped rather than guessed.
 */
const AMBIGUOUS = new Set()

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildTable() {
  for (const [key, english] of Object.entries(en)) {
    const hindi = hi[key]
    // No Hindi for this key, or Hindi that is just the English again (VIP,
    // +91) — nothing to gain, and an identity entry only costs lookups.
    if (!hindi || hindi === english) continue

    if (english.includes('{')) {
      const varNames = [...english.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
      // A template that is nothing BUT a variable ('{n}') would match every
      // string in the app and replace it with itself. Useless and dangerous.
      if (!english.replace(/\{\w+\}/g, '').trim()) continue

      const source = escapeRegex(english).replace(/\\\{(\w+)\\\}/g, '(.+?)')
      PATTERNS.push([new RegExp(`^${source}$`), hindi, varNames])
      continue
    }

    const existing = EXACT.get(english)
    if (existing !== undefined && existing !== hindi) {
      // Two keys, same English, different Hindi. Which one is right depends on
      // the screen, and we do not know the screen here.
      AMBIGUOUS.add(english)
      EXACT.delete(english)
      continue
    }
    if (!AMBIGUOUS.has(english)) EXACT.set(english, hindi)
  }

  // The database's own wording wins over anything inferred from the
  // dictionary: it is the exact sentence, written for exactly this case.
  for (const [english, hindi] of Object.entries(SERVER_PHRASES)) {
    EXACT.set(english, hindi)
  }
}

buildTable()

// ═══════════════════════════════════════════════════════════════════
// LOOKUP
// ═══════════════════════════════════════════════════════════════════

/** One segment: exact, then patterns, then give up and return it untouched. */
function convertSegment(segment) {
  const trimmed = segment.trim()
  if (!trimmed) return segment

  const exact = EXACT.get(trimmed)
  if (exact !== undefined) return exact

  for (const [regex, replacer] of SERVER_PATTERNS) {
    const match = trimmed.match(regex)
    if (match) return replacer(match)
  }

  for (const [regex, template, varNames] of PATTERNS) {
    const match = trimmed.match(regex)
    if (!match) continue

    // Put the captured values back by NAME, because Hindi reorders: English
    // '{n} of {total} left' becomes '{total} में से {n} बचे'.
    const values = {}
    varNames.forEach((name, i) => {
      values[name] = match[i + 1]
    })
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
      values[name] === undefined ? whole : values[name],
    )
  }

  // Unrecognised. A car number, a guest name, a place the admin typed — or a
  // sentence nobody has translated yet. All three are better in English than
  // mangled.
  return segment
}

/**
 * @param text  any English string, or null
 * @param lang  the active language code
 * @returns Hindi where it is known, the input otherwise. Never null for a
 *          non-null input, never a partial word-salad.
 */
export function autoTranslate(text, lang) {
  if (lang !== 'hi' || !text || typeof text !== 'string') return text

  // Whole string first: some sentences contain ' · ' themselves.
  const whole = EXACT.get(text.trim())
  if (whole !== undefined) return whole

  if (!text.includes(' · ')) return convertSegment(text)

  // ' · ' is how the SQL joins the parts of a notification body, and the parts
  // are independent: 'Token 47' is ours, '4821' is the car's, 'Basement 2' is
  // the admin's. Converting them separately is what keeps the last two intact.
  return text
    .split(' · ')
    .map(convertSegment)
    .join(' · ')
}

/** For tests and for the dev console. */
export const __table = { EXACT, PATTERNS, AMBIGUOUS }
