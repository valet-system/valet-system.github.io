/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/admin/TokenMgmt.jsx                                 │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Tonight's token roster: which numbers each on-duty operator hands   │
 * │   out, and the controls to assign one or extend it.                  │
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
 * │ A RANGE CAN ONLY EVER GROW                                           │
 * │   admin_assign_token_range() refuses to shrink range_end or move       │
 * │   range_start once a row exists — a number already handed out cannot  │
 * │   retroactively belong to someone else.                              │
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
import { assignTokenRange, removeTokenRange, tokenRoster } from '@/lib/tokenApi'
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

  // { operator: { id, name, name_hi }, existingRange: roster row | null }
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

  async function handleRemove(row) {
    setRemovingId(row.operator_id)
    const result = await removeTokenRange({ operatorId: row.operator_id })
    setRemovingId(null)

    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(t('tokens.removed', { name: row.operator_name }))
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
          <SectionHeading title={t('tokens.roster')} icon="ticket" count={roster.length} />
          {roster.length === 0 ? (
            <Card className="mb-5">
              <CardHeader
                icon="ticket"
                title={t('tokens.rosterEmpty')}
                subtitle={t('tokens.rosterEmptyBody')}
              />
            </Card>
          ) : (
            <Card padded={false} className="mb-5 overflow-hidden">
              {roster.map((row, index) => (
                <RosterRow
                  key={row.operator_id}
                  row={row}
                  isFirst={index === 0}
                  busy={removingId === row.operator_id}
                  onExtend={() =>
                    setAssignTarget({
                      operator: { id: row.operator_id, name: row.operator_name, name_hi: row.operator_name_hi },
                      existingRange: row,
                    })
                  }
                  onRemove={() => handleRemove(row)}
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
                    onAssign={() => setAssignTarget({ operator: op, existingRange: null })}
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
// ROSTER ROW — one operator's range for tonight, plus their three counts.
// ═══════════════════════════════════════════════════════════════════

function RosterRow({ row, isFirst, busy, onExtend, onRemove }) {
  const t = useT()

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-4 px-5 py-4',
        !isFirst && 'border-t border-line',
        !row.is_active && 'opacity-50',
      )}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-sm font-bold text-ink-muted">
        {initials(row.operator_name)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[0.9375rem] font-semibold leading-snug text-ink">
            {personName(row.operator_name, row.operator_name_hi)}
          </p>
          {!row.is_active && (
            <Badge tone="warning" size="sm" dot>
              {t('tokens.removedBadge')}
            </Badge>
          )}
        </div>
        <p className="tnum mt-0.5 text-[0.8125rem] font-medium text-ink-muted">
          {row.range_start}–{row.range_end}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem] font-medium text-ink-subtle">
          <span>
            {t('tokens.issuedTonight')}: {row.issued_count}
          </span>
          <span>
            {t('tokens.currentlyOut')}: {row.open_count}
          </span>
          <span>
            {t('tokens.deliveredTonight')}: {row.delivered_count}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button variant="secondary" size="sm" icon="plus" onClick={onExtend}>
          {t('tokens.extend')}
        </Button>
        {row.is_active && (
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
// ASSIGN / EXTEND — one modal, two modes depending on whether the
// operator already has a row tonight.
// ═══════════════════════════════════════════════════════════════════

function AssignRangeModal({ target, onClose, onDone }) {
  const t = useT()
  const toast = useToast()

  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [error, setError] = useState(null)

  const isExtend = Boolean(target?.existingRange)

  useEffect(() => {
    if (!target) return
    setStart('')
    setEnd('')
    setError(null)
  }, [target])

  if (!target) return null

  const { operator, existingRange } = target

  async function submit() {
    const e = Number(end)

    if (isExtend) {
      if (!Number.isInteger(e) || e <= existingRange.range_end) {
        setError(t('tokens.enterAbove', { end: existingRange.range_end }))
        return
      }
    } else {
      const s = Number(start)
      if (!Number.isInteger(s) || s < 1) {
        setError(t('tokens.startTooSmall'))
        return
      }
      if (!Number.isInteger(e) || e <= s) {
        setError(t('tokens.endTooSmall'))
        return
      }
    }

    const result = await assignTokenRange({
      operatorId: operator.id,
      rangeEnd: e,
      rangeStart: isExtend ? undefined : Number(start),
    })

    if (!result.ok) {
      setError(result.error)
      return
    }

    toast.success(
      isExtend
        ? t('tokens.extended', { end: e })
        : t('tokens.assigned', { name: operator.name, start: Number(start), end: e }),
    )
    onDone()
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('tokens.assignTitle')}
      description={personName(operator.name, operator.name_hi)}
      size="sm"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="md" onClick={submit}>
            {isExtend ? t('tokens.extend') : t('tokens.assign')}
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

        {isExtend ? (
          <Input
            label={t('tokens.extendTo')}
            hint={t('tokens.extendHint', { end: existingRange.range_end })}
            type="tel"
            inputMode="numeric"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value.replace(/\D/g, '').slice(0, 5))
              if (error) setError(null)
            }}
            placeholder={String(existingRange.range_end + 5)}
          />
        ) : (
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
        )}
      </div>
    </Modal>
  )
}
