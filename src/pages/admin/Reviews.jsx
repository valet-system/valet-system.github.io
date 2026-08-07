/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/admin/Reviews.jsx                                   │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Guest ratings for this property: the split, a filterable list,     │
 * │   and a CSV export.                                                  │
 * │                                                                     │
 * │ IT WILL BE EMPTY UNTIL WHATSAPP EXISTS                               │
 * │   Nothing in the app writes to `reviews`. A rating arrives when a    │
 * │   guest taps a button in the "your car has been delivered" message,  │
 * │   which the wa-webhook Edge Function receives — and that is not      │
 * │   built yet. The empty state says so, rather than implying nobody    │
 * │   has rated anything.                                                │
 * │                                                                     │
 * │ WHY THERE IS NO WAY TO ADD OR EDIT A REVIEW                          │
 * │   `reviews` has a SELECT policy and nothing else — writes are        │
 * │   service_role only, from the webhook. An operator being able to     │
 * │   file a five-star review for themselves would make the whole table  │
 * │   worthless, and this screen is where the temptation would live.     │
 * │                                                                     │
 * │ WHY THE PHONE IS MASKED                                              │
 * │   An admin reviewing service quality has no operational need for a   │
 * │   guest's number — the car has already gone. Least privilege applied │
 * │   to the UI, not only to the database. The CSV masks it too.         │
 * │                                                                     │
 * │ WHY operator_id AND NOT THE TASK'S OPERATOR                          │
 * │   valet_tasks.assigned_operator_id can change on a re-park, so       │
 * │   deriving "who delivered it" afterwards gives the wrong person.     │
 * │   Migration 0002 added reviews.operator_id, captured at insert.      │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase, ui/BarChart, ui/StatTile, utils/format, types        │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/AppShell'
import { MeterList } from '@/components/ui/BarChart'
import Button from '@/components/ui/Button'
import Card, { SectionHeading } from '@/components/ui/Card'
import EmptyState from '@/components/ui/EmptyState'
import Icon from '@/components/ui/Icon'
import {
  CardSkeleton,
  HeaderSkeleton,
  PillsSkeleton,
  RowsSkeleton,
  SectionHeadingSkeleton,
  StatRowSkeleton,
} from '@/components/ui/PageSkeleton'
import RangePicker, { presetRange } from '@/components/ui/RangePicker'
import StatTile, { StatRow } from '@/components/ui/StatTile'
import { RatingBadge } from '@/components/ui/Badge'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { supabase, describeDbError, selectOptional } from '@/supabase'
import {
  downloadCsv,
  formatDateTime,
  istDayEnd,
  istDayStart,
  istDaysAgo,
  istToday,
  maskPhone,
  percent,
  personName,
  prettyCarNumber,
} from '@/utils/format'
import { RATING_LIST, RATING_META, RATINGS } from '@/types'

/**
 * Most recent reviews loaded per range. See the note at the query.
 *
 * Not paginated further because nobody reads review 600. If the split by
 * rating ever needs to be exact over a long window it belongs in an
 * aggregating RPC, the way analytics went — not in a bigger fetch.
 */
const REVIEW_LIMIT = 500

export default function Reviews() {
  const t = useT()
  const { propertyId, propertyName } = useAuth()

  const [rows, setRows] = useState([])
  const [operators, setOperators] = useState([])
  // A {from, to} pair, the same shape the two Analytics screens use.
  //
  // This used to be a plain day count, which worked only until the first tap:
  // RangePicker calls onChange with {from, to}, so setDays replaced the number
  // 30 with an object, and istDaysAgo(object) produced an invalid date. The
  // first render was right and every range change after it was silently wrong.
  const [range, setRange] = useState(() => presetRange('30d'))
  const [rating, setRating] = useState('all')
  const [operatorId, setOperatorId] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!propertyId) return
    setLoading(true)

    // Both ends are optional on the picker: an empty From means the last 30
    // days, an empty To means up to today. Same rule as the Analytics screens.
    // Service-day boundaries, not calendar ones: a review left at 01:00 belongs
    // to the night before, the same as the car it is about. istDayEnd is the
    // EXCLUSIVE end — 05:30 the next morning — so `lt`, not `lte`, below.
    const from = istDayStart(range.from ?? istDaysAgo(29))
    const to = istDayEnd(range.to ?? istToday())

    // An explicit ceiling on the review read, so behaviour is defined rather
    // than inherited. 90 days at event volume is thousands of reviews, and the
    // summary percentages below are computed from what came back — an
    // unbounded query silently truncated by a server-side row limit would
    // produce percentages that look authoritative and are wrong. This caps it
    // where WE decide, and the notice below says the numbers are a sample.
    //
    // Both reads ask for name_hi optimistically: it arrives with migration
    // 0022 and neither the list nor the filter needs it to be useful.
    const reviewQuery = (operatorColumns) =>
      supabase
        .from('reviews')
        .select(
          `id, rating, guest_phone, created_at, operator_id,
           operator:user_roles ( ${operatorColumns} ),
           valet_tasks ( id, parked_vehicles ( token_number, car_number, car_tier ) )`,
        )
        .eq('property_id', propertyId)
        .gte('created_at', from)
        .lt('created_at', to)
        .order('created_at', { ascending: false })
        .limit(REVIEW_LIMIT)

    const staffQuery = (columns) =>
      supabase
        .from('user_roles')
        .select(columns)
        .eq('property_id', propertyId)
        .eq('role', 'operator')
        .order('name')

    const [reviewRes, staffRes] = await Promise.all([
      selectOptional(
        () => reviewQuery('id, name, name_hi'),
        () => reviewQuery('id, name'),
        'user_roles.name_hi',
      ),
      selectOptional(
        () => staffQuery('id, name, name_hi'),
        () => staffQuery('id, name'),
        'user_roles.name_hi',
      ),
    ])

    if (reviewRes.error) {
      setError(describeDbError(reviewRes.error, t('reviews.couldNotLoad')))
      setLoading(false)
      return
    }

    setError(null)
    setRows(reviewRes.data ?? [])
    if (!staffRes.error) setOperators(staffRes.data ?? [])
    setLoading(false)
  }, [propertyId, range.from, range.to, t])

  useEffect(() => {
    load()
  }, [load])

  // Filtering is client-side: a property does at most a few hundred reviews in
  // 90 days and they are already here, so a round trip per filter tap would
  // only add latency.
  const visible = useMemo(
    () =>
      rows.filter((row) => {
        if (rating !== 'all' && row.rating !== rating) return false
        if (operatorId !== 'all' && row.operator_id !== operatorId) return false
        return true
      }),
    [rows, rating, operatorId],
  )

  const counts = useMemo(() => {
    const result = { total: rows.length }
    for (const key of RATING_LIST) result[key] = rows.filter((r) => r.rating === key).length
    return result
  }, [rows])

  function exportCsv() {
    downloadCsv(
      `reviews-${propertyName?.toLowerCase().replace(/\s+/g, '-') ?? 'property'}-${istToday()}.csv`,
      visible.map((row) => ({
        Date: formatDateTime(row.created_at),
        Token: row.valet_tasks?.parked_vehicles?.token_number ?? '',
        Car: row.valet_tasks?.parked_vehicles?.car_number ?? '',
        // Masked in the export too. A spreadsheet leaves the building far more
        // easily than the screen it was copied from.
        Guest: `="${maskPhone(row.guest_phone)}"`,
        Rating: RATING_META[row.rating]?.label ?? row.rating,
        // English on purpose: a spreadsheet is opened on a laptop by whoever
        // does payroll, sorted and filtered, and is the one artefact that leaves
        // the app. One stable spelling per person matters more there than the
        // reader's language preference.
        Operator: row.operator?.name ?? '',
      })),
    )
  }

  if (loading) {
    return (
      <>
        <HeaderSkeleton />
        <PillsSkeleton />
        <StatRowSkeleton />
        <CardSkeleton lines={3} className="mb-5" />
        <SectionHeadingSkeleton />
        <RowsSkeleton rows={5} height="h-16" />
      </>
    )
  }

  const good = counts[RATINGS.EXCELLENT] + counts[RATINGS.GOOD]

  return (
    <>
      <PageHeader
        title={t('reviews.title')}
        subtitle={propertyName}
        actions={
          <>
            <Button variant="secondary" size="md" icon="refresh" onClick={load}>
              {t('common.refresh')}
            </Button>
            <Button
              variant="secondary"
              size="md"
              icon="download"
              onClick={exportCsv}
              disabled={visible.length === 0}
            >
              CSV
            </Button>
          </>
        }
      />

      {/* Range picker sits above everything it changes. */}
      <RangePicker from={range.from} to={range.to} onChange={setRange} />

      <StatRow className="mb-5">
        <StatTile label={t('reviews.count')} value={counts.total} icon="star" />
        <StatTile
          label={t('reviews.excellent')}
          value={percent(counts[RATINGS.EXCELLENT], counts.total)}
          icon="star"
          tone="success"
          hint={t('reviews.guests', { n: counts[RATINGS.EXCELLENT] })}
        />
        <StatTile
          label={t('reviews.positive')}
          value={percent(good, counts.total)}
          icon="check-circle"
          tone="info"
          hint={t('reviews.positiveHint')}
        />
        <StatTile
          label={t('reviews.poor')}
          value={percent(counts[RATINGS.POOR], counts.total)}
          icon="x-circle"
          tone={counts[RATINGS.POOR] > 0 ? 'danger' : 'neutral'}
          hint={`${counts[RATINGS.POOR]} guests`}
        />
      </StatRow>

      {/* Says so when the numbers above are a sample. Percentages presented
          without this look like the whole period and would be quoted as such. */}
      {rows.length >= REVIEW_LIMIT && (
        <p className="mb-5 flex max-w-3xl items-start gap-2 rounded-lg bg-info-soft px-3.5 py-2.5 text-xs leading-relaxed text-info">
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          <span>
            This period has more than {REVIEW_LIMIT} reviews. Everything above is the most
            recent {REVIEW_LIMIT} — accurate for a trend, not a total. Pick a shorter range for
            exact figures.
          </span>
        </p>
      )}

      {error ? (
        <EmptyState
          variant="error"
          title={t('reviews.couldNotLoad')}
          description={error}
          action={
            <Button variant="secondary" icon="refresh" onClick={load}>
              {t('common.tryAgain')}
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="star"
          title={t('reviews.noneYet')}
          description={t('reviews.noneYetBody')}
        />
      ) : (
        <>
          <Card className="mb-5">
            <SectionHeading title={t('reviews.howRated')} />
            <MeterList
              rows={RATING_LIST.map((key) => ({
                key,
                label: t(`rating.${key}`),
                value: counts[key],
                tone: RATING_META[key].tone,
                badge: <RatingBadge rating={key} size="sm" />,
              }))}
              total={counts.total}
              unit={t('reviews.unit')}
            />
          </Card>

          <div className="mb-4 flex flex-wrap gap-2">
            <select
              value={rating}
              onChange={(e) => setRating(e.target.value)}
              aria-label={t('reviews.filterRating')}
              className="h-11 rounded-xl border border-line-strong bg-surface px-3 text-base font-medium text-ink outline-none focus:border-brand sm:text-sm"
            >
              <option value="all">{t('reviews.allRatings')}</option>
              {RATING_LIST.map((key) => (
                <option key={key} value={key}>
                  {t(`rating.${key}`)}
                </option>
              ))}
            </select>

            <select
              value={operatorId}
              onChange={(e) => setOperatorId(e.target.value)}
              aria-label={t('reviews.filterOperator')}
              className="h-11 rounded-xl border border-line-strong bg-surface px-3 text-base font-medium text-ink outline-none focus:border-brand sm:text-sm"
            >
              <option value="all">{t('reviews.allOperators')}</option>
              {operators.map((op) => (
                <option key={op.id} value={op.id}>
                  {personName(op.name, op.name_hi)}
                </option>
              ))}
            </select>
          </div>

          <SectionHeading title={t('reviews.every')} count={visible.length} icon="list" />

          {visible.length === 0 ? (
            <EmptyState
              compact
              icon="search"
              title={t('reviews.nothingMatches')}
              description={t('reviews.nothingMatchesBody')}
            />
          ) : (
            <Card padded={false} className="divide-y divide-line">
              {visible.map((row) => {
                const vehicle = row.valet_tasks?.parked_vehicles
                return (
                  <div key={row.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="tnum flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-sm font-bold text-ink">
                      {vehicle?.token_number ?? '—'}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold tracking-wide text-ink">
                          {vehicle?.car_number ? prettyCarNumber(vehicle.car_number) : t('reviews.carRemoved')}
                        </span>
                        <RatingBadge rating={row.rating} size="sm" />
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-subtle">
                        <span className="tnum">{maskPhone(row.guest_phone)}</span>
                        {row.operator?.name &&
                          ` · ${personName(row.operator.name, row.operator.name_hi)}`}
                        {' · '}
                        {formatDateTime(row.created_at)}
                      </p>
                    </div>

                    <Icon
                      name={RATING_META[row.rating]?.icon ?? 'star'}
                      size={17}
                      className={
                        row.rating === RATINGS.POOR
                          ? 'shrink-0 text-danger'
                          : 'shrink-0 text-success'
                      }
                    />
                  </div>
                )
              })}
            </Card>
          )}
        </>
      )}
    </>
  )
}
