/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/LanguageToggle.jsx                             │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   EN / हिं in the top bar. Two taps' worth of a feature and the       │
 * │   reason half the staff can use the app at all.                      │
 * │                                                                     │
 * │ ── WHY BOTH OPTIONS ARE ALWAYS VISIBLE ──────────────────────────────│
 * │   Not a dropdown, not an icon, not a settings page. Somebody who     │
 * │   cannot read English cannot find "Language" inside a menu labelled  │
 * │   "Settings" — the one control they need would be behind the words   │
 * │   they do not have. Two side-by-side buttons, each written in ITS    │
 * │   OWN script, are legible to a reader of either.                     │
 * │                                                                     │
 * │   That is also why "हिंदी" is never written as "Hindi": the person    │
 * │   looking for it is looking for the Devanagari.                      │
 * │                                                                     │
 * │ IT IS IN THE TOP BAR, WHICH IS ON EVERY SCREEN                        │
 * │   Including the login page, before anyone has signed in — see        │
 * │   src/i18n for why the preference lives in localStorage rather than  │
 * │   on the profile.                                                    │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   components/AppShell (top bar), pages/Login                          │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/i18n, utils/cn                                                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { LANGUAGES, useI18n } from '@/i18n'
import { cn } from '@/utils/cn'

/**
 * @param tone 'dark' for the app's brand-coloured top bar, 'light' for the
 *             login card, which sits on a pale background.
 */
export default function LanguageToggle({ tone = 'dark', className = '' }) {
  const { lang, setLang, t } = useI18n()

  return (
    <div
      role="group"
      aria-label={t('lang.switch')}
      className={cn(
        'flex shrink-0 items-center gap-0.5 rounded-lg p-0.5',
        tone === 'dark' ? 'bg-white/10' : 'bg-surface-sunken',
        className,
      )}
    >
      {LANGUAGES.map((option) => {
        const active = lang === option.code

        return (
          <button
            key={option.code}
            type="button"
            onClick={() => setLang(option.code)}
            aria-pressed={active}
            // The full name is the accessible name; the button shows the short
            // form because the bar has no room for "English हिंदी".
            aria-label={option.label}
            title={option.label}
            className={cn(
              // h-8 and px-2.5 keep the whole control inside the 40px bar while
              // staying a real tap target on a phone.
              'flex h-8 min-w-9 items-center justify-center rounded-md px-2.5 text-xs font-bold transition-colors',
              // The selected pill is BRAND in both tones.
              //
              // On the dark chrome this was `bg-white text-ink`, the only
              // hardcoded colour left in the app — and the moment the theme
              // inverted, text-ink became near-white and it rendered as a blank
              // white box in the top bar. Naming the role instead of the colour
              // is the whole point of the tokens; this one line was opting out.
              active
                ? tone === 'dark'
                  ? 'bg-brand text-ink-inverse'
                  : 'bg-brand text-ink-inverse'
                : tone === 'dark'
                  ? 'text-ink-inverse/70 hover:text-ink-inverse'
                  : 'text-ink-subtle hover:text-ink',
            )}
          >
            {option.short}
          </button>
        )
      })}
    </div>
  )
}
