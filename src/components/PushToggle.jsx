/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/PushToggle.jsx                                 │
 * │                                                                     │
 * │ WHAT THIS IS                                                        │
 * │   The "Push notifications" control in the account menu: says whether │
 * │   alerts reach THIS device when the app is closed, and turns them on │
 * │   or off.                                                           │
 * │                                                                     │
 * │ ── WHY IT HAS TO EXIST ──────────────────────────────────────────────│
 * │   Permission was asked in exactly ONE place: the login screen. So an │
 * │   operator who dismissed that prompt had no way back, and one who was│
 * │   already signed in — sessions last weeks — was never asked at all.  │
 * │   Nine of ten active staff had no device registered. Not a delivery  │
 * │   bug: nobody had ever been given the chance to say yes, and nothing │
 * │   on screen said so.                                                 │
 * │                                                                     │
 * │ ── SHAPED AFTER THE AMBRIA ADMIN APP, DELIBERATELY ──────────────────│
 * │   Same layout (title, one line of why, an action button on the        │
 * │   right), same five states, and the same wording where it fits. That │
 * │   app's operators already know this control; making ours behave       │
 * │   differently would be a second thing to learn for no gain.          │
 * │                                                                     │
 * │   One addition it does not have: the iPhone case below.               │
 * │                                                                     │
 * │ ── WHY A BUTTON AND NOT AN AUTOMATIC ASK ────────────────────────────│
 * │   Notification.requestPermission() only works from a real user        │
 * │   gesture — Chrome ignores it otherwise, and a dismissed prompt       │
 * │   counts against the site, so asking on every launch burns the one    │
 * │   chance and can get the origin blocked for good.                     │
 * │                                                                     │
 * │ ── THE iPHONE RULE THAT CATCHES EVERYONE ────────────────────────────│
 * │   On iOS, web push works ONLY from a PWA on the Home Screen. In a     │
 * │   Safari tab there is no prompt to accept and no push, ever. So there │
 * │   the button is withheld and the reason is given instead — a control  │
 * │   that cannot work teaches people the app is broken.                  │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   lib/pushApi, pwa (isStandalone), utils/sounds, i18n                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useState } from 'react'
import Button from '@/components/ui/Button'
import { pushStatus, subscribeToPush, unsubscribeFromPush } from '@/lib/pushApi'
import { isStandalone } from '@/pwa'
import { requestNotificationPermission } from '@/utils/sounds'
import { useT } from '@/i18n'

/**
 * iPhone/iPad, including iPadOS which reports itself as a Mac.
 *
 * Only decides which SENTENCE to show, never gates behaviour — so a
 * mis-detection costs a slightly wrong hint, not a broken feature.
 */
function isApple() {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

export default function PushToggle() {
  const t = useT()
  const [state, setState] = useState(null)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    setState((await pushStatus()).state)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function toggle() {
    setFailed(false)

    if (state === 'subscribed') {
      await unsubscribeFromPush()
      await refresh()
      return
    }

    // The gesture is THIS click. Ask first, subscribe second — subscribing
    // before permission is granted just returns 'not_asked'.
    const permission = await requestNotificationPermission()
    if (permission !== 'granted') {
      await refresh()
      return
    }
    const result = await subscribeToPush()
    setFailed(!result?.ok)
    await refresh()
  }

  // Nothing until the first check lands: a row that flips from off to on reads
  // as though opening the menu changed something.
  if (state === null) return null

  // Hidden exactly where the Ambria Admin app hides it — there is nothing the
  // operator can do about either case.
  if (state === 'unsupported' || state === 'not_configured') return null

  const on = state === 'subscribed'
  const blocked = state === 'blocked'
  const iosNeedsInstall = isApple() && !isStandalone()

  const hint = iosNeedsInstall
    ? t('push.installHint')
    : blocked
      ? t('push.blockedHint')
      : failed
        ? t('push.failed')
        : t('push.hint')

  return (
    <div className="px-3 py-2">
      <p className="text-sm font-semibold text-ink">{t('push.title')}</p>

      <p
        className={cnHint(blocked || failed)}
        // Read out with the button, so a screen reader gets the reason and the
        // control together rather than a bare "Enable".
      >
        {hint}
      </p>

      {/* Withheld on an uninstalled iPhone: it cannot succeed there, and the
          hint above already says what to do instead. */}
      {!iosNeedsInstall && (
        <Button
          variant={on ? 'ghost' : 'primary'}
          size="sm"
          fullWidth
          disabled={blocked}
          onClick={toggle}
          loadingText={on ? t('push.turningOff') : t('push.turningOn')}
          className="mt-2"
        >
          {on ? t('push.turnOff') : t('push.enable')}
        </Button>
      )}
    </div>
  )
}

/** The hint turns red only when it is reporting a problem. */
function cnHint(isProblem) {
  return `mt-0.5 text-xs leading-relaxed ${isProblem ? 'text-danger' : 'text-ink-subtle'}`
}
