/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/hooks/useParkSubmit.js                                    │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Recording where a car was parked, including the one case the       │
 * │   server can refuse: the place filled up while the operator was      │
 * │   walking back.                                                     │
 * │                                                                     │
 * │     const park = useParkSubmit((location, force) =>                  │
 * │       completeParking(task.id, location, force))                     │
 * │                                                                     │
 * │     park.submit(location)        // normal                           │
 * │     park.error                   // what to show                     │
 * │     park.needsConfirm            // offer "the car really is there"  │
 * │     park.confirm()               // retry with force                 │
 * │                                                                     │
 * │ ── WHY A HOOK AND NOT THREE COPIES ──────────────────────────────────│
 * │   Three screens record a park: the token panel on Check In, the      │
 * │   "still to park" strip beside it, and the re-park card in My Tasks. │
 * │   All three need the same two-step recovery, and a hand-rolled copy  │
 * │   in each is three chances to get the retry subtly wrong — most      │
 * │   likely by forgetting to send `force` on the second attempt, which  │
 * │   would leave the operator tapping a button that never works.        │
 * │                                                                     │
 * │ ── WHY THE OVERRIDE EXISTS AT ALL ───────────────────────────────────│
 * │   By the time this runs, the car is already parked. The operator      │
 * │   drove it, walked back, and is telling the system what they did. A  │
 * │   refusal it cannot get past does not move the car — it leaves one   │
 * │   sitting in a real bay that the system thinks is still at the       │
 * │   porch. Migration 0027 has the full argument.                        │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   operator/CheckIn (token panel + still-to-park), operator/MyTasks   │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useRef, useState } from 'react'

export default function useParkSubmit(run) {
  const [error, setError] = useState(null)
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  /** The location the refusal was about, so confirm() retries the same one. */
  const pending = useRef('')

  const attempt = useCallback(
    async (location, force) => {
      setBusy(true)
      try {
        const result = await run(location, force)

        if (result.ok) {
          setError(null)
          setNeedsConfirm(false)
          return true
        }

        setError(result.error)
        // SPACE_FULL is the only refusal with a way forward. Everything else —
        // WRONG_STATUS, OFFLINE, NOT_FOUND — needs the operator to do something
        // different, and offering an override would just hide that.
        setNeedsConfirm(result.code === 'SPACE_FULL' && !force)
        pending.current = location
        return false
      } finally {
        setBusy(false)
      }
    },
    [run],
  )

  return {
    error,
    needsConfirm,
    busy,
    submit: (location) => attempt(location, false),
    confirm: () => attempt(pending.current, true),
    /** Call when the operator edits the place, so a stale refusal clears. */
    reset: () => {
      setError(null)
      setNeedsConfirm(false)
    },
  }
}
