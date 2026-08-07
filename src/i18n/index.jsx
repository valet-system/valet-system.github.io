/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/i18n/index.jsx                                            │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The language provider and the t() hook.                            │
 * │                                                                     │
 * │     const { t, lang, setLang } = useI18n()                           │
 * │     t('checkin.guestName')                                           │
 * │     t('checkin.writeOnStub', { token: 47 })                          │
 * │                                                                     │
 * │ ── WHY THE PREFERENCE IS IN localStorage, NOT THE DATABASE ──────────│
 * │   It has to survive a cold start with no network, because the LOGIN  │
 * │   screen needs it and there is no session yet to read a profile      │
 * │   from. Putting it on user_roles would mean the one screen where an  │
 * │   operator most needs Hindi is the one screen that cannot know they  │
 * │   want it.                                                          │
 * │                                                                     │
 * │   It is also per-DEVICE, which is right for a shared porch handset:  │
 * │   the phone is set to Hindi once and stays that way through every    │
 * │   shift change, instead of flipping with whoever signed in.          │
 * │                                                                     │
 * │ ── A MISSING KEY FALLS BACK TO ENGLISH, THEN TO THE KEY ─────────────│
 * │   Never to blank. A half-translated screen with English words on it  │
 * │   is usable; a screen with holes in it is not, and an operator       │
 * │   cannot report "the button has no text" usefully. In dev the        │
 * │   missing key is logged once so it gets fixed.                       │
 * │                                                                     │
 * │ ── NUMBERS STAY WESTERN ─────────────────────────────────────────────│
 * │   No Devanagari numerals anywhere. Token numbers are read aloud to   │
 * │   guests, written on paper stubs and typed back in; number plates    │
 * │   are Western digits by law. The operator must see the same glyphs   │
 * │   on the screen as on the stub in their hand.                        │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   Every screen, via useI18n(). Mounted in App.jsx ABOVE the router,  │
 * │   because Login needs it too.                                        │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { setActiveLang } from './activeLang'
import { autoTranslate } from './autoTranslate'
import { DICTIONARIES } from './translations'

const STORAGE_KEY = 'valet.lang'

// Shared with public/sw.js. Both names must match there.
const PREFS_CACHE = 'valet-prefs'
const LANG_URL = '/__lang'
export const LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'hi', label: 'हिंदी', short: 'हिं' },
]

const I18nContext = createContext(null)

/** Reads the saved choice, or guesses once from the device. */
function initialLang() {
  if (typeof window === 'undefined') return 'en'

  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved && DICTIONARIES[saved]) return saved
  } catch {
    // Private mode, or storage disabled. Fall through to the guess.
  }

  // A device already set to Hindi is a strong hint. Guessed ONCE — after the
  // first explicit choice the saved value wins, so changing the phone's
  // language later never overrides what the operator picked here.
  return navigator?.language?.toLowerCase().startsWith('hi') ? 'hi' : 'en'
}

/** Warned about once each, so a missing key is visible without flooding. */
const warned = new Set()

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(initialLang)

  // Push the code down to the non-React readers — utils/format's timeAgo and
  // friends. Done during render rather than in an effect so the very first
  // paint already formats in the right language; setActiveLang is a plain
  // assignment to a module variable, so this is safe to run repeatedly.
  setActiveLang(lang)

  const setLang = useCallback((next) => {
    if (!DICTIONARIES[next]) return
    setLangState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Not fatal: the choice simply will not survive a reload.
    }
  }, [])

  // Keep <html lang> honest. Screen readers pick a voice from it, and getting
  // it wrong makes a reader pronounce Devanagari as if it were English.
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  // ── tell the service worker, which shows the lock-screen push ────────
  //
  // A push arrives when the app is CLOSED — that is the whole point of it —
  // so the worker cannot ask a running page what language to use, and it has
  // no access to localStorage either. The Cache API is the one store both
  // sides can reach, so the choice is written there every time it changes and
  // sw.js reads it on push. Best effort: if this fails the notification is
  // simply in English, which is what it was before.
  useEffect(() => {
    if (!('caches' in window)) return
    window.caches
      .open(PREFS_CACHE)
      .then((cache) => cache.put(LANG_URL, new Response(lang)))
      .catch(() => {})
  }, [lang])

  const t = useCallback(
    (key, vars) => {
      const dict = DICTIONARIES[lang] ?? DICTIONARIES.en
      let str = dict[key]

      if (str === undefined) {
        str = DICTIONARIES.en[key]

        if (str === undefined) {
          // The key itself, never an empty string — a button with no text is
          // something nobody can describe over the phone.
          if (import.meta.env.DEV && !warned.has(key)) {
            warned.add(key)
            console.warn(`[i18n] missing key: ${key}`)
          }
          return key
        }

        if (import.meta.env.DEV && !warned.has(`${lang}:${key}`)) {
          warned.add(`${lang}:${key}`)
          console.warn(`[i18n] no ${lang} translation for: ${key}`)
        }

        // Last chance before falling back to English: the same sentence may be
        // translated under a DIFFERENT key, and autoTranslate indexes the
        // dictionary by its English text rather than by key.
        str = autoTranslate(str, lang)
      }

      if (!vars) return str

      // {name} substitution. Values are inserted as-is and NOT localised —
      // token numbers, car numbers and place names must read identically in
      // both languages.
      return str.replace(/\{(\w+)\}/g, (whole, name) =>
        vars[name] === undefined || vars[name] === null ? whole : String(vars[name]),
      )
    },
    [lang],
  )

  /**
   * Automatic conversion for text that has no key — the notification title and
   * body the DATABASE writes, and any screen still passing English literals.
   * Returns the input untouched when it is not recognised; see
   * i18n/autoTranslate for why that refusal is the important part.
   */
  const ta = useCallback((text) => autoTranslate(text, lang), [lang])

  const value = useMemo(
    () => ({ t, ta, lang, setLang, isHindi: lang === 'hi' }),
    [t, ta, lang, setLang],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>')
  return ctx
}

/** Shorthand for the common case. */
export function useT() {
  return useI18n().t
}

/**
 * The automatic converter, for English that arrived from somewhere other than
 * a t() call — chiefly the notification feed, whose sentences are composed in
 * SQL. Unrecognised text comes back unchanged.
 */
export function useAutoT() {
  return useI18n().ta
}
