/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/system/Analytics.jsx                                │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The group view: all four sites combined, plus a table comparing    │
 * │   them. The one screen in the system that is allowed to cross a      │
 * │   property boundary.                                                 │
 * │                                                                     │
 * │ WHY A VALET ADMIN CANNOT SEE THIS                                    │
 * │   analytics_by_property() refuses anyone who is not a system_admin.  │
 * │   Nobody has asked to let one site's manager see another's volume,   │
 * │   and every other screen in the app is scoped to one property — a    │
 * │   comparison table is exactly how that scoping would leak.           │
 * │                                                                     │
 * │ WHY THE COMPARISON IS A TABLE AND NOT A GROUPED BAR CHART            │
 * │   Four properties across five different measures is twenty numbers,  │
 * │   and the question being asked is "which site is slow" — a lookup,   │
 * │   not a shape. A grouped chart would need a colour per property,     │
 * │   spend the reader's attention on a legend, and still be read one    │
 * │   value at a time. The magnitude bars stay for the one measure       │
 * │   where relative size IS the point: volume.                          │
 * │                                                                     │
 * │ THE COMBINED CHART IS ONE SERIES                                     │
 * │   Cars per day across the group, not four stacked bands. Stacking    │
 * │   would ask the reader to compare segments that do not share a       │
 * │   baseline, which is the thing stacked bars are worst at. Per-site   │
 * │   detail is one row down, in the table.                              │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   lib/analyticsApi, ui/BarChart, ui/StatTile, admin/Analytics        │
 * │   (RangePicker and the chart adapters, shared so the two pages       │
 * │   cannot drift), utils/format                                        │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/AppShell'
import { BarChart, MeterList } from '@/components/ui/BarChart'
import Button from '@/components/ui/Button'
import Card, { SectionHeading } from '@/components/ui/Card'
import EmptyState from '@/components/ui/EmptyState'
import Icon from '@/components/ui/Icon'
import RangePicker, { presetRange } from '@/components/ui/RangePicker'
import { useT } from '@/i18n'
import {
  ChartSkeleton,
  HeaderSkeleton,
  PillsSkeleton,
  SectionHeadingSkeleton,
  StatRowSkeleton,
  TableSkeleton,
} from '@/components/ui/PageSkeleton'
import StatTile, { StatRow } from '@/components/ui/StatTile'
import Badge from '@/components/ui/Badge'
import { byProperty, summary } from '@/lib/analyticsApi'
import {
  hourLabel,
  peakHour,
  perDayLabel,
  rangeLabel,
  toDayChart,
  toHourChart,
} from '@/utils/chartData'
import { formatMinutes, percent } from '@/utils/format'

export default function SystemAnalytics() {
  const t = useT()
  const [group, setGroup] = useState(null)
  const [sites, setSites] = useState([])
  const [range, setRange] = useState(() => presetRange('30d'))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  /**
   * Kept separate from `error`: the group totals can load perfectly while the
   * per-property breakdown fails, and swallowing that produced the worst
   * possible screen — a table with headers, no rows, a count of 0, and
   * nothing anywhere saying why. It read as "no data", which was a lie.
   */
  const [siteError, setSiteError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)

    // null property = every property, which the database only honours for a
    // system_admin. See lib/analyticsApi.
    const [groupRes, siteRes] = await Promise.all([
      summary(null, range.from, range.to),
      byProperty(range.from, range.to),
    ])

    if (!groupRes.ok) {
      setError(groupRes.error)
      setLoading(false)
      return
    }

    setError(null)
    setGroup(groupRes.data)
    setSites(siteRes.ok ? (siteRes.rows ?? []) : [])
    setSiteError(siteRes.ok ? null : siteRes.error)
    setLoading(false)
  }, [range])

  useEffect(() => {
    load()
  }, [load])

  const dayChart = useMemo(() => toDayChart(group?.per_day, group?.days ?? 30), [group])
  const hourChart = useMemo(() => toHourChart(group?.per_hour), [group])

  const volumeRows = useMemo(
    () =>
      sites
        .filter((site) => site.cars > 0)
        .map((site) => ({
          key: site.property_id,
          label: site.property_name,
          value: Number(site.cars),
          tone: 'info',
        })),
    [sites],
  )

  const busiestHour = useMemo(() => peakHour(group?.per_hour), [group])

  if (loading) {
    return (
      <>
        <HeaderSkeleton />
        <PillsSkeleton />
        <StatRowSkeleton />
        <SectionHeadingSkeleton />
        <TableSkeleton rows={4} cols={6} className="mb-5 max-w-5xl" />
        <SectionHeadingSkeleton />
        <ChartSkeleton height={180} bars={30} />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('group.title')}
        subtitle={t('group.subtitle')}
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
      ) : !group || group.cars === 0 ? (
        <EmptyState
          icon="chart"
          title={t('analytics.noCars')}
          description={t('group.noCarsBody')}
        />
      ) : (
        <>
          <StatRow className="mb-5">
            <StatTile
              label={t('analytics.cars')}
              value={group.cars}
              icon="car"
              hint={t('group.acrossGroup', { rate: perDayLabel(group.cars, group.days) })}
            />
            <StatTile
              label={t('analytics.guestWait')}
              value={formatMinutes(group.retrieval_wait)}
              icon="clock"
              tone={group.retrieval_wait > 10 ? 'danger' : 'success'}
              hint={t(
                group.retrieval_count === 1
                  ? 'analytics.medianRetrievals'
                  : 'analytics.medianRetrievals_plural',
                { n: group.retrieval_count },
              )}
            />
            <StatTile
              label={t('queue.delivered')}
              value={percent(group.delivered, group.cars)}
              icon="check-circle"
              tone="success"
              hint={t('group.deliveredHint', { done: group.delivered, total: group.cars })}
            />
            <StatTile
              label={t('analytics.noShows')}
              value={group.no_shows}
              icon="x-circle"
              tone={group.no_shows > 0 ? 'warning' : 'neutral'}
            />
          </StatRow>

          <SectionHeading title={t('group.siteBySite')} count={sites.length} icon="building" />

          {siteError ? (
            <EmptyState
              variant="error"
              className="mb-5"
              title={t('group.couldNotCompare')}
              description={siteError}
              action={
                <Button variant="secondary" icon="refresh" onClick={load}>
                  {t('common.tryAgain')}
                </Button>
              }
            />
          ) : sites.length === 0 ? (
            <EmptyState
              compact
              className="mb-5"
              icon="building"
              title={t('group.noProperties')}
              description={t('group.noPropertiesBody')}
            />
          ) : (
            // Capped, unlike the charts. A w-full table hands its spare width
            // to the columns, so at 1700px each of six gets ~280px and a
            // right-aligned number ends up a long way from the header that
            // names it — the eye has to travel to read one row. Six columns
            // read best around 1000px. The charts below stay full width
            // because a wider chart genuinely shows more.
            <Card padded={false} className="mb-5 max-w-5xl overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-subtle">
                  <th scope="col" className="px-4 py-3 font-semibold">
                    {t('group.colProperty')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">
                    {t('analytics.cars')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">
                    {t('queue.delivered')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">
                    {t('analytics.guestWait')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">
                    {t('analytics.noShows')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">
                    {t('group.colOperators')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sites.map((site) => {
                  const wait = site.retrieval_wait == null ? null : Number(site.retrieval_wait)
                  const thin = Number(site.retrieval_count) < 5

                  return (
                    <tr key={site.property_id} className={site.is_active ? '' : 'opacity-60'}>
                      <th scope="row" className="px-4 py-3 text-left font-medium text-ink">
                        <span className="flex items-center gap-2">
                          {site.property_name}
                          {!site.is_active && (
                            <Badge tone="warning" size="sm">
                              {t('props.closed')}
                            </Badge>
                          )}
                        </span>
                      </th>
                      <td className="tnum px-4 py-3 text-right font-semibold text-ink">
                        {site.cars}
                      </td>
                      <td className="tnum px-4 py-3 text-right text-ink-muted">
                        {percent(Number(site.delivered), Number(site.cars))}
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
                        {/* A median from a handful of cars is not a fact, and a
                            red number would send someone to fix a real site
                            over noise. Say the sample is thin instead. */}
                        {thin && Number(site.cars) > 0 && (
                          <span className="ml-1 text-xs text-ink-subtle">
                            ({site.retrieval_count})
                          </span>
                        )}
                      </td>
                      <td className="tnum px-4 py-3 text-right text-ink-muted">{site.no_shows}</td>
                      <td className="tnum px-4 py-3 text-right text-ink-muted">
                        {site.operators}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
          )}

          {/* Prose is capped too. A sentence running the full width of an
              ultrawide monitor is a single 200-character line, which nobody
              reads — the eye loses the start of the next line. */}
          <p className="mb-6 flex max-w-3xl items-start gap-2 text-xs leading-relaxed text-ink-subtle">
            <Icon name="info" size={14} className="mt-0.5 shrink-0" />
            <span>{t('group.tableNote')}</span>
          </p>

          {volumeRows.length > 1 && (
            <>
              <SectionHeading title={t('group.shareOfVolume')} icon="chart" />
              <Card className="mb-5">
                <MeterList rows={volumeRows} total={group.cars} unit={t('status.unit')} />
              </Card>
            </>
          )}

          <SectionHeading title={t('group.carsPerDayAll')} icon="chart" />
          <Card className="mb-5">
            <BarChart
              data={dayChart}
              height={180}
              unit={t('status.unit')}
              caption={t('group.everySiteCaption', {
                range: rangeLabel(group.from, group.to),
              })}
            />
          </Card>

          <SectionHeading title={t('group.busiestAll')} icon="clock" />
          <Card>
            <BarChart
              data={hourChart}
              height={170}
              unit={t('status.unit')}
              caption={
                busiestHour == null
                  ? undefined
                  : t('group.peakCaption', { hour: hourLabel(busiestHour) })
              }
            />
          </Card>
        </>
      )}
    </>
  )
}
