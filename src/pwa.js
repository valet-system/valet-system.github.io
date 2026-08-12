/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pwa.js                                                    │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The page-side half of the PWA. Registers public/sw.js, watches     │
 * │   for a newer version, and exposes small subscribe helpers the UI     │
 * │   uses to show banners:                                             │
 * │     registerServiceWorker()  — call once from main.jsx               │
 * │     onUpdateReady(cb)        — a new version is waiting              │
 * │     applyUpdate()            — activate it and reload                │
 * │     onOnlineChange(cb)      — network came back / went away          │
 * │     onInstallable(cb)       — the browser will allow an install       │
 * │     promptInstall()         — show the native install dialog         │
 * │     isStandalone()          — are we running as an installed app?     │
 * │                                                                     │
 * │ WHY UPDATES ARE PROMPTED, NOT AUTOMATIC                               │
 * │   The usual PWA pattern is to auto-activate a new version and reload. │
 * │   Here that would mean an operator halfway through typing a guest's   │
 * │   details has the page reloaded under them and loses the form. So a   │
 * │   new version WAITS, a banner appears, and the operator chooses when. │
 * │                                                                     │
 * │ WHY THE INSTALL PROMPT IS CAPTURED RATHER THAN LEFT ALONE             │
 * │   Chrome fires `beforeinstallprompt` once, early, and if you do not   │
 * │   preventDefault() and keep the event you can never show the install  │
 * │   dialog yourself. We stash it so an "Install app" button can appear  │
 * │   inside the app at a sensible moment instead of relying on the       │
 * │   browser's own easily-missed address-bar icon.                       │
 * │                                                                     │
 * │ WHY INSTALLING MATTERS FOR THIS APP SPECIFICALLY                       │
 * │   Installed, it runs without browser chrome (more screen for task     │
 * │   cards), gets its own launcher icon so an operator does not hunt for │
 * │   a tab, and — the real reason — a standalone window is far less      │
 * │   likely to be discarded by Android to save memory mid-shift, which   │
 * │   would silently kill the realtime subscription.                     │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   src/main.jsx (registration), components/PwaStatus.jsx (banners)     │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   Nothing.                                                          │
 * └─────────────────────────────────────────────────────────────────────┘
 */

/** The SW registration, once it exists. */
let registration = null

/** The waiting worker — a new version that is installed but not yet active. */
let waitingWorker = null

/**
 * When the operator last typed anything, anywhere.
 *
 * Not "does a field have a value" — that was the first attempt and it was
 * wrong. Plenty of screens render inputs that are ALREADY filled from data:
 * the capacity boxes on Parking spaces always hold a number. Testing for a
 * non-empty value therefore reported "busy" for ever on those screens, and an
 * automatic update would never have applied there.
 *
 * Actual typing is the honest signal for "there is unsaved work here".
 */
let lastTypedAt = 0

/** How long after the last keystroke the app still counts as in use. */
const TYPING_GRACE_MS = 60_000

/** How often to ask the server whether a new version exists. */
const UPDATE_CHECK_MS = 15 * 60_000

/** How often to re-test whether it has become safe to apply a waiting update. */
const APPLY_RETRY_MS = 30_000

/** applyUpdate has been started. Stops the timer re-entering it. */
let applying = false

/** reload() has been called. Stops a repeated controllerchange reloading twice. */
let reloading = false

/**
 * True when reloading right now would take something away from the operator.
 *
 * A reload during check-in loses the car's details and the guest is standing
 * there — so an automatic update waits rather than being clever about it.
 */
function isMidTask() {
  // Focused in a field: they are working in it this second.
  const active = document.activeElement
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return true

  // A dialog on screen is a decision part-made — an edit form, a confirm.
  if (document.querySelector('[role="dialog"]')) return true

  return Date.now() - lastTypedAt < TYPING_GRACE_MS
}

/**
 * Applies a waiting update the moment it is safe to, and not before.
 *
 * Called when an update arrives, when the tab is returned to, and on a timer —
 * so a version that arrives mid-check-in is not dropped, it just lands once the
 * operator has finished and moved on. The PwaStatus card stays on screen the
 * whole time, so they can always force it themselves.
 */
function tryAutoApply() {
  if (!waitingWorker) return
  if (isMidTask()) return
  applyUpdate()
}

/** One place to record a waiting version, so auto-apply cannot be forgotten. */
function markUpdateReady(worker) {
  waitingWorker = worker
  emit(updateListeners, true)
  tryAutoApply()
}

/** Chrome's stashed install event. Single-use: it cannot be prompted twice. */
let installPrompt = null

// Simple listener sets. A tiny hand-rolled emitter avoids making this module
// depend on React, so it can be imported from main.jsx before React mounts.
const updateListeners = new Set()
const onlineListeners = new Set()
const installListeners = new Set()

function emit(listeners, payload) {
  listeners.forEach((fn) => {
    try {
      fn(payload)
    } catch (error) {
      console.error('[pwa] listener threw:', error)
    }
  })
}

// ═══════════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Registers the service worker. Safe to call once, from main.jsx.
 *
 * Skipped in dev: a service worker caching assets fights Vite's hot module
 * replacement, producing "I changed the file but nothing happened" confusion
 * that costs hours. PWA behaviour is verified with `npm run build && npm run
 * preview` instead.
 */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.info('[pwa] service workers unsupported — app still works, just not offline')
    return null
  }

  if (import.meta.env.DEV) {
    console.info('[pwa] skipped in dev. Test with: npm run build && npm run preview')
    return null
  }

  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })

    // Case A: a new version is already waiting when the page loads.
    if (registration.waiting && navigator.serviceWorker.controller) {
      markUpdateReady(registration.waiting)
    }

    // Case B: a new version is found while the page is open.
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing
      if (!installing) return

      installing.addEventListener('statechange', () => {
        // `controller` being present means this is an UPDATE, not the very
        // first install. Without that check, every first-time visitor would
        // be shown an "update available" banner immediately.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          markUpdateReady(installing)
        }
      })
    })

    // Any keystroke, anywhere. Capture phase so it is seen even where a
    // component stops propagation. passive: it never calls preventDefault.
    document.addEventListener('input', () => (lastTypedAt = Date.now()), {
      capture: true,
      passive: true,
    })

    // Returning to the tab: ask for a new version, and apply one already
    // waiting. Coming back is the safest possible moment to reload — they were
    // somewhere else a second ago.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      registration?.update().catch(() => {})
      tryAutoApply()
    })

    // A tab that is left OPEN and visible never fires visibilitychange, so
    // without this an admin dashboard on a back-office screen would sit on an
    // old build all day. It is one small request for sw.js.
    setInterval(() => registration?.update().catch(() => {}), UPDATE_CHECK_MS)

    // And keep testing whether it has become safe to apply, so an update that
    // arrived mid-check-in lands as soon as the operator is done.
    setInterval(tryAutoApply, APPLY_RETRY_MS)

    return registration
  } catch (error) {
    // A failed SW registration must never break the app — it only costs
    // offline support.
    console.error('[pwa] registration failed:', error)
    return null
  }
}

// ═══════════════════════════════════════════════════════════════════
// UPDATES
// ═══════════════════════════════════════════════════════════════════

/** Subscribe to "a new version is waiting". Returns an unsubscribe function. */
export function onUpdateReady(callback) {
  updateListeners.add(callback)
  // Fire immediately if an update is already waiting, so a component mounting
  // late does not miss the event.
  if (waitingWorker) callback(true)
  return () => updateListeners.delete(callback)
}

/**
 * Activates the waiting version and reloads.
 *
 * The `controllerchange` listener is registered BEFORE postMessage, and guarded
 * by `reloading`. Without the guard, Chrome can fire controllerchange more than
 * once and the page reloads in a loop.
 */
export function applyUpdate() {
  // MODULE level, not per call. The guard used to be a local `let reloading`,
  // which was enough while the only caller was a button nobody taps twice.
  // tryAutoApply() runs on a timer, so a worker that is slow to activate would
  // get a fresh listener — each with its own local flag — on every retry, and
  // every one of them would call reload() when the controller finally changed.
  if (applying) return
  applying = true

  if (!waitingWorker) {
    window.location.reload()
    return
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Chrome can fire this more than once; reload() must happen at most once.
    if (reloading) return
    reloading = true
    window.location.reload()
  })

  waitingWorker.postMessage({ type: 'SKIP_WAITING' })
}

// ═══════════════════════════════════════════════════════════════════
// NETWORK STATUS
// ═══════════════════════════════════════════════════════════════════

/**
 * Subscribe to online/offline changes.
 *
 * Caveat worth knowing: navigator.onLine only reports whether the device has
 * a network interface, not whether the internet actually works. Connected to
 * car-park wifi with no uplink, it says true. So this drives a hint, while the
 * real signal is a failed Supabase call surfacing through describeDbError().
 */
export function onOnlineChange(callback) {
  onlineListeners.add(callback)

  const handleOnline = () => emit(onlineListeners, true)
  const handleOffline = () => emit(onlineListeners, false)

  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)

  return () => {
    onlineListeners.delete(callback)
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
  }
}

export function isOnline() {
  return navigator.onLine !== false
}

// ═══════════════════════════════════════════════════════════════════
// INSTALL
// ═══════════════════════════════════════════════════════════════════

// Registered at module load, because Chrome fires this event early — often
// before React has mounted. Attaching it inside a component would miss it.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppresses Chrome's own mini-infobar and keeps the event usable.
    event.preventDefault()
    installPrompt = event
    emit(installListeners, true)
  })

  window.addEventListener('appinstalled', () => {
    installPrompt = null
    emit(installListeners, false)
  })
}

/** Subscribe to "the app can be installed right now". */
export function onInstallable(callback) {
  installListeners.add(callback)
  if (installPrompt) callback(true)
  return () => installListeners.delete(callback)
}

/**
 * Shows the native install dialog. Must be called from a user gesture.
 * Returns 'accepted' | 'dismissed' | 'unavailable'.
 */
export async function promptInstall() {
  if (!installPrompt) return 'unavailable'

  try {
    await installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    // The event is single-use — Chrome will not accept prompt() twice.
    installPrompt = null
    emit(installListeners, false)
    return outcome
  } catch (error) {
    console.error('[pwa] install prompt failed:', error)
    return 'dismissed'
  }
}

/**
 * True when running as an installed app rather than a browser tab.
 * iOS Safari does not support display-mode, hence the navigator.standalone
 * fallback — that property exists only on iOS.
 */
export function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: minimal-ui)').matches ||
    navigator.standalone === true
  )
}
