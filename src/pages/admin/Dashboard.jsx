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
import { cn } from '@/utils/cn'
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
import {
  assignRetrieval,
  availableOperators,
  dispatchReparking,
  dispatchVehicle,
  guestAbsent,
  guestArrived,
} from '@/lib/valetApi'
import { supabase, describeDbError, selectOptional } from '@/supabase'
import { alertLoud, playSuccess } from '@/utils/sounds'
import { formatDuration, formatPhone, istToday, personName, prettyCarNumber, timeAgo } from '@/utils/format'
import useTimer from '@/hooks/useTimer'
import {
  ACTIVE_TASK_STATUSES,
  CAR_TIERS,
  TASK_STATUS,
  TASK_TYPES,
  VEHICLE_AT_REST,
  VEHICLE_STATUS,
} from '@/types'

/**
 * Two variants, because name_hi arrives with migration 0022 and this screen
 * must keep working on a database that has not run it yet — a guest is
 * standing at the porch waiting for one of these rows. See selectOptional.
 */
/**
 * How many on-site cars are rendered at once.
 *
 * Not a limit on what can be reached — the search filters the whole set, so any
 * car is one or two keystrokes away. This is only a ceiling on how many cards
 * the browser lays out at rest, because a busy property has a couple of hundred
 * and laying all of them out makes the page crawl on the phone this is read on.
 */
const SHOW_ON_SITE = 40

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
  const [parkedCars, setParkedCars] = useState([])
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

    const [pendingRes, activeRes, statusRes, opsRes, carsRes] = await Promise.all([
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
      // The cars themselves, for the "on site" list under the queue. The
      // status-only query above cannot serve it — that one deliberately fetches
      // one column so the tiles are cheap, and this needs the whole row.
      supabase.rpc('search_todays_cars', { p_query: null, p_limit: 500 }),
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

    // Every car on site today, for the list below the queue. Only the at-rest
    // ones: a car being fetched, standing at the gate, or already handed over
    // must not be offered, because sending a second operator for it produces
    // two people and one car.
    setParkedCars(
      (carsRes?.data ?? []).filter((c) => VEHICLE_AT_REST.includes(c.status)),
    )
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

  /**
   * The cars on site that nobody has asked for yet.
   *
   * Filtered from the list already loaded rather than searched on the server:
   * the whole set is in memory, so typing filters instantly and costs no round
   * trip. A debounced query per keystroke would be slower and no more correct.
   *
   * Anything with a pending request is excluded — those are the cards above,
   * and showing a car in both lists invites dispatching it twice.
   */
  const waitingIds = useMemo(
    () => new Set(pending.map((task) => task.parked_vehicles?.id).filter(Boolean)),
    [pending],
  )

  const available = useMemo(() => {
    const q = carQuery.trim().toLowerCase()
    const digits = q.replace(/\D/g, '')

    return parkedCars.filter((car) => {
      if (waitingIds.has(car.id)) return false
      if (!q) return true

      // The four things somebody at a desk actually has to hand: the slip, the
      // plate, the name, or the number the guest reads out.
      return (
        String(car.token_number) === digits ||
        (car.car_number ?? '').toLowerCase().includes(q.replace(/\s/g, '')) ||
        (car.guest_name ?? '').toLowerCase().includes(q) ||
        (car.guest_name_hi ?? '').includes(carQuery.trim()) ||
        (digits.length >= 4 && (car.guest_phone ?? '').includes(digits))
      )
    })
  }, [parkedCars, waitingIds, carQuery])

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
    // Clear the search. The car has moved into the queue above, and load()
    // drops it out of the on-site list — but a stale filter still showing it
    // would invite a second dispatch of a car already on its way.
    setCarQuery('')
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

  /**
   * The car is at the door and the guest has come for it.
   *
   * This used to be the operator's button. Since migration 0050 his job ends
   * when he brings the car, so the hand-over is the desk's — and this is the tap
   * that sends the guest their thank-you and the rating buttons. Same RPC the
   * operator called; claim_task() has always allowed a valet_admin at the same
   * property, so nothing in the database had to change for it.
   */
  const handleHandedOver = async (taskId, token) => {
    const result = await guestArrived(taskId)
    if (!result.ok) {
      toast.error(result.error)
      load()
      return
    }
    playSuccess()
    toast.success(t('queue.handedOverToast', { token: token ?? '?' }))
    load()
  }

  /**
   * The guest is not coming, and the desk knows it before the clock does.
   *
   * Without this the only way to a no-show is waiting out the full ten minutes
   * on pg_cron, with the car standing at the porch the whole time. The operator
   * had this button; somebody has to keep it.
   */
  const handleNoShow = async (taskId) => {
    const result = await guestAbsent(taskId)
    if (!result.ok) {
      toast.error(result.error)
      load()
      return
    }
    toast.success(t('queue.noShowToast'))
    load()
  }

  /** Send a free operator to park a no-show again. */
  const handleRepark = async (taskId, operatorId) => {
    const result = await dispatchReparking(taskId, operatorId)
    if (!result.ok) {
      toast.error(result.error)
      // OPERATOR_BUSY or WRONG_STATUS both mean this screen is behind.
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
    load()
  }

  /**
   * Three lists out of one query, because they are three different jobs.
   *
   * `active` holds every open task. Splitting it here rather than running three
   * queries keeps the screen consistent: all three views are the same snapshot,
   * so a car cannot appear in two of them because one fetch was a second later.
   *
   *   atDoor    waiting for a guest. The countdown is running and the desk has
   *             to hand it over or send it back.
   *   toRepark  the guest never came. Needs an operator sent to park it again.
   *   working   somebody is driving. Read-only — the operator drives these.
   */
  const atDoor = active.filter((task) => task.status === TASK_STATUS.AT_PICKUP)
  const toRepark = active.filter(
    (task) => task.status === TASK_STATUS.RE_PARKING || task.status === TASK_STATUS.RETURNED,
  )
  const working = active.filter(
    (task) =>
      task.status !== TASK_STATUS.AT_PICKUP &&
      task.status !== TASK_STATUS.RE_PARKING &&
      task.status !== TASK_STATUS.RETURNED,
  )

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
          // The count is still every open task, but those are now spread over
          // THREE sections. Scrolling to 'queue-active' unconditionally would
          // be a dead tap whenever the only open cars are at the door — the
          // section would not be rendered, getElementById returns null, and
          // scrollToSection quietly does nothing. So it aims at the topmost
          // section that actually exists.
          onClick={
            active.length > 0
              ? () =>
                  scrollToSection(
                    atDoor.length > 0
                      ? 'queue-door'
                      : toRepark.length > 0
                        ? 'queue-repark'
                        : 'queue-active',
                  )
              : undefined
          }
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
        /* One line, not an EmptyState.
           The big empty card was right when this section was the whole page —
           it filled a screen that would otherwise look broken. It is not the
           whole page any more: four more sections sit below it, so a tall empty
           box is just distance between the reader and the cars that matter. */
        <p className="flex items-center gap-2 px-1 text-sm text-ink-subtle">
          <Icon name="check-circle" size={15} />
          {t('queue.nobodyIsWaiting')}
        </p>
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

      {/* ── AT THE DOOR ─────────────────────────────────────────────────
          Above In progress on purpose. A car here has a guest who may walk up
          any second and a clock running out; an in-progress car has neither. */}
      {atDoor.length > 0 && (
        <div className="mt-8">
          <SectionHeading
            title={t('queue.atTheDoor')}
            count={atDoor.length}
            icon="car"
            className="scroll-mt-24"
            id="queue-door"
          />
          <div className="space-y-2">
            {atDoor.map((task) => (
              <DoorCard
                key={task.id}
                task={task}
                onHandedOver={handleHandedOver}
                onNoShow={handleNoShow}
                onRefresh={load}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── NEEDS PARKING AGAIN ─────────────────────────────────────────
          The guest never came. Each one needs an operator sent to it, which is
          why these carry a picker and the In progress rows below do not. */}
      {toRepark.length > 0 && (
        <div className="mt-8">
          <SectionHeading
            title={t('queue.needsRepark')}
            count={toRepark.length}
            icon="refresh"
            className="scroll-mt-24"
            id="queue-repark"
          />
          <div className="space-y-2">
            {toRepark.map((task) => (
              <ReparkCard
                key={task.id}
                task={task}
                operators={operators}
                onRepark={handleRepark}
              />
            ))}
          </div>
        </div>
      )}

      {working.length > 0 && (
        <div className="mt-8">
          <SectionHeading
            title={t('queue.inProgress')}
            count={working.length}
            icon="car"
            className="scroll-mt-24"
            id="queue-active"
          />
          <div className="space-y-2">
            {working.map((task) => (
              <ActiveRow key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}

      {/* ══ ON SITE, NOT ASKED FOR — LAST ON THE PAGE ═══════════════════
          Every car in a bay right now. A guest who walks up to the desk is in
          here, not in the queue at the top: they never tapped anything.

          LAST on purpose, and it used to be second. Everything above this point
          is a car with somebody either waiting or a clock running — a guest in
          the queue, a car at the door, a no-show blocking the porch. This
          section is a BROWSE list: nothing in it is late, and nothing in it
          needs doing unless somebody walks up and asks.

          THE SEARCH MOVED DOWN WITH IT. It used to sit under the queue heading
          at the top, which was right while the list was directly below it. With
          the list down here, a box at the top would change a list off the bottom
          of the screen — you would type and watch nothing happen. */}
      <div className="mt-8">
        <SectionHeading
          title={t('queue.onSite')}
          count={available.length}
          icon="parking"
          className="scroll-mt-24"
          id="queue-onsite"
        />

        <div className="mb-4">
          <SearchInput
            value={carQuery}
            onChange={(e) => setCarQuery(e.target.value)}
            onClear={() => setCarQuery('')}
            placeholder={t('queue.searchToSend')}
          />
        </div>

        {available.length > 0 ? (
          <>
            <div className="space-y-3">
              {available.slice(0, SHOW_ON_SITE).map((car) => (
                <SendCard
                  key={car.id}
                  car={car}
                  operators={operators}
                  onDispatch={handleDispatch}
                />
              ))}
            </div>

            {/* Capped, and it SAYS it is capped. Rendering two hundred cards
                makes the page crawl, and silently showing forty would read as
                "that is all the cars", which is worse than a slow page. */}
            {available.length > SHOW_ON_SITE && (
              <p className="mt-3 px-1 text-sm text-ink-subtle">
                {t('queue.andMoreOnSite', { n: available.length - SHOW_ON_SITE })}
              </p>
            )}
          </>
        ) : (
          /* Two different nothings, and they must not read the same. A search
             that matched nothing is the admin's next move; an empty car park is
             just a quiet evening. */
          <p className="px-1 text-sm text-ink-subtle">
            {t(carQuery.trim() ? 'queue.noParkedMatch' : 'queue.noCarsOnSite')}
          </p>
        )}
      </div>

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
      <div className="flex items-start gap-3 sm:gap-4">
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

          {/* Where to walk to. Plain text, not a chip — see PendingCard. No
              waiting time here, because nobody is waiting. */}
          <p className="mt-1.5 inline-flex items-center gap-1 text-sm font-semibold text-ink">
            <Icon name="location" size={14} className="text-ink-subtle" />
            {car.parking_location || t('common.notRecorded')}
          </p>
        </div>
      </div>

      {/* ── ONE ROW, EVEN ON A PHONE ────────────────────────────────────
          Stacked, the select and the button were two full-width bars and the
          card was mostly controls. Side by side saves a whole row per card, and
          with a dozen cars on the page that is the difference between scanning
          the list and scrolling it.

          h-touch stays. The row got shorter by removing one, not by shrinking
          the target somebody taps with a thumb. */}
      <div className="mt-3 flex gap-2">
        <select
          value={operatorId}
          onChange={(e) => setOperatorId(e.target.value)}
          aria-label={t('queue.assignTo', { token: car.token_number })}
          className="h-touch min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 sm:px-4 sm:text-base"
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
          className="shrink-0 sm:w-40"
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
      <div className="flex items-start gap-3 sm:gap-4">
        <div className="shrink-0 text-center">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-subtle">
            {t('common.token')}
          </p>
          {/* 4xl on a phone, 5xl from sm up. At 5xl on a narrow screen the
              token was taller than the two lines of guest detail beside it. */}
          <p className="tnum text-4xl font-bold leading-none tracking-tight text-ink sm:text-5xl">
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

          {/* ── TWO FACTS, ONE LINE ───────────────────────────────────────
              Where to walk to, and how long they have been waiting. Both were a
              row of their own, and the location was a padded chip on top of
              that — three rows of chrome for two short strings.

              They belong together anyway: the pair is the whole decision. Who
              has waited longest, and how far is the car.

              Wrapping, not truncating: a parking place can be "L2 Bay B4 near
              lift" and an operator who reads half of it walks to the wrong
              floor. */}
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-1 font-semibold text-ink">
              <Icon name="location" size={14} className="text-ink-subtle" />
              {vehicle?.parking_location || t('common.notRecorded')}
            </span>
            <span className="inline-flex items-center gap-1 font-semibold text-danger">
              <Icon name="clock" size={14} />
              {t('queue.waitingFor', { ago: timeAgo(task.created_at) })}
            </span>
            {task.return_count > 0 && (
              <span className="text-ink-subtle">
                {t('queue.noShow', { n: task.return_count })}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* One row on a phone too — see SendCard for why. */}
      <div className="mt-3 flex gap-2">
        <select
          value={operatorId}
          onChange={(e) => setOperatorId(e.target.value)}
          aria-label={t('queue.assignTo', { token: vehicle?.token_number })}
          className="h-touch min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 sm:px-4 sm:text-base"
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
          className="shrink-0 sm:w-40"
        >
          {t('queue.assign')}
        </Button>
      </div>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════
// AT THE DOOR — the desk's ten minutes
//
// This card and the one below it are new with migration 0050, and they are the
// admin's half of a flow that used to live entirely on the operator's phone.
// He brings the car, taps once, and is gone; from that moment the countdown,
// the hand-over and the no-show are all the desk's.
// ═══════════════════════════════════════════════════════════════════

function DoorCard({ task, onHandedOver, onNoShow, onRefresh }) {
  const t = useT()
  const vehicle = task.parked_vehicles

  const { secondsLeft, isWarning, isExpired } = useTimer(task.pickup_started_at, {
    // No status write here. pg_cron owns the expiry — see expire_stale_pickups.
    // This only nudges the screen so it stops showing a stale countdown.
    onExpire: onRefresh,
  })

  return (
    <Card accent={isExpired ? 'danger' : isWarning ? 'warning' : undefined}>
      <div className="flex items-start gap-3">
        <span className="tnum flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-sm font-bold text-ink">
          {vehicle?.token_number}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tracking-wide text-ink">
              {prettyCarNumber(vehicle?.car_number)}
            </span>
            <TierBadge tier={vehicle?.car_tier} size="sm" />
          </div>
          {vehicle?.guest_name && (
            <p className="mt-0.5 truncate text-sm text-ink-subtle">
              {personName(vehicle.guest_name, vehicle.guest_name_hi)}
            </p>
          )}
          {/* Who fetched it. He is free now and probably on another car, but the
              desk still needs to know whose car this was if anything is wrong. */}
          {task.operator && (
            <p className="mt-0.5 truncate text-xs text-ink-subtle">
              {personName(task.operator.name, task.operator.name_hi)}
            </p>
          )}
        </div>

        {/* The clock. tnum so the digits do not jitter as they count down. */}
        <div className="shrink-0 text-right">
          <p
            className={cn(
              'tnum text-xl font-bold leading-none',
              isExpired || isWarning ? 'text-danger' : 'text-ink',
            )}
          >
            {formatDuration(secondsLeft ?? 0)}
          </p>
          <p className="mt-1 text-[0.7rem] leading-tight text-ink-subtle">
            {t(isExpired ? 'tasks.timeUp' : 'tasks.untilBack')}
          </p>
        </div>
      </div>

      {/* Both stay visible past zero. A guest who turns up at 10:30 still gets
          their car, and the desk must never hunt for the right button. */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Button
          variant="success"
          fullWidth
          icon="check"
          onClick={() => onHandedOver(task.id, vehicle?.token_number)}
        >
          {t('tasks.guestArrived')}
        </Button>
        <Button variant="danger" fullWidth icon="x" onClick={() => onNoShow(task.id)}>
          {t('tasks.guestAbsent')}
        </Button>
      </div>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════
// NEEDS PARKING AGAIN — the guest never came
// ═══════════════════════════════════════════════════════════════════

function ReparkCard({ task, operators, onRepark }) {
  const t = useT()
  const [operatorId, setOperatorId] = useState('')
  const vehicle = task.parked_vehicles

  return (
    <Card accent="danger">
      <div className="flex items-start gap-3">
        <span className="tnum flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-sm font-bold text-danger">
          {vehicle?.token_number}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tracking-wide text-ink">
              {prettyCarNumber(vehicle?.car_number)}
            </span>
            <TierBadge tier={vehicle?.car_tier} size="sm" />
          </div>
          {/* pickup_started_at, NOT assigned_at. Since migration 0052 a no-show
              has no operator, and assigned_at still holds the moment the car
              was dispatched to be FETCHED — which reads as "assigned 20 minutes
              ago" about a job nobody currently has. When the car reached the
              door is the number the desk actually wants. */}
          <p className="mt-0.5 truncate text-sm text-ink-subtle">
            {t('queue.guestNeverCame')}
            {task.pickup_started_at && ` · ${timeAgo(task.pickup_started_at)}`}
          </p>
        </div>
      </div>

      {/* Same picker as PendingCard, because it is the same decision: who is
          free, and send them. The operator who brought the car is offered here
          like anybody else — he is genuinely free once it reaches the door. */}
      <div className="mt-3 flex gap-2">
        {/* A raw select with the same classes PendingCard uses, not the Select
            component — this file already picks operators in two places and both
            do it this way. One more import would make three spellings of one
            control. */}
        <select
          value={operatorId}
          onChange={(e) => setOperatorId(e.target.value)}
          aria-label={t('queue.assignTo', { token: vehicle?.token_number })}
          className="h-touch min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 sm:px-4 sm:text-base"
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
          onClick={() => onRepark(task.id, operatorId)}
        >
          {t('queue.sendToRepark')}
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
