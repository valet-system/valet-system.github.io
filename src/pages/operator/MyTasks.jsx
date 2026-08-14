/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/operator/MyTasks.jsx                                │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   CARS TO FETCH, and nothing else. A guest has asked for one and is  │
 * │   standing at the porch waiting. Every row on this screen has a      │
 * │   person attached to it.                                             │
 * │                                                                     │
 * │ ── RETRIEVALS ONLY. PARKING IS NOT HERE ─────────────────────────────│
 * │   The query filters task_type = 'retrieval'. Parking is finished on  │
 * │   the Check In screen: the location field sits under the token,       │
 * │   because keys/stub/drive/park/walk-back is one continuous action     │
 * │   and the operator is already on that screen when they do it.        │
 * │                                                                     │
 * │   A car left unparked — "park this one later", because a second car  │
 * │   pulled up — appears in a "Still to park" strip at the top of Check │
 * │   In, NOT here. It used to land on this screen, and that was wrong   │
 * │   twice over: it read as a task somebody had sent the operator, and  │
 * │   it padded the one list that must never be scrolled past.           │
 * │                                                                     │
 * │ THE CARD                                                             │
 * │   token, car, WHERE TO FETCH IT FROM -> at delivery point ->         │
 * │   10-minute countdown -> guest arrived, or guest absent and park it  │
 * │   again. The re-park step is still here, because it belongs to a     │
 * │   retrieval that went wrong rather than to a fresh check-in.         │
 * │                                                                     │
 * │ EVERY NEW CARD SOUNDS THE ALARM                                      │
 * │   Safe now that the screen is retrievals only: each one was          │
 * │   dispatched by somebody else, to a phone in a pocket, with a guest  │
 * │   already waiting. Parking tasks used to be filtered out of the      │
 * │   alarm by hand — alerting an operator about their own tap trains    │
 * │   them to ignore the sound — and that filter is now the query.       │
 * │                                                                     │
 * │ THE COUNTDOWN IS A CUE, NOT THE RULE                                 │
 * │   expire_stale_pickups() in pg_cron runs every minute and is what    │
 * │   actually returns an un-collected car. This screen never writes a   │
 * │   status change when the timer hits zero — with several operators    │
 * │   and an admin watching the same task, each one would fire it. The   │
 * │   card just goes red and waits for the update to arrive.             │
 * │                                                                     │
 * │ NOTHING HERE SENDS A STATUS                                          │
 * │   Every button calls a named RPC — guestArrived(), guestAbsent() —   │
 * │   and Postgres decides what the task becomes and refuses a move from │
 * │   the wrong current status. A stale screen therefore cannot skip a   │
 * │   step; it gets told to refresh. See lib/valetApi.                   │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   lib/valetApi, lib/serverClock, hooks/useTimer, hooks/useRealtime,  │
 * │   utils/sounds, components/ui/*, utils/format, types                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '@/components/AppShell'
import Button from '@/components/ui/Button'
import Card, { SectionHeading } from '@/components/ui/Card'
import EmptyState from '@/components/ui/EmptyState'
import SpacePicker, { useParkingSpaces } from '@/components/ui/SpacePicker'
import Icon from '@/components/ui/Icon'
import { HeaderSkeleton, RowsSkeleton, SectionHeadingSkeleton } from '@/components/ui/PageSkeleton'
import { TierBadge } from '@/components/ui/Badge'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { useToast } from '@/context/ToastContext'
import useParkSubmit from '@/hooks/useParkSubmit'
import useRealtime from '@/hooks/useRealtime'
import useTimer from '@/hooks/useTimer'
import { noteServerTime } from '@/lib/serverClock'
import {
  completeParking,
  completeReparking,
  guestArrived,
  guestAbsent,
  startPickup,
} from '@/lib/valetApi'
import { supabase, describeDbError } from '@/supabase'
import { alertOnce } from '@/lib/taskAlerts'
import { playSuccess, playWarning } from '@/utils/sounds'
import { formatDuration, formatTime, istDayStart, istToday, personName, prettyCarNumber, timeAgo } from '@/utils/format'
import { ACTIVE_TASK_STATUSES, TASK_STATUS, TASK_TYPES } from '@/types'

/** Everything the cards need, in one round trip. */
const TASK_SELECT = `
  id, task_type, status, return_count, assigned_at, pickup_started_at, completed_at, created_at,
  parked_vehicles ( id, token_number, car_number, car_tier, guest_name, guest_name_hi, guest_phone,
                    parking_location, notes, status, parked_at )
`

export default function MyTasks() {
  const t = useT()
  const { operatorId } = useAuth()
  const toast = useToast()

  const [active, setActive] = useState([])
  const [done, setDone] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  /**
   * Task ids already on screen. A retrieval whose id is not in here is newly
   * dispatched and worth an alarm. Starts null so the FIRST load — which is
   * every task at once — never alarms; an operator opening the app should
   * not be shouted at by their existing work.
   */
  const knownIds = useRef(null)

  // Fetched ONCE for the screen and passed down. A picker per card fetching
  // its own copy would be three identical queries on every refetch.
  // Only the RE-PARK step needs these now that parking lives on Check In. No
  // reload: nothing on this screen fills a space, so the counts cannot go stale
  // from anything the operator does here.
  const { spaces } = useParkingSpaces()

  const load = useCallback(async () => {
    if (!operatorId) return

    // "Completed today" is filtered on completed_at, not on the car's service
    // date: a car checked in at 11pm and collected at 1am was finished on the
    // same shift, and the operator finishing that shift wants to see it.
    //
    // istDayStart, not midnight — the service day begins at 05:30 IST
    // (migration 0026). At midnight the operator's own list would empty out
    // halfway through the night they were still working.
    const dayStart = istDayStart()

    const [activeRes, doneRes] = await Promise.all([
      supabase
        .from('valet_tasks')
        .select(TASK_SELECT)
        .eq('assigned_operator_id', operatorId)
        // RETRIEVALS ONLY. Parking is finished on the Check In screen, which is
        // where the operator already is when they take the keys. A parking task
        // has no business on this screen: nobody is waiting on it, and mixing
        // it in buried the one list that DOES have a guest standing at a porch
        // attached to it.
        .eq('task_type', TASK_TYPES.RETRIEVAL)
        .in('status', ACTIVE_TASK_STATUSES)
        .order('created_at', { ascending: true }),
      supabase
        .from('valet_tasks')
        .select(TASK_SELECT)
        .eq('assigned_operator_id', operatorId)
        .eq('status', TASK_STATUS.COMPLETED)
        .gte('completed_at', dayStart)
        .order('completed_at', { ascending: false })
        .limit(20),
    ])

    if (activeRes.error) {
      setError(describeDbError(activeRes.error, t('tasks.couldNotLoad')))
      setLoading(false)
      return
    }

    const rows = activeRes.data ?? []
    setError(null)
    setActive(rows)
    if (!doneRes.error) setDone(doneRes.data ?? [])
    setLoading(false)

    // ── alarm on anything newly dispatched to this operator ───────────
    const ids = new Set(rows.map((t) => t.id))
    if (knownIds.current) {
      // No task_type test: the query above is retrievals only, so every row
      // here is one. The old filter was there because parking tasks used to
      // arrive on this screen and alerting an operator about their own tap
      // trains them to ignore the sound.
      const fresh = rows.filter((t) => !knownIds.current.has(t.id))
      if (fresh.length > 0) {
        const first = fresh[0]
        // alertOnce, not alertLoud: NotificationBell now alerts too, from
        // push_outbox, so that an operator on ANY screen hears a dispatch. On
        // this screen both detectors see the same event, and keying on the task
        // id means it sounds once. See lib/taskAlerts.
        alertOnce(first.id, {
          // A dispatched retrieval always means a guest is waiting for a car.
          critical: true,
          title:
            fresh.length === 1
              ? t('tasks.alarmOne')
              : t('tasks.alarmMany', { n: fresh.length }),
          body:
            fresh.length === 1
              ? t('tasks.alarmBody', {
                  token: first.parked_vehicles?.token_number,
                  car: prettyCarNumber(first.parked_vehicles?.car_number),
                })
              : t('tasks.alarmOpen'),
          // A tag means a second alert replaces the first in the tray rather
          // than stacking — the operator wants the current state, not history.
          tag: 'valet-new-task',
          // Where a tap lands. Without it every notification opens the app's
          // home page, and the operator has to navigate to the task they were
          // just told about.
          url: '/operator/tasks',
        })
      }
    }
    knownIds.current = ids
  }, [operatorId, t])

  useEffect(() => {
    load()
  }, [load])

  /**
   * Split by kind, retrievals first.
   *
   * Derived rather than fetched separately — one query, one subscription, and
   * one definition of "still open". Two queries would eventually disagree
   * about a status and drop a task off both lists.
   */
  const retrievals = useMemo(
    () => active.filter((t) => t.task_type === TASK_TYPES.RETRIEVAL),
    [active],
  )

  // The filter is on assigned_operator_id, so an admin assigning a retrieval
  // shows up here as an UPDATE whose NEW row names this operator.
  useRealtime({
    channel: `my-tasks:${operatorId}`,
    table: 'valet_tasks',
    filter: operatorId ? `assigned_operator_id=eq.${operatorId}` : undefined,
    enabled: Boolean(operatorId),
    onRefetch: load,
  })

  /** Shared by every button: run it, toast the outcome, refresh. */
  /**
   * Returns the RESULT, not a boolean: LocationForm needs the error CODE to
   * tell a full parking space apart from every other refusal.
   */
  const run = async (action, successMessage) => {
    const result = await action()
    if (!result.ok) {
      // SPACE_FULL is shown inline, beside the picker, with the override
      // button next to it. A toast as well would be the same sentence twice,
      // and a toast cannot carry the button.
      if (result.code !== 'SPACE_FULL') toast.error(result.error)
      // A rejected move almost always means this screen is out of date.
      if (result.code === 'WRONG_STATUS' || result.code === 'NOT_FOUND') load()
      return result
    }
    playSuccess()
    toast.success(successMessage)
    load()
    return result
  }

  if (loading) {
    return (
      <>
        <HeaderSkeleton action={false} />
        <SectionHeadingSkeleton />
        <RowsSkeleton rows={2} height="h-52" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('tasks.title')}
        subtitle={
          active.length === 0
            ? t('tasks.nothingAssigned')
            : t(active.length === 1 ? 'tasks.inYourHands' : 'tasks.inYourHands_plural', {
                n: active.length,
              })
        }
        actions={
          <Button variant="secondary" size="md" icon="refresh" onClick={load}>
            {t('common.refresh')}
          </Button>
        }
      />

      {error ? (
        <EmptyState
          variant="error"
          title={t('tasks.couldNotLoad')}
          description={error}
          action={
            <Button variant="secondary" icon="refresh" onClick={load}>
              {t('common.tryAgain')}
            </Button>
          }
        />
      ) : active.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title={t('tasks.allClear')}
          description={t('tasks.allClearBody')}
        />
      ) : (
        <>
          {/* RETRIEVALS FIRST, ALWAYS.
              A guest is standing at the porch waiting for one of these, and
              nobody is waiting on a parking job. If both lists are on screen
              the one with a person attached to it has to be the one under the
              operator's thumb. */}
          {retrievals.length > 0 && (
            <>
              <SectionHeading
                title={t('tasks.fetchThese')}
                count={retrievals.length}
                icon="bell"
                action={
                  <span className="text-xs font-medium text-danger">{t('tasks.guestWaiting')}</span>
                }
              />
              <div className="space-y-3">
                {retrievals.map((task) => (
                  <RetrievalCard
                    key={task.id}
                    task={task}
                    run={run}
                    onRefresh={load}
                    spaces={spaces}
                  />
                ))}
              </div>
            </>
          )}

        </>
      )}

      {done.length > 0 && (
        <div className="mt-8">
          <SectionHeading title={t('tasks.completedToday')} count={done.length} icon="check-circle" />
          <Card padded={false} className="divide-y divide-line">
            {done.map((task) => (
              <div key={task.id} className="flex items-center gap-3 px-4 py-3">
                <span className="tnum flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-xs font-bold text-ink-muted">
                  {task.parked_vehicles?.token_number}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {prettyCarNumber(task.parked_vehicles?.car_number)}
                  </span>
                  <span className="block text-xs text-ink-subtle">
                    {t('tasks.atTime', {
                      what: t(
                        task.task_type === TASK_TYPES.PARKING ? 'tasks.parked' : 'tasks.delivered',
                      ),
                      time: formatTime(task.completed_at),
                    })}
                  </span>
                </span>
                <Icon name="check-circle" size={17} className="shrink-0 text-success" />
              </div>
            ))}
          </Card>
        </div>
      )}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════
// SHARED CARD PARTS
// ═══════════════════════════════════════════════════════════════════

/**
 * Token, car number and tier. The token is 48px because it is what the
 * operator matches against the paper stub in their hand, at arm's length,
 * outdoors.
 */
function CarHeading({ vehicle, children }) {
  const t = useT()

  return (
    <div className="flex items-start gap-4">
      <div className="shrink-0 text-center">
        <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-subtle">
          {t('common.token')}
        </p>
        <p className="tnum text-5xl font-bold leading-none tracking-tight text-ink">
          {vehicle?.token_number ?? '—'}
        </p>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-semibold tracking-wide text-ink">
            {prettyCarNumber(vehicle?.car_number)}
          </span>
          <TierBadge tier={vehicle?.car_tier} size="sm" />
        </div>
        {vehicle?.guest_name && (
          <p className="mt-0.5 truncate text-sm text-ink-muted">
            {personName(vehicle.guest_name, vehicle.guest_name_hi)}
          </p>
        )}
        {children}
      </div>
    </div>
  )
}

/** A note the operator wrote at check-in — a scratch, a child seat. */
function NotesLine({ notes }) {
  if (!notes) return null
  return (
    <p className="mt-3 flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
      <Icon name="info" size={15} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{notes}</span>
    </p>
  )
}

/**
 * The parking-location field, shared by "Car Parked" and "Car Re-parked".
 * Kept as its own component so the input keeps its own state and typing does
 * not re-render every other card in the list on every keystroke.
 */
function LocationForm({ label, buttonLabel, buttonIcon, onSubmit, spaces }) {
  const t = useT()
  const [location, setLocation] = useState('')
  const [localError, setLocalError] = useState(null)

  // onSubmit takes (location, force) and returns the raw API result, so a full
  // space can be told apart and offered an override. See hooks/useParkSubmit.
  const park = useParkSubmit(onSubmit)

  const submit = async () => {
    const value = location.trim()
    if (!value) {
      setLocalError(t('checkin.tapPlace'))
      return
    }
    setLocalError(null)
    // On failure the card stays put, so keep what they typed.
    if (await park.submit(value)) setLocation('')
  }

  return (
    <div className="mt-4 space-y-3">
      <SpacePicker
        id={`loc-${label}`}
        label={label}
        value={location}
        onChange={(v) => {
          setLocation(v)
          setLocalError(null)
          park.reset()
        }}
        spaces={spaces}
        error={localError ?? park.error}
      />

      {park.needsConfirm && (
        <Button
          variant="warning"
          fullWidth
          icon="alert"
          onClick={async () => {
            if (await park.confirm()) setLocation('')
          }}
          loadingText={t('common.saving')}
        >
          {t('places.confirmFull')}
        </Button>
      )}

      <Button variant="success" fullWidth icon={buttonIcon} onClick={submit}>
        {buttonLabel}
      </Button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// RETRIEVAL CARD
// ═══════════════════════════════════════════════════════════════════

function RetrievalCard({ task, run, onRefresh, spaces }) {
  const t = useT()
  const vehicle = task.parked_vehicles
  const isAtPickup = task.status === TASK_STATUS.AT_PICKUP
  const needsReparking =
    task.status === TASK_STATUS.RE_PARKING || task.status === TASK_STATUS.RETURNED

  const { secondsLeft, isWarning, isExpired } = useTimer(
    // Null unless a hand-over is actually running, so the hook idles on the
    // other states instead of counting against a stale timestamp.
    isAtPickup ? task.pickup_started_at : null,
    {
      onWarning: playWarning,
      // Do NOT write a status change here. pg_cron owns the expiry — see the
      // file header. This only nudges the screen to catch up.
      onExpire: onRefresh,
    },
  )

  return (
    <Card accent={isWarning || isExpired ? 'danger' : 'warning'}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-warning">
          <Icon name="car" size={16} />
          {t(needsReparking ? 'tasks.parkThisCarAgain' : 'tasks.fetchThisCar')}
        </span>
        {task.return_count > 0 && (
          <span className="text-xs font-semibold text-danger">
            {t('tasks.noShow', { n: task.return_count })}
          </span>
        )}
      </div>

      <CarHeading vehicle={vehicle}>
        {/* The whole point of the retrieval card: where to walk to. */}
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-brand-soft px-2.5 py-1.5 text-sm font-semibold text-ink">
          <Icon name="location" size={15} className="text-ink-subtle" />
          {vehicle?.parking_location || t('common.notRecorded')}
        </p>
      </CarHeading>

      <NotesLine notes={vehicle?.notes} />

      {/* ── assigned: not there yet ───────────────────────────────── */}
      {!isAtPickup && !needsReparking && (
        <Button
          variant="primary"
          fullWidth
          icon="arrow-right"
          className="mt-4"
          onClick={() =>
            run(() => startPickup(task.id).then(noteStart), t('tasks.timerStarted'))
          }
        >
          {t('tasks.atDeliveryPoint')}
        </Button>
      )}

      {/* ── at the delivery point: the countdown ──────────────────── */}
      {isAtPickup && (
        <div className="mt-4">
          <Countdown secondsLeft={secondsLeft} isWarning={isWarning} isExpired={isExpired} />

          {/* Both buttons stay visible the whole time, including past zero:
              a guest who turns up at 10:30 still gets their car, and the
              operator must never have to hunt for the right button. */}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Button
              variant="success"
              fullWidth
              icon="check"
              onClick={() =>
                run(
                  () => guestArrived(task.id),
                  t('tasks.toastDelivered', { token: vehicle?.token_number }),
                )
              }
            >
              {t('tasks.guestArrived')}
            </Button>
            <Button
              variant="danger"
              fullWidth
              icon="x"
              onClick={() =>
                run(() => guestAbsent(task.id), t('tasks.toastAbsent'))
              }
            >
              {t('tasks.guestAbsent')}
            </Button>
          </div>
        </div>
      )}

      {/* ── no-show: park it again ────────────────────────────────── */}
      {needsReparking && (
        <>
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
            <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
            <span>{t('tasks.guestDidNotCollect')}</span>
          </p>
          <LocationForm
            label={t('tasks.whereParkedAgain')}
            spaces={spaces}
            buttonLabel={t('tasks.carReparked')}
            buttonIcon="parking"
            onSubmit={(location, force) =>
              run(
                () => completeReparking(task.id, location, force),
                t('tasks.toastParkedAgain', { token: vehicle?.token_number }),
              )
            }
          />
        </>
      )}

      <p className="mt-3 text-xs text-ink-subtle">
        {t('tasks.requestedAgo', { ago: timeAgo(task.created_at) })}
        {task.assigned_at ? t('tasks.assignedAgo', { ago: timeAgo(task.assigned_at) }) : ''}
      </p>
    </Card>
  )
}

/**
 * startPickup returns the server's own now(). Feeding it to serverClock is
 * how the countdown stays honest on a phone whose clock is wrong — which is
 * most cheap Androids with automatic time switched off.
 */
function noteStart(result) {
  if (result.ok) noteServerTime(result.pickup_started_at)
  return result
}

function Countdown({ secondsLeft, isWarning, isExpired }) {
  const t = useT()
  const tone = isExpired || isWarning ? 'text-danger' : 'text-ink'

  return (
    <div
      className={
        isExpired || isWarning
          ? 'rounded-xl bg-danger-soft px-4 py-3 text-center'
          : 'rounded-xl bg-surface-sunken px-4 py-3 text-center'
      }
      // Polite, not assertive: the number changes every second and an
      // assertive region would have a screen reader read all of them.
      aria-live="polite"
    >
      <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-subtle">
        {t(isExpired ? 'tasks.timeUp' : 'tasks.guestHas')}
      </p>
      <p className={`tnum text-4xl font-bold leading-tight tracking-tight ${tone}`}>
        {formatDuration(secondsLeft ?? 0)}
      </p>
      <p className="text-xs text-ink-subtle">
        {t(isExpired ? 'tasks.willReturnAuto' : 'tasks.untilBack')}
      </p>
    </div>
  )
}
