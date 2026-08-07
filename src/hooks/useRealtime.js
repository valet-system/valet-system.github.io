/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/hooks/useRealtime.js                                      │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   One Postgres-changes subscription, with the cleanup, the reconnect │
 * │   handling and the refetch throttling that every page would          │
 * │   otherwise re-implement and one of them would get wrong.            │
 * │                                                                     │
 * │     useRealtime({ channel, table, filter, onEvent, onRefetch })      │
 * │                                                                     │
 * │ ── THE SCALING PROBLEM THIS SOLVES ──────────────────────────────────│
 * │                                                                     │
 * │ Every page used to pass `onChange: load` — a full refetch per        │
 * │ event. That is fine with three operators and it does not survive an  │
 * │ event night, because the cost is a PRODUCT, not a sum.               │
 * │                                                                     │
 * │ One property, 20 operators and 2 admins signed in. Each of them is   │
 * │ subscribed to the same `property_id=eq.X` filter, and each page      │
 * │ refetch is 2–5 queries. So ONE car being checked in becomes ~22      │
 * │ clients × ~3 queries = 66 queries, nearly all of them returning      │
 * │ byte-identical data.                                                │
 * │                                                                     │
 * │ A car generates about six row changes over its life (check-in,       │
 * │ parked, requested, assigned, at pickup, delivered). A 1000-car event │
 * │ day is ~6000 changes, and they are not spread evenly — they bunch    │
 * │ into the dinner peak. At 5 changes/second that is ~330 queries a     │
 * │ second of pure amplification.                                        │
 * │                                                                     │
 * │ TWO THINGS FIX IT, AND BOTH ARE NEEDED                               │
 * │                                                                     │
 * │   COALESCE — events inside COALESCE_MS collapse into one refetch.    │
 * │     Realtime events arrive in bursts, because one RPC writes         │
 * │     valet_tasks AND parked_vehicles in the same transaction, so a    │
 * │     single operator tap already fires two events on most pages.      │
 * │                                                                     │
 * │   RATE LIMIT — never more than one refetch per MIN_INTERVAL_MS.      │
 * │     Coalescing alone does nothing against a STEADY stream: 5         │
 * │     events a second spaced 200ms apart never fall in the same        │
 * │     window, so every one still triggers a refetch.                   │
 * │                                                                     │
 * │ The trade is latency, and it is the right trade: a queue that        │
 * │ updates 1.5s late is not a problem anybody can perceive, whereas a   │
 * │ database that stops answering during the dinner rush stops the       │
 * │ porch.                                                               │
 * │                                                                     │
 * │ A RESYNC IS NOT RATE LIMITED. It means "you have already missed      │
 * │ things", so it runs immediately and cancels any pending timer.       │
 * │                                                                     │
 * │ ── WHY onResync EXISTS — the part that is easy to miss ──────────────│
 * │   Realtime is a live stream, not a queue. Nothing is replayed. When  │
 * │   an operator's phone sleeps in their pocket, or they walk into the  │
 * │   basement level of the car park, the socket drops. It reconnects    │
 * │   by itself a minute later — and every event that happened in        │
 * │   between is simply gone.                                            │
 * │                                                                     │
 * │   The screen then looks perfectly healthy while showing a task that  │
 * │   was reassigned ten minutes ago, and the operator walks to a car    │
 * │   somebody else has already delivered. A subscription alone is not   │
 * │   enough: after any gap you have to REFETCH.                         │
 * │                                                                     │
 * │   So a resync fires on all three of the things that mean "you may    │
 * │   have missed something":                                            │
 * │     the tab became visible again                                     │
 * │     the browser came back online                                     │
 * │     the channel resubscribed after an error or timeout               │
 * │                                                                     │
 * │ WHY THE HANDLERS SIT IN A REF                                        │
 * │   Callers pass inline arrows. If the effect depended on them it      │
 * │   would tear down and rebuild the websocket subscription on every    │
 * │   single render — which drops events during the gap and, on a page   │
 * │   that refetches on resync, loops.                                   │
 * │                                                                     │
 * │ CHANNEL NAMES MUST BE UNIQUE PER SUBSCRIPTION                        │
 * │   Two components sharing a name get one channel between them and     │
 * │   the second unmount removes it from under the first. Include the    │
 * │   id you are filtering on, e.g. `tasks:${operatorId}`.                │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   operator/CheckIn, operator/MyTasks, operator/TodaysCars,           │
 * │   admin/Dashboard, admin/TokenMgmt                                    │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase (the singleton client)                                │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useRef } from 'react'
import { supabase } from '@/supabase'

/**
 * Long enough to swallow the two-events-per-transaction case and an operator
 * double-tapping; short enough that nobody watching the screen notices.
 */
const COALESCE_MS = 400

/** Ceiling on refetch frequency under a sustained stream. */
const MIN_INTERVAL_MS = 1500

/**
 * @param options.channel   unique channel name — include the filtered id
 * @param options.table     public table to watch, e.g. 'valet_tasks'
 * @param options.filter    Postgres-changes filter, e.g. 'property_id=eq.<uuid>'
 * @param options.event     'INSERT' | 'UPDATE' | 'DELETE' | '*' (default '*')
 * @param options.enabled   false while ids are still loading — the hook idles
 * @param options.onEvent   (payload) => void. EVERY event, no throttling. For
 *                          things that must not be merged away — a sound, a
 *                          notification. Keep it cheap: no queries in here.
 * @param options.onRefetch () => void. Coalesced and rate limited. This is
 *                          where a full reload belongs. Also fires
 *                          immediately after any gap in the stream.
 */
export function useRealtime({
  channel,
  table,
  filter,
  event = '*',
  enabled = true,
  onEvent,
  onRefetch,
}) {
  const handlers = useRef({ onEvent, onRefetch })
  handlers.current = { onEvent, onRefetch }

  // Kept in refs, not state: changing either must never re-render, let alone
  // rebuild the subscription.
  const timer = useRef(null)
  const lastRunAt = useRef(0)

  useEffect(() => {
    if (!enabled || !channel || !table) return undefined

    let cancelled = false

    const run = () => {
      timer.current = null
      if (cancelled) return
      lastRunAt.current = Date.now()
      handlers.current.onRefetch?.()
    }

    /** Coalesce + rate limit. */
    const schedule = () => {
      // Already scheduled — this event folds into that run. This is the
      // coalescing: the timer is NOT reset, or a steady stream of events
      // would push it back forever and the page would never update at all.
      if (timer.current) return

      const sinceLast = Date.now() - lastRunAt.current
      const wait = Math.max(COALESCE_MS, MIN_INTERVAL_MS - sinceLast)
      timer.current = setTimeout(run, wait)
    }

    /** A gap means data is already stale. Jump the queue. */
    const resync = () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      run()
    }

    // True once the channel has been up at least once. Without it, the very
    // first SUBSCRIBED would count as a reconnection and fire a refetch on
    // top of the page's own initial load.
    let hasSubscribed = false

    const ch = supabase
      .channel(channel)
      .on(
        'postgres_changes',
        { event, schema: 'public', table, ...(filter ? { filter } : {}) },
        (payload) => {
          handlers.current.onEvent?.(payload)
          schedule()
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          if (hasSubscribed) resync()
          hasSubscribed = true
          return
        }
        // CHANNEL_ERROR / TIMED_OUT: supabase-js retries on its own. Nothing
        // to do but note it — the resync fires when it comes back up.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`[realtime] ${channel}: ${status}, will retry`)
        }
      })

    // A locked phone gets no events and no socket close either — the wake-up
    // is the only signal that time passed.
    const onVisible = () => {
      if (document.visibilityState === 'visible') resync()
    }

    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', resync)

    return () => {
      cancelled = true
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', resync)
      // removeChannel, not unsubscribe: unsubscribe leaves the channel in the
      // client's registry, so remounting (StrictMode does this in dev, and so
      // does any route change back) finds the stale name and silently gets no
      // events at all.
      supabase.removeChannel(ch)
    }
  }, [channel, table, filter, event, enabled])
}

export default useRealtime
