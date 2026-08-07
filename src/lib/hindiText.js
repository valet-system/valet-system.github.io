/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/lib/hindiText.js                                          │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Turns "Rajesh Kumar" into "राजेश कुमार". One job, one function.    │
 * │                                                                     │
 * │ ── TRANSLITERATION, NOT TRANSLATION. THIS IS THE WHOLE POINT ────────│
 * │   Translation converts MEANING. Transliteration converts SOUND.      │
 * │   For a person's name only the second one is correct:                │
 * │                                                                     │
 * │     translate("Kumar")      -> a word meaning "prince"               │
 * │     transliterate("Kumar")  -> कुमार                                  │
 * │                                                                     │
 * │   The first is not a slightly worse answer, it is a different word.  │
 * │   Anything here that reaches for a translate endpoint is a bug.      │
 * │                                                                     │
 * │ ── IT IS A FIRST DRAFT, NEVER THE STORED ANSWER ─────────────────────│
 * │   Every caller must let a human overwrite the result before it is    │
 * │   saved — ui/HindiInput is built around exactly that. Names are the  │
 * │   thing people are most particular about, and a machine gets a good  │
 * │   number of them subtly wrong.                                       │
 * │                                                                     │
 * │ ── EVERY FAILURE PATH RETURNS EMPTY, NEVER THROWS AT THE CALLER ─────│
 * │   …except AbortError, which is re-thrown, because that one means     │
 * │   "you cancelled this on purpose" and swallowing it would let a slow │
 * │   earlier request overwrite a fast later one. See HindiInput.        │
 * │                                                                     │
 * │   A failed conversion must never block saving a staff member. The    │
 * │   column is nullable and the reader falls back to the English name,  │
 * │   so "no Hindi yet" is a perfectly good state to be in.              │
 * │                                                                     │
 * │ ── THE ENDPOINT ─────────────────────────────────────────────────────│
 * │   Google's input-tools transliteration endpoint. Free, unauthen-     │
 * │   ticated, undocumented: it rate-limits and it could disappear. That │
 * │   is survivable precisely because of the paragraph above — if it     │
 * │   goes, the field still works, the admin just types the Devanagari   │
 * │   themselves. To move to a paid service, replace the body of         │
 * │   transliterateToHindi and change nothing else.                      │
 * │                                                                     │
 * │   The text sent is a staff name. Nothing else from this app should   │
 * │   be sent to a third party without thinking about it first — guest   │
 * │   names and phone numbers in particular must not go anywhere near    │
 * │   here.                                                             │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   components/ui/HindiInput                                           │
 * └─────────────────────────────────────────────────────────────────────┘
 */

/** True if the string still contains Latin letters. */
export function hasLatin(text) {
  return /[A-Za-z]/.test(text || '')
}

/** True if the string contains Devanagari — i.e. somebody already typed Hindi. */
export function hasDevanagari(text) {
  return /[ऀ-ॿ]/.test(text || '')
}

const ENDPOINT = 'https://inputtools.google.com/request'

/**
 * @param text    a name in Latin letters
 * @param signal  an AbortSignal; pass one, and abort it when the input changes
 * @returns the Devanagari spelling
 * @throws on abort, on a network failure, or on an unusable response
 */
export async function transliterateToHindi(text, signal) {
  const q = (text || '').trim()
  if (!q) return ''

  const url =
    `${ENDPOINT}?text=${encodeURIComponent(q)}` +
    // itc=hi-t-i0-und is the Hindi transliteration model. num=1 asks for a
    // single candidate — the UI shows one draft, not a picker.
    '&itc=hi-t-i0-und&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8'

  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`transliterate http ${res.status}`)

  const json = await res.json()

  // Shape: ["SUCCESS", [[ "input", ["candidate"] ]]]. Undocumented, so every
  // level is checked rather than indexed into hopefully — a shape change must
  // surface as "could not convert", not as `undefined` written to the column.
  if (!Array.isArray(json) || json[0] !== 'SUCCESS') {
    throw new Error('transliterate failed')
  }

  const out = json?.[1]?.[0]?.[1]?.[0]
  if (!out) throw new Error('transliterate returned nothing')

  return toWesternDigits(String(out).trim())
}

/**
 * Devanagari numerals back to Western ones: "तेस्त२" -> "तेस्त2".
 *
 * The endpoint converts digits along with the letters, and this app does not
 * want that anywhere — see the NUMBERS STAY WESTERN note in src/i18n. A staff
 * name rarely contains a digit, but when it does ("Ramesh 2", "Guard 3") it is
 * an identifier people say out loud and match against a roster, and a
 * Devanagari 2 is not the same character to search for.
 */
function toWesternDigits(text) {
  return text.replace(/[०-९]/g, (d) => String('०१२३४५६७८९'.indexOf(d)))
}

/**
 * The safe wrapper for anything that is not the live input field.
 *
 * Returns null on every failure and never throws, so it can sit on a save path
 * without a try/catch around it. Skips input that is already Devanagari:
 * pushing Hindi back through an English→Hindi model is how "राजेश" comes back
 * mangled.
 */
export async function hindiNameFor(name) {
  const q = (name || '').trim()
  if (!q || !hasLatin(q) || hasDevanagari(q)) return null

  try {
    return (await transliterateToHindi(q)) || null
  } catch {
    return null
  }
}
