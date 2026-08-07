/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/admin/Analytics.jsx                                 │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Volume, wait times and peak hours for one property.               │
 * │                                                                     │
 * │ THE NUMBER THIS SCREEN EXISTS FOR                                    │
 * │   Guest wait — how long someone stood there between asking for       │
 * │   their car and getting it. Everything else is context for it.       │
 * │   Cars-per-day says when you are busy, peak hours says when to       │
 * │   roster, and the wait says whether you got that right.              │
 * │                                                                     │
 * │ WHY IT IS MEASURED FROM created_at, NOT assigned_at                  │
 * │   The wait starts when the guest ASKS, not when an admin gets round  │
 * │   to dispatching someone. Measuring from assignment would hide the   │
 * │   exact delay this page exists to expose — a queue nobody was        │
 * │   watching would score perfectly.                                    │
 * │                                                                     │
 * │ WHY THIS PAGE DOES ALMOST NO ARITHMETIC                              │
 * │   It used to fetch every row for the period and total them in a      │
 * │   loop. At 1000 tokens a day, a quarter is tens of thousands of      │
 * │   rows over hotel wifi to produce eight numbers — and if PostgREST   │
 * │   is ever given a row ceiling, an over-long query comes back SHORT   │
 * │   WITH NO ERROR and the chart is quietly wrong. Postgres does the    │
 * │   aggregation now. See lib/analyticsApi and migration 0011.          │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   lib/analyticsApi, ui/BarChart, ui/StatTile, utils/format, types    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/AppShell'
import { BarChart, MeterList } from '@/components/ui/BarChart'
import Button from '@/components/ui/Button'
import Badge from '@/components/ui/Badge'
import Card, { SectionHeading } from '@/components/ui/Card'
import Icon from '@/components/ui/Icon'
import EmptyState from '@/components/ui/EmptyState'
import RangePicker, { presetRange } from '@/components/ui/RangePicker'
import {
  ChartSkeleton,
  HeaderSkeleton,
  PillsSkeleton,
  SectionHeadingSkeleton,
  StatRowSkeleton,
} from '@/components/ui/PageSkeleton'
import StatTile, { StatRow } from '@/components/ui/StatTile'
import { TierBadge } from '@/components/ui/Badge'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { byOperator, summary } from '@/lib/analyticsApi'
import {
  hourLabel,
  peakHour,
  perDayLabel,
  rangeLabel,
  toDayChart,
  toHourChart,
} from '@/utils/chartData'
import { formatMinutes, percent, personName } from '@/utils/format'
import { CAR_TIER_LIST, CAR_TIER_META } from '@/types'

export default function Analytics() {
  const t = useT()
  const { propertyId, propertyName } = useAuth()

  const [data, setData] = useState(null)
  /**
   * Per-operator workload. Its own state and NOT fatal — the page's numbers are
   * still worth showing if this one query fails, and an error banner over the
   * whole screen for a supporting table would hide them.
   */
  const [operators, setOperators] = useState([])
  const [operatorError, setOperatorError] = useState(null)
  // A {from, to} pair, not a day count — see ui/RangePicker.
  const [range, setRange] = useState(() => presetRange('30d'))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!propertyId) return
    setLoading(true)

    const [result, opsResult] = await Promise.all([
      summary(propertyId, range.from, range.to),
      byOperator(range.from, range.to, propertyId),
    ])

    if (!result.ok) {
      setError(result.error)
      setLoading(false)
      return
    }

    setError(null)
    setData(result.data)
    setOperators(opsResult.ok ? (opsResult.rows ?? []) : [])
    setOperatorError(opsResult.ok ? null : opsResult.error)
    setLoading(false)
  }, [propertyId, range])

  useEffect(() => {
    load()
  }, [load])

  // `data.days` and not range — the server clamps a very wide span, so the
  // axis has to thin out based on what actually came back.
  const dayChart = useMemo(() => toDayChart(data?.per_day, data?.days ?? 30), [data])
  const hourChart = useMemo(() => toHourChart(data?.per_hour), [data])

  const busiestHour = useMemo(() => peakHour(data?.per_hour), [data])

  const tiers = useMemo(
    () =>
      CAR_TIER_LIST.map((tier) => ({
        key: tier,
        label: t(`tier.${tier}`),
        value: data?.tiers?.[tier] ?? 0,
        tone: CAR_TIER_META[tier].tone,
        badge: <TierBadge tier={tier} alwaysShow size="sm" />,
      })),
    [data],
  )

  // The skeleton mirrors this page's own blocks — pills, four tiles, two
  // charts — so nothing shifts when the numbers arrive.
  if (loading) {
    return (
      <>
        <HeaderSkeleton />
        <PillsSkeleton />
        <StatRowSkeleton />
        <SectionHeadingSkeleton />
        <ChartSkeleton height={180} bars={30} className="mb-5" />
        <SectionHeadingSkeleton />
        <ChartSkeleton height={170} bars={24} />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('analytics.title')}
        subtitle={propertyName}
        actions={
          <Button variant="secondary" size="md" icon="refresh" onClick={load}>
            {t('common.refresh')}
          </Button>
        }
      />

      <RangePicker from={range.from} to={range.to} onChange={setRange} />

      {error ? (
        <EmptyState
          variant="error"
          title={t('analytics.couldNotLoad')}
          description={error}
          action={
            <Button variant="secondary" icon="refresh" onClick={load}>
              {t('common.tryAgain')}
            </Button>
          }
        />
      ) : !data || data.cars === 0 ? (
        <EmptyState
          icon="chart"
          title={t('analytics.noCars')}
          description={t('analytics.noCarsBody')}
        />
      ) : (
        <>
          <StatRow className="mb-5">
            <StatTile
              label={t('analytics.cars')}
              value={data.cars}
              icon="car"
              hint={perDayLabel(data.cars, data.days)}
            />
            <StatTile
              label={t('analytics.guestWait')}
              value={formatMinutes(data.retrieval_wait)}
              icon="clock"
              tone={data.retrieval_wait > 10 ? 'danger' : 'success'}
              // The count is not decoration. A median of four cars is noise,
              // and nobody should re-roster a shift because of it.
              hint={t(
                data.retrieval_count === 1
                  ? 'analytics.medianRetrievals'
                  : 'analytics.medianRetrievals_plural',
                { n: data.retrieval_count },
              )}
            />
            <StatTile
              label={t('analytics.timeToPark')}
              value={formatMinutes(data.parking_time)}
              icon="parking"
              tone="info"
              hint={t(
                data.parking_count === 1 ? 'analytics.medianCars' : 'analytics.medianCars_plural',
                { n: data.parking_count },
              )}
            />
            <StatTile
              label={t('analytics.noShows')}
              value={data.no_shows}
              icon="x-circle"
              tone={data.no_shows > 0 ? 'warning' : 'neutral'}
              hint={t('analytics.noShowsHint')}
            />
          </StatRow>

          <SectionHeading title={t('analytics.carsPerDay')} icon="chart" />
          <Card className="mb-5">
            <BarChart
              data={dayChart}
              height={180}
              unit={t('status.unit')}
              caption={t('analytics.checkedInCaption', {
                range: rangeLabel(data.from, data.to),
              })}
            />
          </Card>

          <SectionHeading title={t('analytics.busiestHours')} icon="clock" />
          <Card className="mb-5">
            <BarChart
              data={hourChart}
              height={170}
              unit={t('status.unit')}
              caption={
                busiestHour == null
                  ? undefined
                  : t('analytics.peakCaption', { hour: hourLabel(busiestHour) })
              }
            />
          </Card>

          {/* ── WHO DID THE WORK ───────────────────────────────────────
              A table, not a chart. The question is "who is carrying the
              shift" — a lookup down a column, not a shape. Sorted by total
              so the answer is the first row. */}
          <SectionHeading
            title={t('analytics.whoDidWork')}
            count={operators.length}
            icon="users"
            action={<span className="text-xs text-ink-subtle">{t('analytics.completedOnly')}</span>}
          />
          {operatorError ? (
            <EmptyState
              variant="error"
              className="mb-5"
              title={t('analytics.couldNotLoadOperators')}
              description={operatorError}
              action={
                <Button variant="secondary" icon="refresh" onClick={load}>
                  {t('common.tryAgain')}
                </Button>
              }
            />
          ) : operators.length === 0 ? (
            <EmptyState
              compact
              className="mb-5"
              icon="users"
              title={t('analytics.nobodyFinished')}
              description={t('analytics.nobodyFinishedBody')}
            />
          ) : (
            <Card padded={false} className="mb-5 max-w-4xl overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-subtle">
                    <th scope="col" className="px-4 py-3 font-semibold">{t('analytics.colOperator')}</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">{t('analytics.colParked')}</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">{t('analytics.colFetched')}</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">{t('analytics.colTotal')}</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">{t('analytics.guestWait')}</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">{t('analytics.noShows')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {operators.map((op) => {
                    const wait = op.retrieval_wait == null ? null : Number(op.retrieval_wait)
                    const thin = Number(op.fetched) < 5

                    return (
                      <tr key={op.operator_id} className={op.is_active ? '' : 'opacity-60'}>
                        <th scope="row" className="px-4 py-3 text-left font-medium text-ink">
                          <span className="flex flex-wrap items-center gap-2">
                            {personName(op.operator_name, op.operator_name_hi)}
                            {/* Someone who left still parked two hundred cars.
                                Dropping them would make last month stop adding
                                up, so they stay, marked. */}
                            {!op.is_active && (
                              <Badge tone="neutral" size="sm">
                                {t('analytics.left')}
                              </Badge>
                            )}
                          </span>
                        </th>
                        <td className="tnum px-4 py-3 text-right text-ink-muted">{op.parked}</td>
                        <td className="tnum px-4 py-3 text-right text-ink-muted">{op.fetched}</td>
                        <td className="tnum px-4 py-3 text-right font-bold text-ink">
                          {op.total_tasks}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className={
                              wait != null && wait > 10 && !thin
                                ? 'tnum font-semibold text-danger'
                                : 'tnum text-ink-muted'
                            }
                          >
                            {formatMinutes(wait)}
                          </span>
                          {/* A median from a handful is not a fact, and a red
                              number would send an admin to have a word with
                              somebody over noise. */}
                          {thin && Number(op.fetched) > 0 && (
                            <span className="ml-1 text-xs text-ink-subtle">({op.fetched})</span>
                          )}
                        </td>
                        <td className="tnum px-4 py-3 text-right text-ink-muted">{op.no_shows}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Card>
          )}

          <p className="mb-6 flex max-w-3xl items-start gap-2 text-xs leading-relaxed text-ink-subtle">
            <Icon name="info" size={14} className="mt-0.5 shrink-0" />
            <span>{t('analytics.tableNote')}</span>
          </p>

          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <SectionHeading title={t('analytics.carMix')} icon="star" />
              <Card>
                <MeterList rows={tiers} total={data.cars} unit={t('status.unit')} />
              </Card>
            </div>

            <div>
              <SectionHeading title={t('analytics.completed')} icon="check-circle" />
              <Card>
                <p className="text-sm leading-relaxed text-ink-muted">
                  <span className="tnum text-2xl font-bold text-ink">
                    {percent(data.delivered, data.cars)}
                  </span>{' '}
                  {t('analytics.completedBody', { done: data.delivered, total: data.cars })}
                </p>
                <p className="mt-2 text-xs text-ink-subtle">
                  {t('analytics.completedNote')}
                </p>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  )
}
