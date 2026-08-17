/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ThemeToggle.jsx                                │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   One button in the top bar that flips between light and dark.       │
 * │                                                                     │
 * │ ── TWO STATES, NOT THREE ────────────────────────────────────────────│
 * │   This cycled light → dark → system, and on a phone already set to   │
 * │   dark that showed DARK TWICE — once chosen, once inherited. Two of  │
 * │   three stops looked the same, so the control read as broken.        │
 * │                                                                     │
 * │   Following the device is still the DEFAULT for somebody who has     │
 * │   never tapped it (see utils/theme), it just is not a stop on the    │
 * │   toggle any more.                                                  │
 * │                                                                     │
 * │ ── WHY IT IS NOT ON THE LOGIN SCREEN ────────────────────────────────│
 * │   It is: LanguageToggle already sits there and this goes beside it.   │
 * │   Somebody signing in at night should not have to sign in first to    │
 * │   turn the lights down.                                             │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   components/AppShell (top bar), pages/Login                         │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useState } from 'react'
import Icon from '@/components/ui/Icon'
import { useT } from '@/i18n'
import { cn } from '@/utils/cn'
import { getResolved, subscribe, toggleTheme } from '@/utils/theme'

export default function ThemeToggle({ tone = 'dark', className = '' }) {
  const t = useT()
  const [resolved, setResolved] = useState(getResolved)

  useEffect(() => subscribe(setResolved), [])

  // The icon reports what is ON now; the accessible name says what tapping will
  // do. Same split as the PIN reveal button.
  const icon = resolved === 'dark' ? 'moon' : 'sun'

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={t(resolved === 'dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
      title={t(`theme.${resolved}`)}
      className={cn(
        'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors',
        tone === 'dark'
          ? 'text-ink-inverse/70 hover:bg-white/10 hover:text-ink-inverse'
          : 'text-ink-subtle hover:bg-surface-sunken hover:text-ink',
        className,
      )}
    >
      <Icon name={icon} size={19} />
    </button>
  )
}

/**
 * The same control as a full-width MENU ROW, for the account menu on a phone.
 *
 * A 40px icon button is right in a toolbar and wrong in a list: the rows either
 * side of it are labelled ("Change PIN", "Sign out"), and an unlabelled icon
 * among them is the one item nobody taps because nobody is sure what it does.
 * So this says what it is, shows what is on, and cycles on tap.
 *
 * Shares its state with the toolbar version through utils/theme — there is one
 * preference, not one per control, and subscribing means changing it in the
 * drawer updates the bar behind it without a reload.
 */
export function ThemeRow({ className = '' }) {
  const t = useT()
  const [resolved, setResolved] = useState(getResolved)

  useEffect(() => subscribe(setResolved), [])

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-[0.9375rem] font-medium',
        'text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink',
        className,
      )}
    >
      <Icon name={resolved === 'dark' ? 'moon' : 'sun'} size={19} className="shrink-0" />
      {/* truncate, not just min-w-0: without it this label had nothing to give
          and the value on the right printed straight over the top of it. */}
      <span className="min-w-0 flex-1 truncate text-left">{t('theme.appearance')}</span>
      {/* The CURRENT setting, on the right, the way a settings row reads
          everywhere else — "Appearance … Dark". Without it the row says what it
          controls and not what it is set to, which is half a control.
          The SHORT form of 'system': the menu is 256px wide and "Following your
          device" does not fit beside a label, which is exactly how it ended up
          overlapping. */}
      <span className="shrink-0 text-xs font-semibold text-ink-subtle">
        {t(`theme.${resolved}`)}
      </span>
    </button>
  )
}
