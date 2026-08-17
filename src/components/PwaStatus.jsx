/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/PwaStatus.jsx                                  │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The visible half of the PWA. Three pieces:                         │
 * │     OfflineBanner   — a red strip when the network drops             │
 * │     UpdateBanner    — "new version ready" with an Update button      │
 * │     InstallPrompt   — an "Install app" card, dismissible             │
 * │   PwaStatus renders offline + update; InstallPrompt is placed by a    │
 * │   page (Login) so it appears at a sensible moment.                    │
 * │                                                                     │
 * │ WHY THE OFFLINE BANNER IS NOT OPTIONAL                                │
 * │   This is the most important component in the PWA layer. Operators   │
 * │   work in basement car parks where signal dies without warning. When  │
 * │   it does, every tap fails silently — the card does not update, and  │
 * │   the operator's reasonable conclusion is "the app is broken", so     │
 * │   they tap again, and again. Then signal returns and four queued      │
 * │   requests land at once.                                             │
 * │                                                                     │
 * │   A persistent red strip converts that into "I have no signal, I     │
 * │   will walk to the ramp and retry" — a decision they can act on.     │
 * │                                                                     │
 * │ WHY THE OFFLINE BANNER SITS AT THE BOTTOM                              │
 * │   Toasts occupy the top of the screen (see ToastContext) and would   │
 * │   cover it. It sits at the bottom edge instead, where it is out of    │
 * │   stays visible without hiding either the nav or the primary action.  │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   App.jsx mounts <PwaStatus/> once, outside the router so it survives │
 * │   navigation. Login renders <InstallPrompt/>.                         │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/pwa (the browser-facing logic), ui/Icon, ui/Button, utils/cn    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useState } from 'react'
import Icon from '@/components/ui/Icon'
import { useT } from '@/i18n'
import Button from '@/components/ui/Button'
import { cn } from '@/utils/cn'
import {
  applyUpdate,
  isOnline,
  isStandalone,
  onInstallable,
  onOnlineChange,
  onUpdateReady,
  promptInstall,
} from '@/pwa'

/** Mount once in App.jsx. Renders nothing when everything is normal. */
export default function PwaStatus() {
  return (
    <>
      <OfflineBanner />
      <UpdateBanner />
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════
// OFFLINE
// ═══════════════════════════════════════════════════════════════════

export function OfflineBanner() {
  const t = useT()
  const [online, setOnline] = useState(isOnline)

  useEffect(() => onOnlineChange(setOnline), [])

  if (online) return null

  return (
    <div
      // aria-live="assertive": losing connectivity is worth interrupting a
      // screen reader for, because every subsequent action will fail.
      role="status"
      aria-live="assertive"
      className={cn(
        'fixed inset-x-0 z-[90] flex items-center justify-center gap-2 px-4 py-2.5',
        'bg-danger text-sm font-semibold text-white shadow-raised',
        // Flush to the bottom. It used to be lifted 64px to clear the mobile
        // tab bar; that bar is gone — navigation is a drawer now — so the
        // offset would just be a floating strip with a gap under it. The
        // safe-area inset stays, because the iOS home indicator has not gone
        // anywhere.
        'bottom-0 pb-[env(safe-area-inset-bottom)]',
      )}
    >
      <Icon name="bell-off" size={17} strokeWidth={2} />
      <span>{t('pwa.noInternet')}</span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// UPDATE AVAILABLE
// ═══════════════════════════════════════════════════════════════════

export function UpdateBanner() {
  const t = useT()
  const [ready, setReady] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => onUpdateReady(setReady), [])

  if (!ready || dismissed) return null

  return (
    <div
      className={cn(
        'fixed inset-x-0 z-[91] mx-auto flex max-w-md animate-slide-up items-center gap-3',
        'rounded-xl border border-line bg-surface px-4 py-3 shadow-pop',
        // Same story as the offline strip: no tab bar left to clear, so this
        // sits a normal margin off the bottom edge on every size.
        'bottom-[calc(1rem+env(safe-area-inset-bottom))] left-3 right-3',
      )}
      role="status"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info-soft text-info">
        <Icon name="download" size={18} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{t('pwa.newVersion')}</p>
        <p className="text-xs text-ink-subtle">{t('pwa.finishFirst')}</p>
      </div>

      {/* "Later" exists so an operator mid-check-in is never forced to reload
          and lose the form they are typing. */}
      <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
        {t('pwa.later')}
      </Button>
      <Button variant="primary" size="sm" onClick={applyUpdate}>
        {t('pwa.update')}
      </Button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// INSTALL
// ═══════════════════════════════════════════════════════════════════

/** localStorage key so a dismissal survives a reload — asking again every
 *  page load is how users learn to ignore a prompt entirely. */
const DISMISS_KEY = 'valet-install-dismissed'

export function InstallPrompt({ className = '' }) {
  const t = useT()
  const [canInstall, setCanInstall] = useState(false)
  const [hidden, setHidden] = useState(() => localStorage.getItem(DISMISS_KEY) === '1')

  useEffect(() => onInstallable(setCanInstall), [])

  // Already installed -> nothing to offer.
  if (isStandalone() || !canInstall || hidden) return null

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1')
    setHidden(true)
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card',
        className,
      )}
    >
      {/* On the login screen this card sits directly under the new lockup, so
          the old glyph here was the most visible mismatch of the three. */}
      <span className="flex h-10 w-[4.5rem] shrink-0 items-center justify-center rounded-lg bg-logo-plate px-2">
        {/* The size public/logo-mark.png is actually emitted at — see the sizes
            printed by `npm run logo`. These only reserve the aspect ratio before
            the image loads, so a stale pair costs a visible jump on load, not a
            broken image, which is why they drifted unnoticed once already. */}
        <img
          src="/logo-mark.png"
          alt=""
          aria-hidden="true"
          width={220}
          height={81}
          className="h-auto w-full"
        />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{t('pwa.installTitle')}</p>
        <p className="text-xs leading-snug text-ink-subtle">
          {t('pwa.installBody')}
        </p>
      </div>

      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          const outcome = await promptInstall()
          // Dismissing the native dialog means "not now", so stop asking.
          if (outcome !== 'accepted') dismiss()
        }}
      >
        {t('pwa.installShort')}
      </Button>

      <button
        type="button"
        onClick={dismiss}
        aria-label={t('pwa.dismissInstall')}
        className="-mr-1 shrink-0 rounded-md p-1 text-ink-subtle transition-colors hover:bg-line/60 hover:text-ink"
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}
