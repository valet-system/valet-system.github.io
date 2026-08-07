/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/hooks/useTimer.js                                         │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The hand-over countdown. Given the moment a pickup started, it     │
 * │   returns how long the guest has left, and fires two callbacks:      │
 * │     onWarning — once, at 2 minutes remaining                         │
 * │     onExpire  — once, at zero                                        │
 * │                                                                     │
 * │ WHY IT RECOMPUTES INSTEAD OF COUNTING DOWN                           │
 * │   The obvious version keeps a number in state and subtracts one per  │
 * │   second. It is wrong here in two ways that both happen every        │
 * │   shift:                                                            │
 * │                                                                     │
 * │   1. setInterval does not run while a phone is asleep or the tab is  │
 * │      backgrounded. An operator who pockets their phone for four      │
 * │      minutes comes back to a timer that has lost four minutes and    │
 * │      disagrees with the database — which never stopped counting.     │
 * │   2. Browsers throttle background timers to once a minute or worse,  │
 * │      so even a visible-but-inactive tab drifts.                      │
 * │                                                                     │
 * │   So the interval is only a repaint trigger. The number itself is    │
 * │   always deadline − now, recomputed from scratch. Miss a hundred     │
 * │   ticks and the next one still shows the right time.                 │
 * │                                                                     │
 * │ WHOSE CLOCK                                                          │
 * │   The database's, via lib/serverClock. The countdown has to agree    │
 * │   with expire_stale_pickups(), which is what actually returns the    │
 * │   car to the car park. See that file for why a phone's own clock is  │
 * │   not good enough.                                                   │
 * │                                                                     │
 * │ THE COUNTDOWN IS NOT THE AUTHORITY                                   │
 * │   onExpire is a UI cue — it re-reads the task so the screen catches  │
 * │   up. The pg_cron job is what changes the data, and it is the only   │
 * │   thing that runs when the phone is locked. Never write a status     │
 * │   change from onExpire: eight operators watching the same task would │
 * │   each fire one.                                                     │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   pages/operator/MyTasks (retrieval card).                           │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/lib/serverClock, src/types (PICKUP_TIMEOUT_SECONDS,            │
 * │   PICKUP_WARNING_SECONDS)                                            │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useRef, useState } from 'react'
import { serverNow } from '@/lib/serverClock'
import { PICKUP_TIMEOUT_SECONDS, PICKUP_WARNING_SECONDS } from '@/types'

function secondsLeftFrom(startedAt, totalSeconds) {
  if (!startedAt) return null
  const startedMs = Date.parse(startedAt)
  if (Number.isNaN(startedMs)) return null

  const elapsed = (serverNow() - startedMs) / 1000
  // Clamped at 0: an expired timer reads "00:00", never "-00:07".
  return Math.max(0, Math.round(totalSeconds - elapsed))
}

/**
 * @param startedAt  ISO timestamp from the server (valet_tasks.pickup_started_at).
 *                   Pass null when no pickup is running — the hook idles.
 * @param options.totalSeconds  window length; defaults to PICKUP_TIMEOUT_SECONDS
 * @param options.onWarning     fired once when the remaining time crosses 2 min
 * @param options.onExpire      fired once when it reaches 0
 *
 * @returns { secondsLeft, isRunning, isWarning, isExpired }
 */
export function useTimer(startedAt, options = {}) {
  const {
    totalSeconds = PICKUP_TIMEOUT_SECONDS,
    warningSeconds = PICKUP_WARNING_SECONDS,
    onWarning,
    onExpire,
  } = options

  const [secondsLeft, setSecondsLeft] = useState(() =>
    secondsLeftFrom(startedAt, totalSeconds),
  )

  // Callbacks live in a ref so a caller passing an inline arrow does not
  // tear down and rebuild the interval on every render — which would reset
  // the fired-once guards below and re-alarm every second.
  const handlers = useRef({ onWarning, onExpire })
  handlers.current = { onWarning, onExpire }

  useEffect(() => {
    if (!startedAt) {
      setSecondsLeft(null)
      return undefined
    }

    // Reset per pickup, not per render: each guard must fire once for this
    // startedAt and then stay quiet.
    let warned = false
    let expired = false

    const tick = () => {
      const left = secondsLeftFrom(startedAt, totalSeconds)
      setSecondsLeft(left)

      if (left === null) return

      if (!warned && left <= warningSeconds && left > 0) {
        warned = true
        handlers.current.onWarning?.()
      }

      if (!expired && left <= 0) {
        expired = true
        // Also suppress the warning: a task already expired when the screen
        // opened must not play the two-minute alarm on the way past zero.
        warned = true
        handlers.current.onExpire?.()
      }
    }

    tick() // paint immediately; do not wait a second for the first value
    const id = setInterval(tick, 1000)

    // A phone waking up is the case this exists for. The interval was frozen
    // while it slept, so recompute the moment it comes back rather than
    // showing a stale number until the next tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [startedAt, totalSeconds, warningSeconds])

  return {
    secondsLeft,
    isRunning: secondsLeft !== null && secondsLeft > 0,
    isWarning: secondsLeft !== null && secondsLeft > 0 && secondsLeft <= warningSeconds,
    isExpired: secondsLeft !== null && secondsLeft <= 0,
  }
}

export default useTimer
