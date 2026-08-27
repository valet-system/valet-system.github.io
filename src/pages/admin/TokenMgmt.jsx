/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/admin/TokenMgmt.jsx                                 │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Today's token range: how many numbers are left, and the controls   │
 * │   to widen it or to set up tomorrow's.                               │
 * │                                                                     │
 * │ WHY RUNNING OUT MATTERS                                              │
 * │   allocate_token() refuses once next_token passes range_end, so      │
 * │   check-in stops dead at the porch with a car already blocking the   │
 * │   entrance. That is why "remaining" is the biggest number here and   │
 * │   turns red early rather than at zero.                               │
 * │                                                                     │
 * │ THE RANGE CAN ONLY EVER GROW                                         │
 * │   Extend is an update guarded by `.gt('range_end', …)` on the        │
 * │   server side of the query, so a smaller number simply matches no    │
 * │   rows. Shrinking below next_token would strand tokens that are      │
 * │   already written on guests' stubs — the paper in someone's pocket   │
 * │   cannot be migrated.                                                │
 * │                                                                     │
 * │   range_start is never editable after creation for the same reason.  │
 * │                                                                     │
 * │ WHY THERE IS NO "TOKENS USED" WRITE PATH HERE                        │
 * │   next_token belongs to allocate_token() alone. Editing it by hand   │
 * │   would hand two guests the same number. This screen reads it.       │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase, hooks/useRealtime, ui/BarChart, ui/StatTile,         │
 * │   utils/format, types                                                │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/AppShell'
import { BarChart } from '@/components/ui/BarChart'
import Button from '@/components/ui/Button'
import Card, { CardHeader, SectionHeading } from '@/components/ui/Card'
import EmptyState from '@/components/ui/EmptyState'
import { Field, Input } from '@/components/ui/Field'
import Icon from '@/components/ui/Icon'
import {
  CardSkeleton,
  ChartSkeleton,
  HeaderSkeleton,
  SectionHeadingSkeleton,
  StatRowSkeleton,
} from '@/components/ui/PageSkeleton'
import StatTile, { ProgressBar, StatRow } from '@/components/ui/StatTile'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { useToast } from '@/context/ToastContext'
import useRealtime from '@/hooks/useRealtime'
import { supabase, describeDbError } from '@/supabase'
import { formatDate, istHour, istToday } from '@/utils/format'
import { DEFAULT_TOKEN_END, DEFAULT_TOKEN_START } from '@/types'
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

/** Tomorrow's business date, in IST, as YYYY-MM-DD. */
function istTomorrow() {
  const [y, m, d] = istToday().split('-').map(Number)
  // Date.UTC + noon avoids every DST and month-length edge case; we only ever
  // read the date parts back out.
  const next = new Date(Date.UTC(y, m - 1, d + 1, 12))
  return next.toISOString().slice(0, 10)
}

export default function TokenMgmt() {
  const t = useT()
  const { propertyId, propertyName } = useAuth()
  const toast = useToast()

  const [today, setToday] = useState(null)
  const [tomorrow, setTomorrow] = useState(null)
  const [hours, setHours] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const todayDate = istToday()
  const tomorrowDate = istTomorrow()

  const load = useCallback(async () => {
    if (!propertyId) return

    const [rangesRes, carsRes] = await Promise.all([
      supabase
        .from('token_ranges')
        .select('id, range_date, range_start, range_end, next_token')
        .eq('property_id', propertyId)
        .in('range_date', [todayDate, tomorrowDate]),
      supabase
        .from('parked_vehicles')
        .select('parked_at')
        .eq('property_id', propertyId)
        .eq('service_date', todayDate),
    ])

    if (rangesRes.error) {
      setError(describeDbError(rangesRes.error, t('tokens.couldNotLoad')))
      setLoading(false)
      return
    }

    const rows = rangesRes.data ?? []
    setError(null)
    setToday(rows.find((r) => r.range_date === todayDate) ?? null)
    setTomorrow(rows.find((r) => r.range_date === tomorrowDate) ?? null)

    // Bucket by IST hour, not the device's — a laptop left on UTC would shift
    // the whole evening peak by five and a half hours.
    const buckets = Array(24).fill(0)
    for (const car of carsRes.data ?? []) buckets[istHour(car.parked_at)] += 1
    setHours(buckets)
    setLoading(false)
  }, [propertyId, todayDate, tomorrowDate, t])

  useEffect(() => {
    load()
  }, [load])

  // Another operator checking a car in moves next_token, so this screen has to
  // follow the property rather than only reloading on demand.
  useRealtime({
    channel: `tokens-vehicles:${propertyId}`,
    table: 'parked_vehicles',
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

  async function createRange(date, start, end) {
    const { error: err } = await supabase.from('token_ranges').insert({
      property_id: propertyId,
      range_date: date,
      range_start: start,
      range_end: end,
      // Must start AT range_start, not at the column default of 1 — otherwise
      // a range beginning at 500 would hand out token 1.
      next_token: start,
    })

    if (err) {
      toast.error(describeDbError(err, t('tokens.couldNotCreate')))
      return false
    }
    toast.success(t('tokens.created', { date: formatDate(`${date}T12:00:00+05:30`) }))
    load()
    return true
  }

  async function extendRange(range, newEnd) {
    const { data, error: err } = await supabase
      .from('token_ranges')
      .update({ range_end: newEnd })
      .eq('id', range.id)
      // Only ever upward. A number below the current end matches nothing, so
      // the guard is in the query rather than in a check we could forget.
      .lt('range_end', newEnd)
      .select('id')

    if (err) {
      toast.error(describeDbError(err, t('tokens.couldNotExtend')))
      return false
    }
    if (!data || data.length === 0) {
      toast.error(t('tokens.onlyBigger'))
      return false
    }

    toast.success(t('tokens.extended', { end: newEnd }))
    load()
    return true
  }

  if (loading) {
    return (
      <>
        <HeaderSkeleton />
        <StatRowSkeleton />
        <div className="mb-5 grid gap-5 lg:grid-cols-2">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={2} />
        </div>
        <SectionHeadingSkeleton />
        <ChartSkeleton height={240} bars={13} />
      </>
    )
  }

  const used = today ? today.next_token - today.range_start : 0
  const size = today ? today.range_end - today.range_start + 1 : 0
  const remaining = today ? Math.max(0, today.range_end - today.next_token + 1) : 0
  const low = today && remaining <= 20

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
      ) : !today ? (
        // No range today means no stats and no chart worth drawing, so this
        // branch is just the two set-up forms, at a form's width.
        <div className="max-w-3xl">
          <SectionHeading title={t('tokens.today')} icon="ticket" />
          <NoRangeYet date={todayDate} onCreate={createRange} label="today" />
          <Tomorrow
            range={tomorrow}
            date={tomorrowDate}
            onCreate={createRange}
          />
        </div>
      ) : (
        <>
          {/* Every tile carries a hint. Four tiles across a wide monitor with
              nothing but a label and a two-digit number read as an unfinished
              page; the hint is also the line that makes each number mean
              something to someone who has not used this screen before. */}
          <StatRow className="mb-5">
            <StatTile
              label={t('tokens.nextToken')}
              value={today.next_token}
              icon="ticket"
              hint={t('tokens.goesToNext')}
            />
            <StatTile
              label={t('tokens.used')}
              value={used}
              icon="car"
              tone="info"
              hint={t('tokens.ofToday', { n: size })}
            />
            <StatTile
              label={t('tokens.remaining')}
              value={remaining}
              icon={low ? 'alert' : 'check-circle'}
              tone={low ? 'danger' : 'success'}
              hint={t(low ? 'tokens.extendNow' : 'tokens.enough')}
            />
            <StatTile
              label={t('tokens.range')}
              value={`${today.range_start}–${today.range_end}`}
              icon="grid"
              hint={formatDate(`${todayDate}T12:00:00+05:30`)}
            />
          </StatRow>

          {low && (
            <p className="mb-5 flex max-w-3xl items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-3 text-sm font-medium text-danger">
              <Icon name="alert" size={17} className="mt-0.5 shrink-0" strokeWidth={2} />
              <span>
                {t(remaining === 1 ? 'tokens.lowWarning' : 'tokens.lowWarning_plural', {
                  n: remaining,
                })}
              </span>
            </p>
          )}

          {/* Today and Tomorrow side by side, chart full width beneath.
              The previous attempt paired a narrow controls column with the
              chart, and those two are nothing alike in height — whichever
              ran short left a hole beside the other. Today and Tomorrow are
              the same kind of thing and come out roughly the same size, so
              they pair cleanly; the chart then gets the whole width, which is
              what a chart actually wants.
              h-full on both cards so the shorter one squares off rather than
              leaving a step between them. */}
          <div className="mb-5 grid gap-5 lg:grid-cols-2">
            <div className="flex flex-col">
              <SectionHeading title={t('tokens.today')} icon="ticket" />
              <Card className="flex-1">
                <ProgressBar
                  value={used}
                  max={size}
                  tone={low ? 'danger' : 'info'}
                  label={t('tokens.issuedToday')}
                />
                <ExtendForm range={today} onExtend={extendRange} />
              </Card>
            </div>

            <div className="flex flex-col">
              <Tomorrow
                range={tomorrow}
                date={tomorrowDate}
                onCreate={createRange}
                cardClassName="flex-1"
              />
            </div>
          </div>

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
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════
// TOMORROW
//
// One component because it appears in two places — beside today's controls
// once a range exists, and under the set-up form when it does not. Two copies
// of it drifted the moment the layout changed.
// ═══════════════════════════════════════════════════════════════════

function Tomorrow({ range, date, onCreate, cardClassName = 'mb-5' }) {
  const t = useT()

  return (
    <>
      <SectionHeading title={t('tokens.tomorrow')} icon="clock" />
      {range ? (
        <Card className={cardClassName}>
          <CardHeader
            icon="check-circle"
            title={t('tokens.ready', { start: range.range_start, end: range.range_end })}
            subtitle={formatDate(`${date}T12:00:00+05:30`)}
          />
          <p className="mt-3 text-sm leading-relaxed text-ink-subtle">
            {t('tokens.readyBody', { start: range.range_start })}
          </p>
        </Card>
      ) : (
        <NoRangeYet
          date={date}
          onCreate={onCreate}
          label="tomorrow"
          className={cardClassName}
        />
      )}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════

function NoRangeYet({ date, onCreate, label, className = 'mb-5' }) {
  const t = useT()
  const [start, setStart] = useState(String(DEFAULT_TOKEN_START))
  const [end, setEnd] = useState(String(DEFAULT_TOKEN_END))
  const [error, setError] = useState(null)

  const submit = async () => {
    const s = Number(start)
    const e = Number(end)

    if (!Number.isInteger(s) || s < 1) return setError(t('tokens.startTooSmall'))
    if (!Number.isInteger(e) || e <= s) return setError(t('tokens.endTooSmall'))
    if (e - s + 1 > 5000) return setError(t('tokens.rangeTooBig'))

    setError(null)
    await onCreate(date, s, e)
    return undefined
  }

  return (
    <Card className={className}>
      <CardHeader
        icon="ticket"
        title={t(label === 'today' ? 'tokens.noRangeToday' : 'tokens.noRangeTomorrow')}
        subtitle={
          label === 'today'
            ? t('tokens.noRangeTodayBody', {
                start: DEFAULT_TOKEN_START,
                end: DEFAULT_TOKEN_END,
              })
            : t('tokens.noRangeTomorrowBody')
        }
      />

      {/* The button goes UNDER the fields, not beside them. This card renders
          both full width and inside a 26rem column, and three controls in a
          row do not survive the narrow case. Two short number fields side by
          side always fit. */}
      <div className="mt-4 space-y-3">
        <div className="flex gap-3">
          <Input
            label={t('tokens.firstToken')}
            type="tel"
            inputMode="numeric"
            value={start}
            onChange={(e) => setStart(e.target.value.replace(/\D/g, '').slice(0, 5))}
            containerClassName="min-w-0 flex-1"
          />
          <Input
            label={t('tokens.lastToken')}
            type="tel"
            inputMode="numeric"
            value={end}
            onChange={(e) => setEnd(e.target.value.replace(/\D/g, '').slice(0, 5))}
            containerClassName="min-w-0 flex-1"
          />
        </div>
        <Button variant="primary" icon="plus" onClick={submit} fullWidth>
          {t('tokens.create')}
        </Button>
      </div>

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-sm font-medium text-danger">
          <Icon name="alert" size={15} className="mt-0.5" />
          <span>{error}</span>
        </p>
      )}
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════
// EXTEND
// ═══════════════════════════════════════════════════════════════════

function ExtendForm({ range, onExtend }) {
  const t = useT()
  const [value, setValue] = useState('')
  const [error, setError] = useState(null)

  const submit = async () => {
    const next = Number(value)
    if (!Number.isInteger(next) || next <= range.range_end) {
      return setError(t('tokens.enterAbove', { end: range.range_end }))
    }
    if (next - range.range_start + 1 > 5000) {
      return setError(t('tokens.rangeTooBigOne'))
    }

    setError(null)
    const ok = await onExtend(range, next)
    if (ok) setValue('')
    return undefined
  }

  return (
    <div className="mt-5 border-t border-line pt-4">
      {/* The button lives INSIDE the Field, in a row with the input.
          The obvious layout — <Input> beside <Button> with items-end — aligns
          the button to the bottom of the whole FIELD, and a field is label +
          input + hint. So the button sat level with the hint text, one line
          below the box it belongs to, and dropped further the moment an error
          replaced the hint. Same pattern as PinSection in StaffManager. */}
      <Field
        label={t('tokens.extendTo')}
        htmlFor="extend-token"
        error={error}
        hint={!error ? t('tokens.extendHint', { end: range.range_end }) : undefined}
      >
        <div className="flex items-start gap-2">
          <input
            id="extend-token"
            value={value}
            onChange={(e) => {
              setValue(e.target.value.replace(/\D/g, '').slice(0, 5))
              if (error) setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            type="tel"
            inputMode="numeric"
            placeholder={String(range.range_end + 100)}
            aria-invalid={error ? true : undefined}
            className={cn(
              // min-w-0 so the input yields to the button instead of pushing
              // it off the row — see the note in ui/BarChart for the same trap.
              'tnum h-touch min-w-0 flex-1 rounded-xl border bg-surface px-4',
              'text-base text-ink outline-none placeholder:text-ink-subtle',
              error
                ? 'border-danger focus:border-danger'
                : 'border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20',
            )}
          />
          <Button
            variant="secondary"
            icon="plus"
            onClick={submit}
            disabled={!value}
            className="shrink-0"
          >
            {t('tokens.extend')}
          </Button>
        </div>
      </Field>
    </div>
  )
}
