/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/lib/taskAlerts.js                                         │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   One doorway for "tell the operator something arrived", so two       │
 * │   independent detectors cannot make the same event sound twice.       │
 * │                                                                     │
 * │     alertOnce(key, { critical, title, body, tag, url })              │
 * │                                                                     │
 * │ ── WHY TWO DETECTORS AT ALL ─────────────────────────────────────────│
 * │   The alert used to live only in operator/MyTasks, watching           │
 * │   valet_tasks. That screen is mounted only while the operator is      │
 * │   LOOKING at it — and they are not: they are on Check In, taking a    │
 * │   car from a guest. So an admin dispatching a retrieval updated the   │
 * │   bell badge (NotificationBell is in AppShell and always mounted)     │
 * │   and made no sound whatsoever. The one thing the alert exists for.   │
 * │                                                                     │
 * │   So the bell now alerts too, from push_outbox, on every screen.      │
 * │   MyTasks keeps its own alert rather than being stripped, because the │
 * │   two fail in different ways:                                        │
 * │                                                                     │
 * │     valet_tasks  — the assignment itself. Cannot be missed, but only │
 * │                    while that screen is open.                        │
 * │     push_outbox  — every screen, but only if the enqueue trigger ran. │
 * │                                                                     │
 * │   Either one alone has a silent failure mode. Together they do not,   │
 * │   and "silent" is the one failure an alert system cannot have.        │
 * │                                                                     │
 * │ ── WHY A TIME WINDOW AND NOT A PERMANENT SET ────────────────────────│
 * │   The two detectors do not fire together. The task row lands first;   │
 * │   the push row follows once the trigger has run — normally within a   │
 * │   second, but a slow round trip stretches that. A window absorbs the  │
 * │   gap. A permanent set would grow all shift and would also suppress a │
 * │   genuine RE-alert for the same car hours later, which is wanted:     │
 * │   a re-park of token 12 tonight deserves its own sound.               │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   components/NotificationBell, pages/operator/MyTasks                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { alertLoud, alertSoft } from '@/utils/sounds'

/** key -> when it last alerted. */
const fired = new Map()

/**
 * How long one event stays "already announced".
 *
 * Long enough to cover the task row and its push row arriving separately,
 * short enough that a real second event about the same car still sounds.
 */
const WINDOW_MS = 20_000

/**
 * Announces something once, whichever detector saw it first.
 *
 * @param key   Stable across detectors. A task id where there is one — that is
 *              the whole point, since both tables carry it.
 * @returns true if it alerted, false if this was the duplicate.
 */
export function alertOnce(key, { critical = false, title, body, tag, url } = {}) {
  const now = Date.now()

  // Pruned on the way in. There is no other timer here, and a Map that is only
  // ever added to is a leak on a screen left open for an eight-hour shift.
  for (const [k, at] of fired) {
    if (now - at > WINDOW_MS) fired.delete(k)
  }

  if (fired.has(key)) return false
  fired.set(key, now)

  // Loud is for "a guest is waiting for this car". Soft is for everything the
  // operator merely wants to know — using the loud alert for both is how an
  // operator learns to ignore it.
  if (critical) alertLoud(title, body, tag, url)
  else alertSoft(title, body, tag, url)

  return true
}

/** Test seam. Not used by the app. */
export function _resetAlertMemory() {
  fired.clear()
}
