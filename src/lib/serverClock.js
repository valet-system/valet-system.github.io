/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/lib/serverClock.js                                        │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   A running estimate of how far this phone's clock is from the       │
 * │   database's, and a serverNow() that corrects for it.                │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   The 10-minute hand-over countdown is the one number on the         │
 * │   operator's screen that has to agree with the server, because the   │
 * │   server acts on it: expire_stale_pickups() compares                 │
 * │   pickup_started_at against the DATABASE clock and returns the car   │
 * │   to the car park when it runs out.                                  │
 * │                                                                     │
 * │   Operators use cheap Android handsets, often with automatic time    │
 * │   switched off. A phone three minutes fast shows 00:00 while the     │
 * │   guest still has three minutes; a phone three minutes slow shows    │
 * │   03:00 on a task the database has already expired — the operator    │
 * │   stands there waiting for a guest whose car is being re-parked.     │
 * │                                                                     │
 * │ HOW THE OFFSET IS LEARNED                                           │
 * │   Free of charge, from timestamps the server already sends back.     │
 * │   When an RPC returns a value it generated with now() — such as      │
 * │   pickup_started_at — the difference between that and the local      │
 * │   clock AT THE MOMENT OF THE REPLY is the offset, give or take the   │
 * │   round trip. A round trip is under a second; the thing being        │
 * │   measured is a ten-minute window, so that error does not matter.    │
 * │   A phone whose clock is wrong by minutes is corrected within one    │
 * │   tap, and the estimate refreshes on every tap after that.           │
 * │                                                                     │
 * │   Deliberately in memory only. A stored offset would be reloaded     │
 * │   after the user fixed their clock and make it wrong again.          │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   hooks/useTimer (the countdown), lib/valetApi callers.              │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   Nothing.                                                          │
 * └─────────────────────────────────────────────────────────────────────┘
 */

/** serverTime - localTime, in milliseconds. 0 until we learn otherwise. */
let offsetMs = 0
let learned = false

/**
 * Feeds in a timestamp the SERVER generated, received just now.
 *
 * Only pass values the database produced with now() in the reply you are
 * currently handling. A timestamp read out of a row that was written an hour
 * ago says nothing about the current offset and would corrupt it.
 */
export function noteServerTime(isoTimestamp) {
  if (!isoTimestamp) return
  const serverMs = Date.parse(isoTimestamp)
  if (Number.isNaN(serverMs)) return

  offsetMs = serverMs - Date.now()
  learned = true

  // Worth knowing about: a large offset means the operator's countdown was
  // wrong until this moment, and their other apps are wrong too.
  if (Math.abs(offsetMs) > 30_000) {
    console.warn(
      `[serverClock] this device's clock is ${Math.round(offsetMs / 1000)}s ` +
        'out from the database. Countdowns are corrected for it.',
    )
  }
}

/** Milliseconds since the epoch, on the DATABASE's clock. */
export function serverNow() {
  return Date.now() + offsetMs
}

/** Whether a real measurement has been taken yet. For diagnostics only. */
export function hasServerClock() {
  return learned
}

/** The current correction, in seconds. For diagnostics only. */
export function clockSkewSeconds() {
  return Math.round(offsetMs / 1000)
}
