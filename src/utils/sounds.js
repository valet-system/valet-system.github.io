/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/utils/sounds.js                                           │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Every way the app grabs a human's attention:                       │
 * │     playLoud()    — new task assigned / new retrieval request        │
 * │     playSoft()    — FYI, e.g. admin sees a check-in happen          │
 * │     playWarning() — 2 minutes left on the pickup countdown          │
 * │     playSuccess() — an action completed                             │
 * │     vibrate()     — phone haptics                                   │
 * │     showNotification()          — OS-level notification             │
 * │     requestNotificationPermission()                                 │
 * │     primeAudio()  — see "THE AUTOPLAY PROBLEM" below                │
 * │     alertLoud() / alertSoft()   — sound + vibrate + notification    │
 * │                                                                     │
 * │ WHY THIS DIFFERS FROM THE SPEC                                       │
 * │   The spec loads three mp3 files (loud-alert.mp3 etc). We synthesize │
 * │   the tones with the Web Audio API instead. Reasons:                 │
 * │     - no audio files to source, license, or accidentally omit — a    │
 * │       missing mp3 is a silent 404, and "silent" is the one failure   │
 * │       mode an alert system cannot have                              │
 * │     - nothing to download, so the alert is instant even on the       │
 * │       basement 4G where these operators actually work                │
 * │     - each alert is a distinct musical interval, so an operator      │
 * │       learns to tell "task assigned" from "timer running out"        │
 * │       without looking at the screen                                  │
 * │                                                                     │
 * │ THE AUTOPLAY PROBLEM (the important part)                             │
 * │   Browsers refuse to play audio until the user has interacted with   │
 * │   the page. A realtime event is NOT a user interaction, so an alert  │
 * │   triggered by an incoming task would be blocked and silent.          │
 * │                                                                     │
 * │   Fix: primeAudio() is called from the login button's click handler  │
 * │   — a real user gesture. That unlocks the AudioContext for the rest  │
 * │   of the session, so every later alert plays.                        │
 * │                                                                     │
 * │   Spec rule 21 also applies: every play path is wrapped so a         │
 * │   blocked or unsupported sound can never throw and break the         │
 * │   surrounding operation. Failing to beep must not fail a check-in.   │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   Login (primeAudio), operator/MyTasks, admin/Dashboard, useTimer.   │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   Nothing.                                                          │
 * └─────────────────────────────────────────────────────────────────────┘
 */

// ═══════════════════════════════════════════════════════════════════
// AUDIO ENGINE
// ═══════════════════════════════════════════════════════════════════

/** One AudioContext for the whole app. Browsers cap how many you may create. */
let audioContext = null

function getContext() {
  if (typeof window === 'undefined') return null

  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) return null // very old browser: silently degrade

  if (!audioContext) {
    try {
      audioContext = new Ctor()
    } catch {
      return null
    }
  }
  return audioContext
}

/**
 * Call from a real user gesture (a click / tap) to unlock audio.
 *
 * A context created before any interaction starts in state 'suspended' and
 * every note is dropped. resume() inside a gesture handler moves it to
 * 'running' permanently.
 */
export function primeAudio() {
  const ctx = getContext()
  if (!ctx) return
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
}

/**
 * Plays one note.
 *
 * The gain envelope (ramp up over 12ms, exponential decay) is not decoration.
 * Switching a raw oscillator on and off produces an audible click, because the
 * waveform jumps discontinuously. The ramp is what makes it sound like a
 * device chime rather than a glitch.
 */
function tone({ freq, start = 0, duration = 0.16, volume = 0.22, type = 'sine' }) {
  const ctx = getContext()
  if (!ctx || ctx.state !== 'running') return

  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = type
    osc.frequency.value = freq

    const t0 = ctx.currentTime + start
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)

    osc.connect(gain).connect(ctx.destination)
    osc.start(t0)
    // Always stop: an oscillator left running holds an audio thread open, and
    // a few hundred of them over an 8-hour shift will audibly distort.
    osc.stop(t0 + duration + 0.02)
  } catch {
    // Spec rule 21 — never let a sound failure surface to the caller.
  }
}

/** Plays a sequence of notes. Each entry: { freq, at, duration, volume }. */
function sequence(notes, { volume = 0.22, type = 'sine' } = {}) {
  notes.forEach((n) =>
    tone({
      freq: n.freq,
      start: n.at,
      duration: n.duration ?? 0.16,
      volume: n.volume ?? volume,
      type,
    }),
  )
}

// ═══════════════════════════════════════════════════════════════════
// THE FOUR ALERTS
// Distinct shapes on purpose, so they are distinguishable in a noisy
// porch without looking at the phone.
// ═══════════════════════════════════════════════════════════════════

/**
 * LOUD — a new task needs you now.
 * Rising three-note figure repeated twice. Rising = "come here", and the
 * repeat is what carries over traffic noise.
 * Used for: retrieval request arriving (admin), task assigned (operator).
 */
export function playLoud() {
  sequence(
    [
      // ── SAME RISING SHAPE, AN OCTAVE UP ──
      // The shape is deliberately unchanged: rising still means "come here" and
      // stays the opposite of playWarning's falling pair, which is the whole
      // reason the four alerts are distinguishable without looking. Only the
      // loudness moved.
      { freq: 1568, at: 0.0, duration: 0.12 }, // G6
      { freq: 1976, at: 0.13, duration: 0.12 }, // B6
      { freq: 2637, at: 0.26, duration: 0.18 }, // E7
      { freq: 1568, at: 0.52, duration: 0.12 },
      { freq: 1976, at: 0.65, duration: 0.12 },
      { freq: 2637, at: 0.78, duration: 0.18 },
      // A THIRD round. A guest is waiting; another 0.5s of noise is cheaper
      // than the operator missing it and the car being fetched five minutes
      // late.
      { freq: 1568, at: 1.04, duration: 0.12 },
      { freq: 1976, at: 1.17, duration: 0.12 },
      { freq: 2637, at: 1.3, duration: 0.22 },
    ],
    // ── WHY THIS IS LOUDER, AND WHY GAIN IS THE SMALLEST PART OF IT ──
    //
    // 1. SQUARE, not triangle. A square wave packs far more harmonic energy at
    //    the same peak amplitude, so it is heard as dramatically louder — and it
    //    buzzes, which is what an alert should do. A triangle is a chime.
    //
    // 2. AN OCTAVE UP. Human hearing peaks around 2-4 kHz, and a phone's tiny
    //    speaker is also most efficient there while rolling off badly below
    //    ~500 Hz. The old figure sat at 784-1319 Hz, under both curves. Moving
    //    it to 1568-2637 Hz gains real perceived volume at no extra amplitude.
    //
    // 3. GAIN 0.3 -> 0.8. Safe because the notes do not overlap: each has
    //    decayed before the next begins, so nothing sums past full scale. Two
    //    simultaneous notes at 0.8 WOULD clip, which is why this is a sequence
    //    and not a chord.
    { volume: 0.8, type: 'square' },
  )
}

/**
 * SOFT — something happened, no action needed.
 * One quiet note. Used for the admin's FYI on a check-in. This fires often,
 * so it must never become annoying or people mute the tab.
 */
export function playSoft() {
  sequence([{ freq: 880, at: 0, duration: 0.11 }], { volume: 0.13 })
}

/**
 * WARNING — 2 minutes left before the guest counts as absent.
 * Two FALLING notes. Falling reads as "running out", the opposite of the
 * rising LOUD figure, so the two can never be confused.
 */
export function playWarning() {
  sequence(
    [
      { freq: 1047, at: 0.0, duration: 0.16 }, // C6
      { freq: 698, at: 0.19, duration: 0.26 }, // F5
    ],
    { volume: 0.28, type: 'triangle' },
  )
}

/** SUCCESS — a short rising two-note confirmation after an action completes. */
export function playSuccess() {
  sequence(
    [
      { freq: 659, at: 0.0, duration: 0.09 }, // E5
      { freq: 988, at: 0.09, duration: 0.16 }, // B5
    ],
    { volume: 0.16 },
  )
}

// ═══════════════════════════════════════════════════════════════════
// HAPTICS
// ═══════════════════════════════════════════════════════════════════

/**
 * Vibrates the phone. Long-short-long so it is distinguishable from an
 * incoming WhatsApp buzz.
 *
 * Not supported on iOS Safari at all, and Chrome ignores it unless the page
 * has been interacted with. It is therefore a bonus channel, never the only
 * one — which is why alertLoud() fires sound, haptics and a notification
 * together rather than picking one.
 */
export function vibrate(pattern = [400, 150, 400]) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern)
  } catch {
    /* unsupported — ignore */
  }
}

// ═══════════════════════════════════════════════════════════════════
// OS NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════

export function notificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission // 'default' | 'granted' | 'denied'
}

/**
 * Asks for notification permission.
 *
 * Must be called from a user gesture — Chrome ignores the prompt otherwise.
 * We call it right after a successful login, when the operator is already
 * looking at the screen and expecting the app to set itself up. Asking on
 * page load is the classic mistake: users reflexively hit Block, and then it
 * can never be asked again.
 */
export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

/**
 * Shows an OS notification while the app is OPEN.
 *
 * ── WHY THIS GOES THROUGH THE SERVICE WORKER ──────────────────────────
 *
 * This used to call `new Notification(...)`. That constructor THROWS
 * `TypeError: Illegal constructor` on Chrome for Android — which is every
 * device the operators actually use. The old code caught it and did nothing,
 * so OS notifications had never once worked on the platform that matters,
 * and nothing on screen said so.
 *
 * `ServiceWorkerRegistration.showNotification()` is the supported path on
 * Android and works on desktop too, so there is only one code path.
 *
 * ── WHAT THIS STILL CANNOT DO ─────────────────────────────────────────
 *
 * It needs the page to be alive to be called. A phone in a pocket has no
 * running page, so the app's realtime socket is gone and nothing here ever
 * runs. Reaching a CLOSED app needs Web Push — a real push message, delivered
 * by the OS, handled in sw.js. This function covers "app open, tab in the
 * background"; push covers the rest.
 *
 * `requireInteraction` keeps a critical alert up until dismissed instead of
 * auto-hiding after ~5s. Chrome desktop honours it; most mobile browsers do
 * not — which is why sound and haptics fire alongside it, never instead.
 */
export async function showNotification(title, body, { critical = false, tag, url } = {}) {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    if (!('serviceWorker' in navigator)) return

    // `ready` resolves once there is an ACTIVE worker. On a first-ever load the
    // worker may still be installing, and registration.showNotification on a
    // non-active worker silently does nothing.
    const registration = await navigator.serviceWorker.ready

    await registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      requireInteraction: critical,
      // A tag replaces an earlier notification with the same tag instead of
      // stacking. Pass the task id so five realtime events for one task do not
      // produce five notifications.
      tag,
      renotify: Boolean(tag),
      silent: false,
      vibrate: critical ? [400, 150, 400] : [200],
      // Read by the notificationclick handler in sw.js so a tap lands on the
      // screen the alert is about.
      data: { url: url ?? '/' },
    })
  } catch (err) {
    // Not silent any more. Swallowing this is exactly how the Android failure
    // above survived — a notification that never appears looks identical to
    // one nobody looked at.
    console.warn('[notify] could not show notification:', err)
  }
}

// ═══════════════════════════════════════════════════════════════════
// COMBINED HELPERS — what pages should actually call
// ═══════════════════════════════════════════════════════════════════

/**
 * Full-force alert: sound + haptics + OS notification.
 *
 * Use for anything an operator must act on now. Three channels because each
 * one fails in a different situation — audio if the phone is muted, haptics
 * on iOS, notifications if permission was denied. Together, at least one
 * lands.
 */
export function alertLoud(title, body, tag, url) {
  playLoud()
  vibrate()
  // Deliberately not awaited: the sound and the buzz must not wait on
  // navigator.serviceWorker.ready, which can take a moment on a cold start.
  showNotification(title, body, { critical: true, tag, url })
}

/** Quiet alert: soft tone + a non-sticky notification. No haptics. */
export function alertSoft(title, body, tag, url) {
  playSoft()
  showNotification(title, body, { critical: false, tag, url })
}
