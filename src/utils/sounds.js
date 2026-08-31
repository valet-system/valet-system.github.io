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
 * Is audio ACTUALLY unlocked?
 *
 * primeAudio() cannot answer this: resume() returns a promise, so the state is
 * still 'suspended' when it returns, and a rejection is swallowed. Callers that
 * need to know whether to keep trying have to ask separately — which is exactly
 * what AppShell's priming hook does, because one failed attempt used to leave
 * the loud alarm silent for a whole shift.
 */
export function isAudioRunning() {
  return audioContext?.state === 'running'
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
  toneAt(ctx.currentTime + start, { freq, duration, volume, type })
}

/**
 * The same note, scheduled at an ABSOLUTE point on the audio clock.
 *
 * tone() reads ctx.currentTime at the moment it is called, which is right for a
 * one-off but useless for a loop: each repetition would be laid down relative to
 * whenever its timer happened to fire, and setInterval drift turns into audible
 * gaps and overlaps. The continuous alarm below keeps its own cursor on this
 * clock instead, so repetitions butt up against each other exactly.
 *
 * Returns the oscillator so a caller can cut it short — a scheduled note is
 * otherwise unstoppable, and the alarm has to fall silent the moment the
 * operator accepts, not when its last scheduled note happens to finish.
 */
function toneAt(when, { freq, duration = 0.16, volume = 0.22, type = 'sine' }) {
  const ctx = getContext()
  if (!ctx || ctx.state !== 'running') return null

  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = type
    osc.frequency.value = freq

    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(volume, when + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration)

    osc.connect(gain).connect(ctx.destination)
    osc.start(when)
    // Always stop: an oscillator left running holds an audio thread open, and
    // a few hundred of them over an 8-hour shift will audibly distort.
    osc.stop(when + duration + 0.02)
    return osc
  } catch {
    // Spec rule 21 — never let a sound failure surface to the caller.
    return null
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
const LOUD_FIGURE = [
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
]

/**
 * How long the figure runs, end to end: the last note starts at 1.3 and lasts
 * 0.22. The looping alarm advances its cursor by exactly this, so repetition N+1
 * begins the instant N finishes and the pattern never breaks.
 */
const LOUD_FIGURE_SECONDS = 1.52

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
const LOUD_VOICE = { volume: 0.8, type: 'square' }

export function playLoud() {
  sequence(LOUD_FIGURE, LOUD_VOICE)
}

// ═══════════════════════════════════════════════════════════════════
// THE ALARM THAT DOES NOT STOP
//
// playLoud() sounds once. This repeats it with NO gap until something
// explicitly stops it — used while a dispatched car sits unacknowledged, where
// the operator has to be pulled away from whatever they are doing.
//
// WHY NOT setInterval(playLoud, 1520)
//   Because that is what it replaced, and it broke. A JS timer fires late
//   whenever the main thread is busy — rendering the very list this alarm is
//   about, say — and playLoud() then reads the audio clock at that late moment.
//   Every repetition inherits the drift, so the pattern breathes: a silence
//   here, two figures overlapping there. Overlap also SUMS, and two square
//   notes at 0.8 clip.
//
//   So the timer no longer decides when anything sounds. It only tops up a
//   queue: every tick, schedule whatever falls inside the next half second on
//   the audio clock's own timeline. The clock, not the timer, places the notes,
//   and a late tick changes nothing as long as it lands within the lookahead.
// ═══════════════════════════════════════════════════════════════════

/**
 * ── NO TIMER. A LOOPING BUFFER. ────────────────────────────────────────
 *
 * This was a setInterval pump that scheduled 0.5s of notes at a time, and the
 * comment where that lived even named the flaw: "throttled timers stop firing".
 * It was right, and it was the bug.
 *
 * Chrome throttles setInterval in a BACKGROUNDED page down to roughly once a
 * minute. With half a second of lookahead that produced half a second of alarm,
 * then a minute of silence, then another half second — for an operator who has
 * put the app in the background and is holding a guest's keys. Exactly when the
 * alarm is most needed is exactly when it stopped.
 *
 * A page that is PLAYING AUDIO is not frozen by Chrome — that is why music
 * keeps going in a background tab. The audio thread was never the problem; the
 * JavaScript feeding it was. So the figure is rendered ONCE into a buffer and
 * handed to the audio thread with loop = true. After start() no JavaScript runs
 * at all, so there is nothing left to throttle.
 *
 * ── WHAT STILL CANNOT WORK IN THE BACKGROUND ───────────────────────────
 * Vibration. navigator.vibrate() is ignored unless the page is visible, in
 * every browser that implements it, and no amount of scheduling changes that.
 * It is kept for the foreground case and simply does nothing behind.
 *
 * And if the OS KILLS the app — swiped away, or reclaimed under memory
 * pressure — nothing in this file can run. That is what the push notification
 * is for, and why both exist.
 */

/** The rendered figure, built once on first use and reused after that. */
let alarmBuffer = null
/** The looping source, or null when silent. Doubles as "is it running". */
let alarmSource = null
let alarmBuzzTimer = null

/**
 * Renders LOUD_FIGURE into an AudioBuffer, offline.
 *
 * Same oscillator and same gain envelope as toneAt, so the alarm sounds exactly
 * as it did — this changes how the notes are DELIVERED, not what they are. The
 * envelope is duplicated rather than shared because toneAt writes to the live
 * context and this has to write to an offline one.
 */
function renderAlarmBuffer(ctx) {
  const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!OfflineCtor) return null

  try {
    const length = Math.ceil(LOUD_FIGURE_SECONDS * ctx.sampleRate)
    const offline = new OfflineCtor(1, length, ctx.sampleRate)

    for (const note of LOUD_FIGURE) {
      const osc = offline.createOscillator()
      const gain = offline.createGain()
      osc.type = LOUD_VOICE.type
      osc.frequency.value = note.freq

      const when = note.at
      gain.gain.setValueAtTime(0.0001, when)
      gain.gain.exponentialRampToValueAtTime(LOUD_VOICE.volume, when + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, when + note.duration)

      osc.connect(gain).connect(offline.destination)
      osc.start(when)
      osc.stop(when + note.duration + 0.02)
    }

    return offline.startRendering()
  } catch {
    return null
  }
}

/**
 * Starts the unbroken alarm. Safe to call repeatedly — a second call while it
 * is already running does nothing, rather than laying a second copy of the
 * figure on top of the first, which would double the amplitude and clip.
 */
export function startLoudAlarm() {
  if (alarmSource) return

  const ctx = getContext()
  if (!ctx) return
  // The alarm often starts from a push or a realtime event rather than a tap,
  // so the context may still be locked. Nothing plays until it is running; this
  // costs nothing and rescues the case where audio was primed a moment ago.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})

  // Haptics first, and not awaited on the buffer: the buzz is instant and the
  // render is a promise, so waiting would delay the one channel that needs no
  // decoding. Foreground only — see the header.
  vibrate()
  alarmBuzzTimer = setInterval(vibrate, Math.round(LOUD_FIGURE_SECONDS * 1000))

  const begin = (buffer) => {
    // stopLoudAlarm may have run while the render was in flight. Without this
    // the alarm would start AFTER being cancelled and never stop, because the
    // caller has already let go of it.
    if (!alarmBuzzTimer || alarmSource || !buffer) return

    try {
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.loop = true
      src.connect(ctx.destination)
      // A hair in the future: starting AT currentTime races the audio thread
      // and clips the first note on some browsers.
      src.start(ctx.currentTime + 0.05)
      alarmSource = src
    } catch {
      /* nothing to do — a silent alarm is bad, a thrown one is worse */
    }
  }

  if (alarmBuffer) {
    begin(alarmBuffer)
    return
  }

  const rendering = renderAlarmBuffer(ctx)
  if (!rendering) return

  rendering
    .then((buffer) => {
      alarmBuffer = buffer
      begin(buffer)
    })
    .catch(() => {})
}

/**
 * Stops it, now.
 *
 * One source to stop rather than a queue of scheduled notes to chase, which is
 * the other thing the buffer bought: there is no lookahead tail that can keep
 * sounding after the operator has accepted.
 */
export function stopLoudAlarm() {
  if (alarmBuzzTimer) {
    clearInterval(alarmBuzzTimer)
    alarmBuzzTimer = null
  }

  if (alarmSource) {
    try {
      alarmSource.stop()
      alarmSource.disconnect()
    } catch {
      /* already stopped, or the context went away with the page */
    }
    alarmSource = null
  }
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
 * ── ONE EVENT, ONE OS NOTIFICATION ────────────────────────────────────
 *
 * These used to call showNotification() as well, and that is why a single
 * "Car requested" arrived on the phone TWICE with two different wordings:
 *
 *   Token 5 — 1234        this file, from the page, via tasks.alarmBody
 *   Token 5 · 1234 · P1   the service worker, from the server push
 *
 * Same event, two independent producers. The server push is the better of the
 * two and it is not close:
 *
 *   app closed / phone locked   push arrives · the page cannot run at all
 *   parking location in body    push has it · the page's format does not
 *   who is told                 push reaches every admin at the property,
 *                               the page only whoever has it open
 *
 * A page-made notification only fires when somebody is already looking at the
 * screen — which is when a notification is least needed — and it was the
 * duplicate.
 *
 * So the OS notification now has exactly ONE source: the push handler in
 * public/sw.js. What these keep is the part the service worker cannot do —
 * making a noise, immediately, in the app the operator is holding.
 *
 * showNotification() itself is untouched and still exported: sw.js is not the
 * only conceivable caller, and removing it would take a working tool away to
 * fix a duplicate that was never its fault.
 */

/** Full-force alert: sound + haptics. The OS notification comes from the push. */
export function alertLoud(title, body, tag, url) {
  playLoud()
  vibrate()
  // title / body / tag / url are still in the signature on purpose. Every
  // caller passes them, they are what the push carries, and dropping them from
  // here would make the two paths look unrelated to the next reader.
  void title
  void body
  void tag
  void url
}

/** Quiet alert: soft tone only. The OS notification comes from the push. */
export function alertSoft(title, body, tag, url) {
  playSoft()
  void title
  void body
  void tag
  void url
}
