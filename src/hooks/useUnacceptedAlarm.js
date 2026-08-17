/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/hooks/useUnacceptedAlarm.js                               │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Sounds the continuous alarm for as long as this operator has a     │
 * │   retrieval dispatched to them that they have not accepted.          │
 * │                                                                     │
 * │ WHY IT IS A HOOK IN AppShell AND NOT AN EFFECT IN MyTasks            │
 * │   It started life inside operator/MyTasks, which meant it only ran   │
 * │   while that screen was OPEN. An admin would assign a car, and the   │
 * │   operator — standing at the porch on the Check In screen, taking    │
 * │   keys from a guest — heard nothing at all. The alarm only began     │
 * │   once they happened to navigate to the task list, which is exactly  │
 * │   the moment they no longer needed telling.                          │
 * │                                                                     │
 * │   AppShell wraps every signed-in screen, so living here means the    │
 * │   alarm starts the instant the assignment lands, wherever they are.  │
 * │                                                                     │
 * │ ── ONE OWNER, DELIBERATELY ──────────────────────────────────────────│
 * │   startLoudAlarm / stopLoudAlarm act on one global audio loop. If    │
 * │   two components both drove it, the one unmounting would silence an  │
 * │   alarm the other still wanted — navigating away from the task list  │
 * │   would stop a noise that ought to follow the operator. So this hook │
 * │   is the ONLY caller of either function. MyTasks no longer has an    │
 * │   alarm of its own.                                                  │
 * │                                                                     │
 * │ ── WHY IT QUERIES INSTEAD OF READING THE TASK LIST ──────────────────│
 * │   The task list belongs to a screen that is usually not mounted.     │
 * │   This asks the database the one question it cares about — is there  │
 * │   an unaccepted retrieval for me — and re-asks it whenever realtime  │
 * │   reports a change to one of this operator's tasks.                  │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   components/AppShell (operators only)                              │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   supabase, hooks/useRealtime, utils/sounds, types                   │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import supabase from '@/supabase'
import { useRealtime } from '@/hooks/useRealtime'
import { startLoudAlarm, stopLoudAlarm } from '@/utils/sounds'
import { ROLES, TASK_STATUS, TASK_TYPES } from '@/types'

/**
 * A slow safety net, not the delivery mechanism.
 *
 * Realtime carries the assignment within a second and is what actually starts
 * the alarm. This exists for the case realtime cannot cover: the websocket
 * dropped while the phone was on a dead patch of hotel wifi and the assignment
 * arrived in the gap. Sixty seconds is late for an alarm but not as late as
 * never, and it costs one tiny query a minute.
 */
const SAFETY_POLL_MS = 60_000

export function useUnacceptedAlarm(operatorId, role) {
  const enabled = role === ROLES.OPERATOR && Boolean(operatorId)
  const [waiting, setWaiting] = useState(0)

  // The alarm is global, so a stale async response must never be allowed to
  // restart it after the operator has accepted.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const check = useCallback(async () => {
    if (!enabled) return

    // head + count: we need "is there one", never the rows themselves, and this
    // runs on every task change all shift.
    const { count, error } = await supabase
      .from('valet_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_operator_id', operatorId)
      .eq('task_type', TASK_TYPES.RETRIEVAL)
      .eq('status', TASK_STATUS.ASSIGNED)

    if (!alive.current) return
    // On error, leave the current state alone. Flipping to zero would silence a
    // live alarm because of one failed request, and a guest is waiting.
    if (error) return

    setWaiting(count ?? 0)
  }, [enabled, operatorId])

  useEffect(() => {
    if (!enabled) {
      setWaiting(0)
      return undefined
    }
    check()
    const id = setInterval(check, SAFETY_POLL_MS)
    return () => clearInterval(id)
  }, [enabled, check])

  // An admin assigning a retrieval arrives as an UPDATE whose new row names
  // this operator — the same filter MyTasks uses for its own list.
  useRealtime({
    channel: 'unaccepted-alarm',
    table: 'valet_tasks',
    filter: operatorId ? `assigned_operator_id=eq.${operatorId}` : undefined,
    enabled,
    onRefetch: check,
  })

  useEffect(() => {
    if (waiting === 0) {
      stopLoudAlarm()
      return undefined
    }
    startLoudAlarm()
    // Signing out or closing the tab must not leave the loop running.
    return stopLoudAlarm
    // The COUNT, not the rows: re-running this on every refetch would stop and
    // restart the loop, which is the stutter the gapless alarm exists to avoid.
  }, [waiting])

  return waiting
}
