/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/admin/Dashboard.jsx                                 │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The retrieval queue. A guest has asked for their car; this is      │
 * │   where an admin picks who fetches it. It is the only screen in the  │
 * │   system where someone is actively waiting on the other side of the  │
 * │   decision, so everything else on it is subordinate to that list.    │
 * │                                                                     │
 * │ WHY THERE IS NO PARKING QUEUE                                        │
 * │   Nobody dispatches a parking job. The operator who takes the keys   │
 * │   at the porch parks the car, and CheckIn assigns the task to them   │
 * │   as it creates it. Today's check-in count appears here as           │
 * │   information; there is nothing to action.                           │
 * │                                                                     │
 * │ EVERY STAT TILE STAYS ON THIS PAGE                                    │
 * │   Two of them used to open Analytics, which answers a different       │
 * │   question — Analytics is trends over weeks, these four are RIGHT     │
 * │   NOW. They scroll to the section that breaks the number down.        │
 * │                                                                     │
 * │   "Cars today" and "Delivered" go to admin/CarStatus, which is where  │
 * │   the breakdown and the cars themselves live. That started as a       │
 * │   section HERE and was moved out: a list of ninety parked cars under  │
 * │   the retrieval queue pushes the queue off screen during exactly the  │
 * │   rush it is needed in.                                              │
 * │                                                                     │
 * │ THE FREE-OPERATOR LIST IS NEVER FILTERED IN REACT                    │
 * │   It comes from get_available_operators(), which excludes anyone     │
 * │   holding an open task at that moment. Filtering a staff list here   │
 * │   would act on whatever was true when the page loaded — and the      │
 * │   whole point of this screen is that it changes while you look at    │
 * │   it. assign_retrieval() re-checks on the server anyway, so a stale  │
 * │   dropdown is refused rather than double-booking someone.            │
 * │                                                                     │
 * │ ONE PULSING CARD, AND ONLY ONE KIND                                  │
 * │   Card `urgent` is reserved for an unassigned retrieval. Nothing     │
 * │   else on this screen may use it. If three things pulse, nothing     │
 * │   does.                                                             │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   lib/valetApi, hooks/useRealtime, utils/sounds, components/ui/*,    │
 * │   utils/format, types                                                │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '@/components/AppShell'
import Button from '@/components/ui/Button'
import Card, { SectionHeading } from '@/components/ui/Card'
import { SearchInput } from '@/components/ui/Field'
import EmptyState from '@/components/ui/EmptyState'
import Icon from '@/components/ui/Icon'
import {
  HeaderSkeleton,
  RowsSkeleton,
  SectionHeadingSkeleton,
  StatRowSkeleton,
} from '@/components/ui/PageSkeleton'
import StatTile, { StatRow } from '@/components/ui/StatTile'
import { TaskStatusBadge, TierBadge } from '@/components/ui/Badge'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { useToast } from '@/context/ToastContext'
import useRealtime from '@/hooks/useRealtime'
import { assignRetrieval, availableOperators, dispatchVehicle } from '@/lib/valetApi'
import { supabase, describeDbError, selectOptional } from '@/supabase'
import { alertLoud, playSuccess } from '@/utils/sounds'
import { formatPhone, istToday, personName, prettyCarNumber, timeAgo } from '@/utils/format'
import { ACTIVE_TASK_STATUSES, CAR_TIERS, TASK_TYPES, VEHICLE_AT_REST, VEHICLE_STATUS } from '@/types'

/**
 * Two variants, because name_hi arrives with migration 0022 and this screen
 * must keep working on a database that has not run it yet — a guest is
 * standing at the porch waiting for one of these rows. See selectOptional.
 */
const TASK_SELECT_BASE = `
  id, task_type, status, return_count, created_at, assigned_at, pickup_started_at,
  assigned_operator_id,
  parked_vehicles ( id, token_number, car_number, car_tier, guest_name, guest_name_hi, guest_phone,
                    parking_location, notes ),
`
const TASK_SELECT = `${TASK_SELECT_BASE} operator:user_roles ( id, name, name_hi, phone )`
const TASK_SELECT_NO_HI = `${TASK_SELECT_BASE} operator:user_roles ( id, name, phone )`

/**
 * Scrolls a section into view when its tile is tapped.
 *
 * `block: 'start'` and not `'center'`: the top bar is sticky, so centring puts
 * the heading behind it. scroll-mt on the target handles the rest.
 *
 * Honours prefers-reduced-motion, because a smooth scroll down a long queue is
 * exactly the kind of movement that makes some people motion-sick.
 */
function scrollToSection(id) {
  const el = document.getElementById(id)
  if (!el) return

  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

export default function Dashboard() {
  const t = useT()
  const { propertyId, propertyName } = useAuth()
  const toast = useToast()

  const [pending, setPending] = useState([])

  /**
   * Finding a car NOBODY has asked for.
   *
   * The queue above only holds cars a guest requested. A guest who walks up to
   * the desk instead is not in it and never will be — so this is how they are
   * reached: type the name or the number, pick an operator, send them.
   *
   * Deliberately NOT a full list of every parked car. At a busy property that
   * is a couple of hundred cards pushing the urgent queue off the screen, and
   * the urgent queue is what this page is for. Empty search, nothing rendered.
   */
  const [carQuery, setCarQuery] = useState('')
  const [carTerm, setCarTerm] = useState('')
  const [found, setFound] = useState([])
  const [searching, setSearching] = useState(false)
  const [active, setActive] = useState([])
  const [operators, setOperators] = useState([])
  /** Every status string for today's cars, in one array. Counted in `counts`. */
  const [statuses, setStatuses] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  /** Pending task ids already seen, so only genuinely new requests alarm. */
  const knownIds = useRef(null)

  const load = useCallback(async () => {
    if (!propertyId) return
    const today = istToday()

    // Oldest first on the pending list: the guest who has waited longest is
    // the one to send someone to, and putting them at the top makes that the
    // default.
    const pendingQuery = (columns) =>
      supabase
        .from('valet_tasks')
        .select(columns)
        .eq('property_id', propertyId)
        .eq('task_type', TASK_TYPES.RETRIEVAL)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })

    const activeQuery = (columns) =>
      supabase
        .from('valet_tasks')
        .select(columns)
        .eq('property_id', propertyId)
        .in('status', ACTIVE_TASK_STATUSES)
        .order('assigned_at', { ascending: true })

    const [pendingRes, activeRes, statusRes, opsRes] = await Promise.all([
      selectOptional(
        () => pendingQuery(TASK_SELECT),
        () => pendingQuery(TASK_SELECT_NO_HI),
        'user_roles.name_hi',
      ),
      selectOptional(
        () => activeQuery(TASK_SELECT),
        () => activeQuery(TASK_SELECT_NO_HI),
        'user_roles.name_hi',
      ),
      // ONE column for today's cars, counted here. It replaces two head-count
      // queries and answers every status at once — a `status` string per car is
      // a few kB even at a thousand cars, and eight separate count queries
      // would be eight round trips for the same answer.
      supabase
        .from('parked_vehicles')
        .select('status')
        .eq('property_id', propertyId)
        .eq('service_date', today),
      availableOperators(propertyId),
    ])

    if (pendingRes.error) {
      setError(describeDbError(pendingRes.error, t('queue.couldNotLoad')))
      setLoading(false)
      return
    }

    const rows = pendingRes.data ?? []
    setError(null)
    setPending(rows)
    if (!activeRes.error) setActive(activeRes.data ?? [])
    setStatuses(statusRes.error ? [] : (statusRes.data ?? []).map((v) => v.status))
    // A failed operator fetch is not fatal — the queue still has to render, and
    // an admin can see who is waiting even if the dropdown is temporarily empty.
    if (opsRes.ok) setOperators(opsRes.rows ?? [])
    setLoading(false)

    // ── alarm on a genuinely new request ──────────────────────────────
    const ids = new Set(rows.map((t) => t.id))
    if (knownIds.current) {
      const fresh = rows.filter((t) => !knownIds.current.has(t.id))
      if (fresh.length > 0) {
        const first = fresh[0].parked_vehicles
        alertLoud(
          fresh.length === 1
            ? t('queue.carRequested')
            : t('queue.carsRequested', { n: fresh.length }),
          fresh.length === 1
            ? t('tasks.alarmBody', {
                token: first?.token_number,
                car: prettyCarNumber(first?.car_number),
              })
            : t('queue.openQueue'),
          'valet-retrieval',
          '/admin/dashboard',
        )
      }
    }
    knownIds.current = ids
  }, [propertyId, t])

  useEffect(() => {
    load()
  }, [load])

  useRealtime({
    channel: `admin-tasks:${propertyId}`,
    table: 'valet_tasks',
    filter: propertyId ? `property_id=eq.${propertyId}` : undefined,
    enabled: Boolean(propertyId),
    onRefetch: load,
  })

  /**
   * Today's cars grouped into the four states an admin actually asks about.
   *
   * Nine vehicle statuses exist; four questions get asked. "In progress" folds
   * together being-parked, requested, being-fetched and at-the-door — they are
   * all "somebody is working on this right now", and splitting them into four
   * more tiles would bury the two numbers that matter.
   *
   * `returned` counts as re-parked, not as parked: a car whose guest did not
   * turn up is sitting in the car park AND is a thing that went wrong, and
   * losing that in with the ordinary parked cars hides it.
   */
  const counts = useMemo(() => {
    const n = (...wanted) => statuses.filter((s) => wanted.includes(s)).length

    return {
      total: statuses.length,
      parked: n(VEHICLE_STATUS.PARKED),
      inProgress: n(
        VEHICLE_STATUS.CHECKED_IN,
        VEHICLE_STATUS.PARKING,
        VEHICLE_STATUS.REQUESTED,
        VEHICLE_STATUS.FETCHING,
        VEHICLE_STATUS.AT_PICKUP,
      ),
      reParked: n(VEHICLE_STATUS.RE_PARKING, VEHICLE_STATUS.RETURNED),
      delivered: n(VEHICLE_STATUS.DELIVERED),
    }
  }, [statuses])

  // 300ms, same as every other search in the app: a typed car number is one
  // query instead of ten.
  useEffect(() => {
    const id = setTimeout(() => setCarTerm(carQuery.trim()), 300)
    return () => clearTimeout(id)
  }, [carQuery])

  useEffect(() => {
    if (carTerm.length < 2) {
      setFound([])
      return
    }
    let cancelled = false
    setSearching(true)
    supabase
      .rpc('search_todays_cars', { p_query: carTerm, p_limit: 20 })
      .then(({ data }) => {
        if (cancelled) return
        // Only cars actually on site. A car already being fetched, at the gate,
        // or handed over must not be offered — sending a second operator for it
        // produces two people and one car.
        setFound((data ?? []).filter((c) => VEHICLE_AT_REST.includes(c.status)))
        setSearching(false)
      })
    return () => {
      cancelled = true
    }
  }, [carTerm])

  /**
   * Send someone for a car the guest never asked for.
   *
   * One call, not request-then-assign: if the second half failed the car would
   * be left carrying a request nobody made, at the top of the queue, with the
   * guest told their car is coming. See migration 0045.
   */
  const handleDispatch = async (vehicleId, operatorId, token) => {
    const result = await dispatchVehicle(vehicleId, operatorId)
    if (!result.ok) {
      toast.error(result.error)
      load()
      return
    }
    playSuccess()
    const assigned = operators.find((op) => op.id === operatorId)
    toast.success(
      t('queue.sentTo', {
        name: assigned ? personName(assigned.name, assigned.name_hi) : result.operator_name,
      }),
    )
    // Clear the search: that car is now in the queue above, and leaving it in
    // the results invites a second dispatch of a car already on its way.
    setCarQuery('')
    setFound([])
    load()
  }

  const handleAssign = async (taskId, operatorId) => {
    const result = await assignRetrieval(taskId, operatorId)
    if (!result.ok) {
      toast.error(result.error)
      // OPERATOR_BUSY and WRONG_STATUS both mean this screen is behind.
      load()
      return
    }
    playSuccess()
    // Looked up locally rather than taken from result.operator_name, which is
    // English: this list already carries the Hindi spelling and assign_retrieval
    // was left alone (see migration 0022). Falls back to the server's name if
    // the operator has somehow dropped out of the list since it loaded.
    const assigned = operators.find((op) => op.id === operatorId)
    toast.success(
      t('queue.sentTo', {
        name: assigned ? personName(assigned.name, assigned.name_hi) : result.operator_name,
      }),
    )
    load()
  }

  // Two tall placeholders, not four short ones: a pending card carries a
  // token, a car, a location, a waiting time and an assign row.
  if (loading) {
    return (
      <>
        <HeaderSkeleton />
        <StatRowSkeleton />
        <SectionHeadingSkeleton />
        <RowsSkeleton rows={2} height="h-56" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('queue.title')}
        subtitle={propertyName}
        actions={
          <Button variant="secondary" size="md" icon="refresh" onClick={load}>
            {t('common.refresh')}
          </Button>
        }
      />

      {/* Every tile stays on THIS page. They used to send "Cars today" and
          "Delivered" off to Analytics, which answers a different question —
          Analytics is about trends over weeks, and these four are about right
          now. The breakdown they belong to is the Car status section below. */}
      <StatRow className="mb-6">
        <StatTile
          label={t('queue.carsToday')}
          value={counts.total}
          icon="car"
          to="/admin/car-status"
          hint={t('queue.whereEveryCar')}
        />
        <StatTile
          label={t('queue.waiting')}
          value={pending.length}
          icon="bell"
          tone={pending.length > 0 ? 'danger' : 'neutral'}
          hint={t(pending.length > 0 ? 'queue.assignSomeone' : 'queue.nobodyWaiting')}
          onClick={pending.length > 0 ? () => scrollToSection('queue-waiting') : undefined}
        />
        <StatTile
          label={t('queue.inProgress')}
          value={active.length}
          icon="car"
          tone="info"
          // A hint in BOTH states. Passing undefined at zero left this one
          // tile with a blank where its three neighbours had a line, and a row
          // of four cards with one short is read as something failing to load.
          hint={t(active.length > 0 ? 'queue.beingWorkedOn' : 'queue.nothingInHand')}
          onClick={active.length > 0 ? () => scrollToSection('queue-active') : undefined}
        />
        <StatTile
          label={t('queue.delivered')}
          value={counts.delivered}
          icon="check-circle"
          tone="success"
          to="/admin/car-status"
          // Was queue.whereEveryCar — the same line as the Cars today tile two
          // cards to the left, which made the row look like a rendering fault.
          hint={t('queue.handedBackToday')}
        />
      </StatRow>

      <SectionHeading
        title={t('queue.waitingForCar')}
        count={pending.length}
        icon="bell"
        className="scroll-mt-24"
        id="queue-waiting"
      />

      {/* ── SEARCH: a car nobody asked for ──────────────────────────────
          Above the queue because that is where it is reached from — a guest is
          standing at the desk and the admin is typing, not scrolling. Costs one
          input line when empty; results only exist while something is typed. */}
      <div className="mb-4">
        <SearchInput
          value={carQuery}
          onChange={(e) => setCarQuery(e.target.value)}
          onClear={() => setCarQuery('')}
          placeholder={t('queue.searchToSend')}
        />

        {carTerm.length >= 2 && (
          <div className="mt-3 space-y-3">
            {searching && found.length === 0 ? (
              <p className="px-1 text-sm text-ink-subtle">{t('common.loading')}</p>
            ) : found.length === 0 ? (
              // Said plainly, because there are two reasons for an empty result
              // and only one of them is "no such car".
              <p className="px-1 text-sm text-ink-subtle">{t('queue.noParkedMatch')}</p>
            ) : (
              found.map((car) => (
                <SendCard
                  key={car.id}
                  car={car}
                  operators={operators}
                  onDispatch={handleDispatch}
                />
              ))
            )}
          </div>
        )}
      </div>

      {error ? (
        <EmptyState
          variant="error"
          title={t('queue.couldNotLoad')}
          description={error}
          action={
            <Button variant="secondary" icon="refresh" onClick={load}>
              {t('common.tryAgain')}
            </Button>
          }
        />
      ) : pending.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title={t('queue.nobodyIsWaiting')}
          description={t('queue.nobodyIsWaitingBody')}
        />
      ) : (
        <div className="space-y-3">
          {pending.map((task) => (
            <PendingCard
              key={task.id}
              task={task}
              operators={operators}
              onAssign={handleAssign}
            />
          ))}
        </div>
      )}

      {active.length > 0 && (
        <div className="mt-8">
          <SectionHeading
            title={t('queue.inProgress')}
            count={active.length}
            icon="car"
            className="scroll-mt-24"
            id="queue-active"
          />
          <div className="space-y-2">
            {active.map((task) => (
              <ActiveRow key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}

    </>
  )
}

// ═══════════════════════════════════════════════════════════════════
// PENDING — the only cards that pulse
// ═══════════════════════════════════════════════════════════════════

/**
 * A car found by search, with an operator picker.
 *
 * Quieter than PendingCard on purpose: that card is urgent because a guest has
 * been waiting and the clock is running. This one is a car sitting in a bay
 * that somebody has just walked up and asked for — same action, no alarm.
 */
function SendCard({ car, operators, onDispatch }) {
  const t = useT()
  const [operatorId, setOperatorId] = useState('')
  const isVip = car.car_tier === CAR_TIERS.VIP

  return (
    <Card accent={isVip ? 'vip' : undefined}>
      <div className="flex items-start gap-4">
        <div className="shrink-0 text-center">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-subtle">
            {t('common.token')}
          </p>
          <p className="tnum text-3xl font-bold leading-none tracking-tight text-ink">
            {car.token_number}
          </p>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tracking-wide text-ink">
              {prettyCarNumber(car.car_number)}
            </span>
            <TierBadge tier={car.car_tier} size="sm" />
          </div>

          <p className="mt-0.5 truncate text-sm text-ink-muted">
            {personName(car.guest_name, car.guest_name_hi) || t('common.guest')}
            {car.guest_phone && (
              <span className="tnum text-ink-subtle"> · {formatPhone(car.guest_phone)}</span>
            )}
          </p>

          {/* Where to walk to. The operator is being sent somewhere. */}
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-surface-sunken px-2.5 py-1.5 text-sm font-semibold text-ink">
            <Icon name="location" size={15} className="text-ink-subtle" />
            {car.parking_location || t('common.notRecorded')}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <select
          value={operatorId}
          onChange={(e) => setOperatorId(e.target.value)}
          aria-label={t('queue.assignTo', { token: car.token_number })}
          className="h-touch flex-1 rounded-xl border border-line-strong bg-surface px-4 text-base text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        >
          <option value="">
            {t(operators.length === 0 ? 'queue.everyoneBusy' : 'queue.chooseOperator')}
          </option>
          {operators.map((op) => (
            <option key={op.id} value={op.id}>
              {personName(op.name, op.name_hi)}
            </option>
          ))}
        </select>

        <Button
          variant="primary"
          icon="arrow-right"
          disabled={!operatorId}
          onClick={() => onDispatch(car.id, operatorId, car.token_number)}
          className="sm:w-40"
        >
          {t('queue.sendFor')}
        </Button>
      </div>
    </Card>
  )
}

function PendingCard({ task, operators, onAssign }) {
  const t = useT()
  const vehicle = task.parked_vehicles
  const [operatorId, setOperatorId] = useState('')
  const isVip = vehicle?.car_tier === CAR_TIERS.VIP

  const assign = () => {
    if (!operatorId) return undefined
    return onAssign(task.id, operatorId)
  }

  return (
    <Card urgent accent={isVip ? 'vip' : 'danger'}>
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

          <p className="mt-0.5 truncate text-sm text-ink-muted">
            {personName(vehicle?.guest_name, vehicle?.guest_name_hi) || t('common.guest')}
            {vehicle?.guest_phone && (
              <span className="tnum text-ink-subtle"> · {formatPhone(vehicle.guest_phone)}</span>
            )}
          </p>

          {/* Where the operator has to walk to. Without it they are searching
              a multi-level car park with nothing to go on. */}
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-brand-soft px-2.5 py-1.5 text-sm font-semibold text-ink">
            <Icon name="location" size={15} className="text-ink-subtle" />
            {vehicle?.parking_location || t('common.notRecorded')}
          </p>

          {/* The number that decides who to assign first. */}
          <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-danger">
            <Icon name="clock" size={15} />
            {t('queue.waitingFor', { ago: timeAgo(task.created_at) })}
            {task.return_count > 0 && (
              <span className="font-normal text-ink-subtle">
                {t('queue.noShow', { n: task.return_count })}
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <select
          value={operatorId}
          onChange={(e) => setOperatorId(e.target.value)}
          aria-label={t('queue.assignTo', { token: vehicle?.token_number })}
          className="h-touch flex-1 rounded-xl border border-line-strong bg-surface px-4 text-base text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        >
          <option value="">
            {t(operators.length === 0 ? 'queue.everyoneBusy' : 'queue.chooseOperator')}
          </option>
          {operators.map((op) => (
            <option key={op.id} value={op.id}>
              {personName(op.name, op.name_hi)}
            </option>
          ))}
        </select>

        <Button
          variant="primary"
          icon="arrow-right"
          disabled={!operatorId}
          onClick={assign}
          className="sm:w-40"
        >
          {t('queue.assign')}
        </Button>
      </div>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════
// IN PROGRESS — read-only. The operator drives these from their phone.
// ═══════════════════════════════════════════════════════════════════

function ActiveRow({ task }) {
  const t = useT()
  const vehicle = task.parked_vehicles

  return (
    <Card padded={false} className="p-3.5">
      <div className="flex items-center gap-3">
        <span className="tnum flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-sm font-bold text-ink">
          {vehicle?.token_number}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tracking-wide text-ink">
              {prettyCarNumber(vehicle?.car_number)}
            </span>
            <TierBadge tier={vehicle?.car_tier} size="sm" />
            <TaskStatusBadge status={task.status} size="sm" />
          </div>
          <p className="mt-0.5 truncate text-sm text-ink-subtle">
            {t(task.task_type === TASK_TYPES.PARKING ? 'queue.parking' : 'queue.fetching')} ·{' '}
            {task.operator ? personName(task.operator.name, task.operator.name_hi) : t('queue.unassigned')}
            {task.assigned_at && ` · ${timeAgo(task.assigned_at)}`}
          </p>
        </div>
      </div>
    </Card>
  )
}
