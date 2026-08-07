/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/lib/pushApi.js                                            │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Registers this device for Web Push, and unregisters it on sign     │
 * │   out.                                                              │
 * │                                                                     │
 * │     subscribeToPush()    after login — idempotent, safe to re-call    │
 * │     unsubscribeFromPush() before sign out                            │
 * │     pushStatus()          for a settings/diagnostic display            │
 * │                                                                     │
 * │ WHY PUSH AND NOT JUST THE IN-APP ALERT                               │
 * │   Every other channel needs the page to be running. An operator's    │
 * │   phone spends the shift in a pocket with the screen off: no page,   │
 * │   no websocket, no event, no sound. Push is delivered by the OS to   │
 * │   the service worker, which runs whether or not the app is open.     │
 * │                                                                     │
 * │ WHY UNSUBSCRIBE ON SIGN OUT IS NOT OPTIONAL                          │
 * │   A porch handset is shared. The subscription belongs to the BROWSER, │
 * │   not the person — so without this, the operator who went home keeps  │
 * │   getting "Fetch a car" for the next shift's tasks, and the person   │
 * │   actually on duty gets nothing.                                     │
 * │                                                                     │
 * │   save_push_subscription() also reassigns an existing endpoint to     │
 * │   whoever signs in next, so the handover is covered from both ends.   │
 * │                                                                     │
 * │ EVERY FAILURE HERE IS NON-FATAL                                      │
 * │   Push is an enhancement. iOS below 16.4 has no support at all, some │
 * │   Androids ship without Google Play services, and permission may be  │
 * │   denied. In every case the app must work exactly as before — the    │
 * │   in-app alerts still fire while it is open. So nothing here throws  │
 * │   and nothing blocks a login.                                        │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase, public/sw.js (the push + notificationclick handlers)  │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { supabase } from '@/supabase'

/**
 * The VAPID public key. Safe to ship — it is the public half, and the browser
 * needs it to create a subscription only this project's private key can send to.
 *
 * Set VITE_VAPID_PUBLIC_KEY in .env. Must be the same pair the push-send Edge
 * Function has, or every send is rejected with 403 VapidPkHashMismatch.
 */
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? ''

/**
 * PushManager wants the key as a Uint8Array, not base64url.
 *
 * Passing the string works on nothing — Chrome throws
 * "applicationServerKey must be an ArrayBuffer or a Uint8Array".
 */
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalised)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

/** A subscription's key, as base64url. */
function keyToB64url(subscription, name) {
  const key = subscription.getKey(name)
  if (!key) return null
  const bytes = new Uint8Array(key)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  )
}

/** For a diagnostics line: why is this device not receiving anything? */
export async function pushStatus() {
  if (!pushSupported()) return { state: 'unsupported' }
  if (!VAPID_PUBLIC_KEY) return { state: 'not_configured' }
  if (Notification.permission === 'denied') return { state: 'blocked' }
  if (Notification.permission === 'default') return { state: 'not_asked' }

  try {
    const registration = await navigator.serviceWorker.ready
    const existing = await registration.pushManager.getSubscription()
    return existing ? { state: 'subscribed', endpoint: existing.endpoint } : { state: 'granted' }
  } catch {
    return { state: 'error' }
  }
}

/**
 * Registers this device. Call after a successful login.
 *
 * Idempotent: an existing subscription is reused rather than replaced, because
 * `subscribe()` on an already-subscribed registration with the same key returns
 * the same endpoint anyway — and re-saving it refreshes last_seen_at and
 * reassigns it to whoever just signed in.
 *
 * Resolves { ok, state } and never throws.
 */
export async function subscribeToPush() {
  if (!pushSupported()) return { ok: false, state: 'unsupported' }
  if (!VAPID_PUBLIC_KEY) {
    console.warn('[push] VITE_VAPID_PUBLIC_KEY is not set — push is off.')
    return { ok: false, state: 'not_configured' }
  }
  // Not asked from here. Permission must come from a user gesture, and Login
  // already does that; asking again from a background call is ignored by
  // Chrome and burns the one chance to ask.
  if (Notification.permission !== 'granted') {
    return { ok: false, state: Notification.permission === 'denied' ? 'blocked' : 'not_asked' }
  }

  try {
    const registration = await navigator.serviceWorker.ready

    let subscription = await registration.pushManager.getSubscription()

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        // Non-negotiable on Chrome: a subscription that could deliver a silent
        // push is refused outright. Every push this app sends shows a
        // notification anyway.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
    }

    const p256dh = keyToB64url(subscription, 'p256dh')
    const auth = keyToB64url(subscription, 'auth')

    if (!p256dh || !auth) {
      return { ok: false, state: 'error' }
    }

    const { error } = await supabase.rpc('save_push_subscription', {
      p_endpoint: subscription.endpoint,
      p_p256dh: p256dh,
      p_auth: auth,
      p_user_agent: navigator.userAgent?.slice(0, 300) ?? null,
    })

    if (error) {
      console.warn('[push] could not save the subscription:', error.message)
      return { ok: false, state: 'save_failed' }
    }

    return { ok: true, state: 'subscribed' }
  } catch (err) {
    // A rejected subscribe() is common and harmless: no Play services, a
    // blocked push service, a browser in a locked-down profile.
    console.warn('[push] subscribe failed:', err)
    return { ok: false, state: 'error' }
  }
}

/**
 * Unregisters this device. Call BEFORE signing out, while the JWT is still
 * valid — delete_push_subscription needs an authenticated caller.
 *
 * Drops the browser subscription too, not just the database row. Leaving the
 * browser subscribed means the push service keeps accepting messages for an
 * endpoint nothing will ever send to, and a reinstall inherits it.
 */
/**
 * How long sign-out will wait for this before giving up on it.
 *
 * Swallowing errors is not enough to make something safe to await: a promise
 * that never settles never throws either, so the catch below can sit there for
 * ever. navigator.serviceWorker.ready is exactly that shape — it resolves when
 * a worker becomes active and simply waits when one never does.
 *
 * A shared handset holds two network round trips behind this. Signing out has
 * to feel instant, so the cleanup gets a budget and the sign-out goes ahead
 * regardless.
 */
const UNSUBSCRIBE_BUDGET_MS = 1500

export async function unsubscribeFromPush() {
  if (!pushSupported()) return { ok: true }

  const work = (async () => {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return { ok: true }

    // Database first, while still authenticated. If unsubscribe() ran first and
    // the RPC then failed, the row would be orphaned and the next shift's
    // notifications would go to a dead endpoint forever.
    await supabase.rpc('delete_push_subscription', { p_endpoint: subscription.endpoint })
    await subscription.unsubscribe().catch(() => {})

    return { ok: true }
  })()

  // The work keeps running after a timeout — it is not cancelled, just no
  // longer waited on. If it finishes a second later the row is still deleted,
  // which is the outcome that matters; the operator just did not have to stand
  // there for it.
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, timedOut: true }), UNSUBSCRIBE_BUDGET_MS),
  )

  try {
    const result = await Promise.race([work, timeout])
    if (result.timedOut) {
      console.warn(`[push] unsubscribe did not finish in ${UNSUBSCRIBE_BUDGET_MS}ms; carrying on`)
    }
    return result
  } catch (err) {
    console.warn('[push] unsubscribe failed:', err)
    return { ok: false }
  }
}
