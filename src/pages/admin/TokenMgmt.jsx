/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/admin/TokenMgmt.jsx                                 │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Tonight's token roster: which numbers each on-duty operator hands   │
 * │   out, and the controls to give them a range or add another.         │
 * │                                                                     │
 * │ THE PIVOT — see migration 0071                                       │
 * │   Token numbers used to be one shared counter for the whole property. │
 * │   Now each operator gets their OWN small range and reuses a number    │
 * │   the moment the car it was written on is delivered. This screen is   │
 * │   the admin's nightly roster: who has a range, how far they have run  │
 * │   through it, and who still needs one before they can check in a car. │
 * │                                                                     │
 * │ RANGES RESET EVERY NIGHT                                             │
 * │   Nothing auto-creates a range any more — an admin assigns one to     │
 * │   each on-duty operator every service day. That is deliberate: who is │
 * │   on duty changes night to night, so there is no sane default to      │
 * │   fall back on. See admin_assign_token_range in the migration.        │
 * │                                                                     │
 * │ AN OPERATOR CAN HOLD SEVERAL RANGES — see migration 0074              │
 * │   "Extend" is gone: it could only grow a range at its top edge, which  │
 * │   does nothing when the numbers just above are already someone        │
 * │   else's. "Add another range" always creates a new block instead, and │
 * │   the roster card shows every range an operator holds as its own      │
 * │   chip, individually removable once there is more than one.           │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase, lib/tokenApi, hooks/useRealtime, ui/BarChart,         │
 * │   ui/Card, ui/Modal, utils/format                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/AppShell'
import { BarChart } from '@/components/ui/BarChart'
import Badge from '@/components/ui/Badge'
import Button from '@/components/ui/Button'
import Card, { CardHeader, SectionHeading } from '@/components/ui/Card'
import EmptyState from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Field'
import Icon from '@/components/ui/Icon'
import Modal from '@/components/ui/Modal'
import {
  CardSkeleton,
  ChartSkeleton,
  HeaderSkeleton,
  SectionHeadingSkeleton,
} from '@/components/ui/PageSkeleton'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { useToast } from '@/context/ToastContext'
import useRealtime from '@/hooks/useRealtime'
import { supabase, describeDbError } from '@/supabase'
import { assignTokenRange, dropTokenRange, removeTokenRange, tokenRoster } from '@/lib/tokenApi'
import { formatDate, initials, istHour, istToday, personName } from '@/utils/format'
import { cn } from '@/utils/cn'

/**
 * Trim the 24-hour axis down to the part of the day this site actually works.
 *
 * A valet stand opens around lunch and closes after midnight, so a full
 * midnight-to-midnight axis is mostly empty — and "mostly empty" is how a
 * working chart looks broken. Worse, squeezing 24 slots in makes the three
 * bars that DO exist thin enough to be hard to compare.
 *
 * The window is derived from the data rather than hardcoded to opening hours,
 * because those differ per property and change with the season. One hour of
 * padding each side so the busiest hour is never flush against the edge.
 *
 * MIN_SPAN stops the other failure: with one busy hour the window would be
 * three bars wide, which reads as a broken chart rather than a quiet day.
 */
const MIN_SPAN = 10

export function busyWindow(hours) {
  const active = hours.reduce((acc, count, hour) => (count > 0 ? [...acc, hour] : acc), [])

  // Nothing yet today — show a typical valet shift so the axis still means
  // something instead of collapsing to nothing.
  if (active.length === 0) return { from: 11, to: 23 }

  let from = Math.max(0, Math.min(...active) - 1)
  let to = Math.min(23, Math.max(...active) + 1)

  // Grow outward, alternating, so the real bars stay roughly centred.
  while (to - from + 1 < MIN_SPAN && (from > 0 || to < 23)) {
    if (to < 23) to += 1
    if (to - from + 1 < MIN_SPAN && from > 0) from -= 1
  }

  return { from, to }
}

export default function TokenMgmt() {
  const t = useT()
  const { propertyId, propertyName } = useAuth()
  const toast = useToast()

  const [roster, setRoster] = useState([])
  const [operators, setOperators] = useState([])
  const [hours, setHours] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // { operator: { id, name, name_hi }, hasRanges: does this operator already
  // have at least one active range tonight? } — only changes the modal's
  // title and submit label; the form itself is the same from/to entry either
  // way. See migration 0074.
  const [assignTarget, setAssignTarget] = useState(null)
  const [removingId, setRemovingId] = useState(null)

  const todayDate = istToday()

  const load = useCallback(async () => {
    if (!propertyId) return

    const [rosterRes, operatorsRes, carsRes] = await Promise.all([
      tokenRoster(propertyId, todayDate),
      supabase
        .from('user_roles')
        .select('id, name, name_hi')
        .eq('property_id', propertyId)
        .eq('role', 'operator')
        .eq('is_active', true)
        .order('name'),
      supabase
        .from('parked_vehicles')
        .select('parked_at')
        .eq('property_id', propertyId)
        .eq('service_date', todayDate),
    ])

    if (!rosterRes.ok) {
      setError(rosterRes.error)
      setLoading(false)
      return
    }
    if (operatorsRes.error) {
      setError(describeDbError(operatorsRes.error, t('tokens.couldNotLoad')))
      setLoading(false)
      return
    }

    setError(null)
    setRoster(rosterRes.rows ?? [])
    setOperators(operatorsRes.data ?? [])

    // Bucket by IST hour, not the device's — a laptop left on UTC would shift
    // the whole evening peak by five and a half hours.
    const buckets = Array(24).fill(0)
    for (const car of carsRes.data ?? []) buckets[istHour(car.parked_at)] += 1
    setHours(buckets)
    setLoading(false)
  }, [propertyId, todayDate, t])

  useEffect(() => {
    load()
  }, [load])

  // Two independent things move this screen: a check-in/delivery changes a
  // row's issued/open/delivered counts, and another admin assigning or
  // extending a range elsewhere adds or changes a roster row. Both need their
  // own watch, or the screen goes stale mid-shift.
  useRealtime({
    channel: `tokens-vehicles:${propertyId}`,
    table: 'parked_vehicles',
    filter: propertyId ? `property_id=eq.${propertyId}` : undefined,
    enabled: Boolean(propertyId),
    onRefetch: load,
  })
  useRealtime({
    channel: `tokens-ranges:${propertyId}`,
    table: 'operator_token_ranges',
    filter: propertyId ? `property_id=eq.${propertyId}` : undefined,
    enabled: Boolean(propertyId),
    onRefetch: load,
  })

  const { chart, window: chartWindow } = useMemo(() => {
    const win = busyWindow(hours)
    const span = win.to - win.from + 1

    return {
      window: win,
      chart: hours.slice(win.from, win.to + 1).map((count, index) => {
        const hour = win.from + index
        return {
          // Every hour when there is room, every other one when there is not.
          label: span <= 12 || hour % 2 === 0 ? String(hour).padStart(2, '0') : '',
          full: `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`,
          value: count,
        }
      }),
    }
  }, [hours])

  // Active operators with no row at all tonight — not even a removed one —
  // are the ones who still need a range before they can check in a car.
  const unassigned = useMemo(
    () => operators.filter((op) => !roster.some((row) => row.operator_id === op.id)),
    [operators, roster],
  )

  // admin_token_roster returns one ROW PER RANGE now (migration 0074), since
  // an operator can hold several. The screen still shows one card per
  // operator, so their ranges are grouped back together here rather than in
  // SQL — see that migration's note on why the split lives on this side.
  const groupedRoster = useMemo(() => {
    const byOperator = new Map()
    for (const row of roster) {
      let group = byOperator.get(row.operator_id)
      if (!group) {
        group = {
          operatorId: row.operator_id,
          name: row.operator_name,
          nameHi: row.operator_name_hi,
          ranges: [],
        }
        byOperator.set(row.operator_id, group)
      }
      group.ranges.push(row)
    }
    return [...byOperator.values()]
  }, [roster])

  async function handleRemove(group) {
    setRemovingId(group.operatorId)
    const result = await removeTokenRange({ operatorId: group.operatorId })
    setRemovingId(null)

    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(t('tokens.removed', { name: group.name }))
    load()
  }

  async function handleDropRange(range) {
    setRemovingId(range.range_id)
    const result = await dropTokenRange({ rangeId: range.range_id })
    setRemovingId(null)

    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(t('tokens.rangeRemoved', { start: range.range_start, end: range.range_end }))
    load()
  }

  if (loading) {
    return (
      <>
        <HeaderSkeleton />
        <SectionHeadingSkeleton />
        <CardSkeleton lines={4} />
        <SectionHeadingSkeleton />
        <ChartSkeleton height={240} bars={13} />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('tokens.title')}
        subtitle={propertyName ? `${propertyName} · ${formatDate(`${todayDate}T12:00:00+05:30`)}` : undefined}
      />

      {error ? (
        <EmptyState
          variant="error"
          title={t('common.couldNotLoad')}
          description={error}
          action={
            <Button variant="secondary" icon="refresh" onClick={load}>
              {t('common.tryAgain')}
            </Button>
          }
        />
      ) : (
        <>
          <SectionHeading title={t('tokens.roster')} icon="ticket" count={groupedRoster.length} />
          {groupedRoster.length === 0 ? (
            <Card className="mb-5">
              <CardHeader
                icon="ticket"
                title={t('tokens.rosterEmpty')}
                subtitle={t('tokens.rosterEmptyBody')}
              />
            </Card>
          ) : (
            <Card padded={false} className="mb-5 overflow-hidden">
              {groupedRoster.map((group, index) => (
                <RosterRow
                  key={group.operatorId}
                  group={group}
                  isFirst={index === 0}
                  busy={removingId === group.operatorId}
                  droppingId={removingId}
                  onAddRange={() =>
                    setAssignTarget({
                      operator: { id: group.operatorId, name: group.name, name_hi: group.nameHi },
                      hasRanges: group.ranges.some((r) => r.is_active),
                    })
                  }
                  onDropRange={handleDropRange}
                  onRemove={() => handleRemove(group)}
                />
              ))}
            </Card>
          )}

          {unassigned.length > 0 && (
            <>
              <SectionHeading
                title={t('tokens.unassignedTitle')}
                icon="alert"
                count={unassigned.length}
              />
              <Card padded={false} className="mb-5 overflow-hidden">
                {unassigned.map((op, index) => (
                  <UnassignedRow
                    key={op.id}
                    operator={op}
                    isFirst={index === 0}
                    onAssign={() => setAssignTarget({ operator: op, hasRanges: false })}
                  />
                ))}
              </Card>
            </>
          )}

          <SectionHeading title={t('tokens.byHour')} icon="chart" />
          <Card className="mb-5">
            <BarChart
              data={chart}
              height={240}
              unit={t('status.unit')}
              caption={t('tokens.chartCaption', {
                from: String(chartWindow.from).padStart(2, '0'),
                to: String((chartWindow.to + 1) % 24).padStart(2, '0'),
              })}
              emptyLabel={t('tokens.chartEmpty')}
            />
          </Card>
        </>
      )}

      <AssignRangeModal target={assignTarget} onClose={() => setAssignTarget(null)} onDone={load} />
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════
// ROSTER ROW — one operator's ranges for tonight, plus their combined
// counts. An operator can hold several ranges at once (migration 0074),
// each shown as its own chip so an admin can tell 1-5 from 41-45 rather
// than reading one merged span that implies a single block of numbers.
// ═══════════════════════════════════════════════════════════════════

function RosterRow({ group, isFirst, busy, droppingId, onAddRange, onDropRange, onRemove }) {
  const t = useT()

  const anyActive = group.ranges.some((r) => r.is_active)
  const totals = group.ranges.reduce(
    (acc, r) => ({
      issued: acc.issued + r.issued_count,
      open: acc.open + r.open_count,
      delivered: acc.delivered + r.delivered_count,
    }),
    { issued: 0, open: 0, delivered: 0 },
  )
  const activeCount = group.ranges.filter((r) => r.is_active).length

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-4 px-5 py-4',
        !isFirst && 'border-t border-line',
        !anyActive && 'opacity-50',
      )}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-sm font-bold text-ink-muted">
        {initials(group.name)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[0.9375rem] font-semibold leading-snug text-ink">
            {personName(group.name, group.nameHi)}
          </p>
          {!anyActive && (
            <Badge tone="warning" size="sm" dot>
              {t('tokens.removedBadge')}
            </Badge>
          )}
        </div>

        <div className="mt-1 flex flex-wrap gap-1.5">
          {group.ranges.map((r) => (
            <span
              key={r.range_id}
              className={cn(
                'tnum inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface-sunken px-2 py-0.5 text-[0.8125rem] font-medium text-ink-muted',
                !r.is_active && 'line-through opacity-60',
              )}
            >
              {r.range_start}–{r.range_end}
              {/* Only when there is more than one active range to tell apart —
                  with a single range, "Remove from roster" already does this. */}
              {r.is_active && activeCount > 1 && (
                <button
                  type="button"
                  onClick={() => onDropRange(r)}
                  disabled={droppingId === r.range_id}
                  aria-label={t('tokens.dropRange')}
                  title={t('tokens.dropRange')}
                  className="rounded-full p-0.5 text-ink-subtle hover:bg-danger-soft hover:text-danger"
                >
                  <Icon name="x" size={10} />
                </button>
              )}
            </span>
          ))}
        </div>

        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem] font-medium text-ink-subtle">
          <span>
            {t('tokens.issuedTonight')}: {totals.issued}
          </span>
          <span>
            {t('tokens.currentlyOut')}: {totals.open}
          </span>
          <span>
            {t('tokens.deliveredTonight')}: {totals.delivered}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button variant="secondary" size="sm" icon="plus" onClick={onAddRange}>
          {t('tokens.addRange')}
        </Button>
        {anyActive && (
          <Button
            variant="ghost"
            size="icon-md"
            icon="x-circle"
            onClick={onRemove}
            disabled={busy}
            aria-label={t('tokens.remove')}
            title={t('tokens.remove')}
            className="hover:bg-danger-soft hover:text-danger"
          />
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// UNASSIGNED ROW — an active operator with no range yet tonight.
// ═══════════════════════════════════════════════════════════════════

function UnassignedRow({ operator, isFirst, onAssign }) {
  const t = useT()

  return (
    <div className={cn('flex items-center gap-4 px-5 py-4', !isFirst && 'border-t border-line')}>
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-sm font-bold text-ink-muted">
        {initials(operator.name)}
      </span>
      <p className="min-w-0 flex-1 truncate text-[0.9375rem] font-semibold text-ink">
        {personName(operator.name, operator.name_hi)}
      </p>
      <Button variant="secondary" size="sm" icon="plus" onClick={onAssign} className="shrink-0">
        {t('tokens.assign')}
      </Button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// ASSIGN A RANGE — always a from/to entry, whether it is an operator's
// first range tonight or another one alongside ranges they already hold.
// See migration 0074: an operator can hold several ranges, so there is no
// more "extend the last one" mode — every range is created the same way.
// ═══════════════════════════════════════════════════════════════════

function AssignRangeModal({ target, onClose, onDone }) {
  const t = useT()
  const toast = useToast()

  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!target) return
    setStart('')
    setEnd('')
    setError(null)
  }, [target])

  if (!target) return null

  const { operator, hasRanges } = target

  async function submit() {
    const s = Number(start)
    const e = Number(end)

    if (!Number.isInteger(s) || s < 1) {
      setError(t('tokens.startTooSmall'))
      return
    }
    if (!Number.isInteger(e) || e <= s) {
      setError(t('tokens.endTooSmall'))
      return
    }

    const result = await assignTokenRange({
      operatorId: operator.id,
      rangeStart: s,
      rangeEnd: e,
    })

    if (!result.ok) {
      setError(result.error)
      return
    }

    toast.success(t('tokens.assigned', { name: operator.name, start: s, end: e }))
    onDone()
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={hasRanges ? t('tokens.addRangeTitle') : t('tokens.assignTitle')}
      description={personName(operator.name, operator.name_hi)}
      size="sm"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="md" onClick={submit}>
            {hasRanges ? t('tokens.addRange') : t('tokens.assign')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-3 text-sm font-medium text-danger"
          >
            <Icon name="alert" size={17} className="mt-0.5" strokeWidth={2} />
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-3">
          <Input
            label={t('tokens.firstToken')}
            type="tel"
            inputMode="numeric"
            value={start}
            onChange={(e) => {
              setStart(e.target.value.replace(/\D/g, '').slice(0, 5))
              if (error) setError(null)
            }}
            containerClassName="min-w-0 flex-1"
          />
          <Input
            label={t('tokens.lastToken')}
            type="tel"
            inputMode="numeric"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value.replace(/\D/g, '').slice(0, 5))
              if (error) setError(null)
            }}
            containerClassName="min-w-0 flex-1"
          />
        </div>
      </div>
    </Modal>
  )
}
