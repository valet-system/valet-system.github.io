/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/hooks/useParkSubmit.js                                    │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The submit half of "where did you park it": one busy flag and one  │
 * │   error, shared by the two screens that record a parked car.         │
 * │                                                                     │
 * │     const park = useParkSubmit((location) =>                         │
 * │       completeParking(task.id, location))                            │
 * │                                                                     │
 * │     park.submit(location)   // record it                             │
 * │     park.reset()            // the operator edited the place         │
 * │     park.busy, park.error                                           │
 * │                                                                     │
 * │ ── WHAT THIS USED TO DO, AND WHY IT NO LONGER DOES ──────────────────│
 * │   It carried a two-step confirm flow: a full parking place was       │
 * │   refused with SPACE_FULL, and the operator could answer "the car    │
 * │   really is there" and retry with force. Per-place limits were       │
 * │   removed in migration 0035, so nothing refuses a park on capacity   │
 * │   any more and there is nothing left to override.                    │
 * │                                                                     │
 * │   The hook stays rather than being deleted, because the busy flag    │
 * │   and the single error string are still worth having in one place —  │
 * │   two screens submit this and both need the same "disabled while in  │
 * │   flight" behaviour that stops a double-park.                        │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   operator/CheckIn (token panel + still-to-park), operator/MyTasks   │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useState } from 'react'

export default function useParkSubmit(run) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = useCallback(
    async (location) => {
      setBusy(true)
      try {
        const result = await run(location)

        if (result.ok) {
          setError(null)
          return true
        }

        setError(result.error)
        return false
      } finally {
        // finally, not after the branches: an exception here would otherwise
        // leave the button disabled for good and the operator stuck.
        setBusy(false)
      }
    },
    [run],
  )

  return {
    error,
    busy,
    submit,
    /** Call when the operator edits the place, so a stale refusal clears. */
    reset: () => setError(null),
  }
}
