/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/admin/CarStatus.jsx                                 │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Where every car checked in today has got to, for the admin. The     │
 * │   breakdown at the top, then the actual cars underneath — token,      │
 * │   car, guest, number, where it is parked, and how long it has been    │
 * │   sitting there.                                                     │
 * │                                                                     │
 * │ WHY IT IS ITS OWN PAGE AND NOT A DASHBOARD SECTION                    │
 * │   It started as a section on the Dashboard. That screen exists for    │
 * │   ONE job — a guest is waiting and somebody has to be sent — and      │
 * │   anything else on it competes with that. A list of ninety parked     │
 * │   cars underneath the retrieval queue pushes the queue off the        │
 * │   screen during exactly the rush it is needed in.                     │
 * │                                                                     │
 * │ IT IS THE ADMIN'S VERSION OF Today's Cars                             │
 * │   Operators have that screen; admins had nothing equivalent. Same     │
 * │   RPC (search_todays_cars, migration 0012), so search reaches every   │
 * │   car in the day rather than only the page in memory.                 │
 * │                                                                     │
 * │ THE COUNTS COME FROM A SEPARATE QUERY, ON PURPOSE                     │
 * │   The list is a 200-row page. Counting the four groups from that      │
 * │   page would be wrong the moment a property passes 200 cars — and     │
 * │   wrong quietly, which is worse than absent. So the counts are their  │
 * │   own one-column read over the whole day.                             │
 * │                                                                     │
 * │ FOUR GROUPS, NOT NINE STATUSES                                        │
 * │   Nine exist; an admin asks four questions. `returned` counts as      │
 * │   RE-PARKED and not as parked: that car is in the car park, but it is  │
 * │   also a thing that went wrong, and folding it in hides it.            │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase, hooks/useRealtime, ui/BarChart, ui/StatTile,          │
 * │   utils/format, types                                                │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/AppShell'
import Button from '@/components/ui/Button'
import Card, { SectionHeading } from '@/components/ui/Card'
import EmptyState from '@/components/ui/EmptyState'
import { SearchInput } from '@/components/ui/Field'
import Icon from '@/components/ui/Icon'
import {
  FilterBarSkeleton,
  HeaderSkeleton,
  RowsSkeleton,
  SectionHeadingSkeleton,
  StatRowSkeleton,
} from '@/components/ui/PageSkeleton'
import StatTile, { StatRow } from '@/components/ui/StatTile'
import { RatingBadge, TierBadge, VehicleStatusBadge } from '@/components/ui/Badge'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import useRealtime from '@/hooks/useRealtime'
import { supabase, describeDbError } from '@/supabase'
import { formatPhone, formatTime, istToday, personName, prettyCarNumber, timeAgo } from '@/utils/format'
import { VEHICLE_STATUS } from '@/types'

/** See the file header — a page, not the day. */
const PAGE_SIZE = 200

/**
 * The four questions, and which statuses answer each.
 *
 * Defined once here and used for both the breakdown and the filter pills, so a
 * pill can never disagree with the bar above it.
 */
// labelKey rather than label: this array is built once at import time, so a
// baked-in string would keep whichever language loaded first.
const GROUPS = [
  {
    key: 'parked',
    labelKey: 'status.parked',
    tone: 'success',
    statuses: [VEHICLE_STATUS.PARKED],
  },
  {
    key: 'progress',
    labelKey: 'status.inProgress',
    tone: 'info',
    statuses: [
      VEHICLE_STATUS.CHECKED_IN,
      VEHICLE_STATUS.PARKING,
      VEHICLE_STATUS.REQUESTED,
      VEHICLE_STATUS.FETCHING,
      VEHICLE_STATUS.AT_PICKUP,
    ],
  },
  {
    key: 'reparked',
    labelKey: 'status.reparked',
    tone: 'warning',
    statuses: [VEHICLE_STATUS.RE_PARKING, VEHICLE_STATUS.RETURNED],
  },
  {
    key: 'delivered',
    labelKey: 'status.delivered',
    tone: 'success',
    statuses: [VEHICLE_STATUS.DELIVERED],
  },
]

export default function CarStatus() {
  const t = useT()
  const { propertyId, propertyName } = useAuth()

  const [cars, setCars] = useState([])
  const [statuses, setStatuses] = useState([])
  const [total, setTotal] = useState(0)
  const [group, setGroup] = useState('all')
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Debounced: searching is a round trip, and at 250ms a typed car number is
  // one query instead of ten.
  useEffect(() => {
    const t = setTimeout(() => setTerm(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  const load = useCallback(async () => {
    if (!propertyId) return

    const [listRes, statusRes] = await Promise.all([
      supabase.rpc('search_todays_cars', { p_query: term || null, p_limit: PAGE_SIZE }),
      // Counts over the WHOLE day, not over the page above. One column, so a
      // thousand cars is a few kB.
      supabase
        .from('parked_vehicles')
        .select('status')
        .eq('property_id', propertyId)
        .eq('service_date', istToday()),
    ])

    if (listRes.error) {
      setError(describeDbError(listRes.error, "Could not load today's cars."))
      setLoading(false)
      return
    }

    setError(null)
    setCars(listRes.data ?? [])
    setTotal(Number(listRes.data?.[0]?.total_today ?? 0))
    setStatuses(statusRes.error ? [] : (statusRes.data ?? []).map((v) => v.status))
    setLoading(false)
  }, [propertyId, term])

  useEffect(() => {
    load()
  }, [load])

  useRealtime({
    channel: `car-status:${propertyId}`,
    table: 'parked_vehicles',
    filter: propertyId ? `property_id=eq.${propertyId}` : undefined,
    enabled: Boolean(propertyId),
    onRefetch: load,
  })

  const counts = useMemo(() => {
    const out = { all: statuses.length }
    for (const g of GROUPS) {
      out[g.key] = statuses.filter((s) => g.statuses.includes(s)).length
    }
    return out
  }, [statuses])

  /** Group filter only — text matching happens in Postgres. */
  const visible = useMemo(() => {
    if (group === 'all') return cars
    const wanted = GROUPS.find((g) => g.key === group)?.statuses ?? []
    return cars.filter((c) => wanted.includes(c.status))
  }, [cars, group])

  const truncated = !term && total > cars.length

  if (loading) {
    return (
      <>
        <HeaderSkeleton action={false} />
        <StatRowSkeleton />
        <SectionHeadingSkeleton />
        <FilterBarSkeleton />
        <RowsSkeleton rows={5} height="h-24" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('status.title')}
        subtitle={
          propertyName ? t('status.todaySubtitle', { property: propertyName }) : t('common.today')
        }
        actions={
          <Button variant="secondary" size="md" icon="refresh" onClick={load}>
            {t('common.refresh')}
          </Button>
        }
      />

      <StatRow className="mb-5">
        {GROUPS.map((g) => (
          <StatTile
            key={g.key}
            label={t(g.labelKey)}
            value={counts[g.key] ?? 0}
            icon={
              g.key === 'parked'
                ? 'parking'
                : g.key === 'progress'
                  ? 'car'
                  : g.key === 'reparked'
                    ? 'refresh'
                    : 'check-circle'
            }
            tone={g.tone}
            hint={counts[g.key] > 0 ? t('status.showOnly') : undefined}
            onClick={counts[g.key] > 0 ? () => setGroup(g.key) : undefined}
          />
        ))}
      </StatRow>

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
      ) : counts.all === 0 ? (
        <EmptyState
          icon="car"
          title={t('status.noneToday')}
          description={t('status.noneTodayBody')}
        />
      ) : (
        <>
          {/* NO BREAKDOWN BAR HERE. Removed on request.
              GROUPS survives and must: it still drives the filter pills below,
              which is the reason it was defined once rather than twice. The
              same counts are also still on the StatRow above, so nothing that
              was being shown is now unavailable — only the bar chart of it. */}

          {/* ── the cars themselves ─────────────────────────────────── */}
          <div className="mb-4 space-y-3">
            <SearchInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery('')}
              placeholder={t('status.searchPlaceholder')}
              inputMode="search"
            />

            <div className="flex gap-2 overflow-x-auto pb-1">
              <Pill active={group === 'all'} count={counts.all} onClick={() => setGroup('all')}>
                {t('status.all')}
              </Pill>
              {GROUPS.map((g) => (
                <Pill
                  key={g.key}
                  active={group === g.key}
                  count={counts[g.key] ?? 0}
                  onClick={() => setGroup(g.key)}
                >
                  {t(g.labelKey)}
                </Pill>
              ))}
            </div>
          </div>

          {truncated && (
            <p className="mb-3 flex items-start gap-2 rounded-lg bg-info-soft px-3.5 py-2.5 text-xs leading-relaxed text-info">
              <Icon name="info" size={14} className="mt-0.5 shrink-0" />
              <span>
                {t('status.showingRecent', { shown: cars.length, total })}
              </span>
            </p>
          )}

          <SectionHeading
            title={t(term || group !== 'all' ? 'status.matching' : 'status.recent')}
            count={visible.length}
            icon="list"
          />

          {visible.length === 0 ? (
            <EmptyState
              compact
              icon="search"
              title={t('status.nothingMatches')}
              description={t('status.nothingMatchesBody')}
            />
          ) : (
            <div className="space-y-2.5">
              {visible.map((car) => (
                <CarRow key={car.id} car={car} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════

function Pill({ active, count, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? 'flex shrink-0 items-center gap-2 rounded-full bg-brand px-3.5 py-2 text-sm font-semibold text-ink-inverse'
          : 'flex shrink-0 items-center gap-2 rounded-full border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-sunken'
      }
    >
      {children}
      <span
        className={
          active
            ? 'tnum rounded-full bg-white/20 px-1.5 py-0.5 text-xs font-bold leading-none'
            : 'tnum rounded-full bg-brand-soft px-1.5 py-0.5 text-xs font-bold leading-none text-ink-muted'
        }
      >
        {count}
      </span>
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════════

function CarRow({ car }) {
  const t = useT()

  return (
    <Card padded={false} className="p-3.5 sm:p-4" accent={car.car_tier === 'VIP' ? 'vip' : undefined}>
      <div className="flex items-start gap-3.5">
        {/* The token is the only thing a guest can quote, so it is the largest
            thing on the row and carries its own label. */}
        <span className="flex shrink-0 flex-col items-center rounded-xl bg-brand-soft px-2.5 py-1.5">
          <span className="text-[0.5625rem] font-bold uppercase leading-none tracking-wider text-ink-subtle">
            {t('common.token')}
          </span>
          <span className="tnum mt-0.5 text-2xl font-bold leading-none tracking-tight text-ink">
            {car.token_number}
          </span>
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* Car icon, because a four-digit plate next to a four-digit token
                is otherwise two identical-looking numbers. */}
            <span className="inline-flex items-center gap-1.5 font-semibold tracking-wide text-ink">
              <Icon name="car" size={15} className="text-ink-subtle" />
              {car.car_number ? prettyCarNumber(car.car_number) : '—'}
            </span>
            <TierBadge tier={car.car_tier} size="sm" />
            <VehicleStatusBadge status={car.status} size="sm" />
            {/* Only when there IS one, unlike the Records table.
                A table has a column that must hold something, so a blank cell
                reads as missing data and gets a dash. A card has no column —
                most guests never rate, and a "—" on nine cards out of ten is
                noise pretending to be information. */}
            {car.rating && <RatingBadge rating={car.rating} size="sm" />}
          </div>

          {/* The complaint, in full, on its own line. This is the screen the
              valet admin has open during the shift — the one person who can
              still do something about it today. Not truncated for that reason:
              a half-read complaint is worse than none. */}
          {car.review_comment && (
            <p className="mt-1.5 rounded-md bg-surface-sunken px-2.5 py-1.5 text-xs italic leading-snug text-ink-muted">
              &ldquo;{car.review_comment}&rdquo;
            </p>
          )}

          <p className="mt-1 truncate text-sm text-ink-muted">
            {personName(car.guest_name, car.guest_name_hi) || t('common.guest')}
            <span className="text-ink-subtle">{t('status.inAt', { time: formatTime(car.parked_at) })}</span>
            <span className="text-ink-subtle"> · {timeAgo(car.parked_at)}</span>
          </p>

          {/* A real tel: link. An admin chasing a car that is blocking the porch
              needs to call this guest now, and reading ten digits off one screen
              to type into another is where the mistake happens. */}
          {car.guest_phone && (
            <a
              href={`tel:+91${car.guest_phone}`}
              className="tnum mt-1 inline-flex items-center gap-1 text-sm font-medium text-info hover:underline"
            >
              <Icon name="phone" size={13} />
              +91 {formatPhone(car.guest_phone)}
            </a>
          )}

          {car.parking_location && (
            <p className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-ink-muted">
              <Icon name="location" size={14} className="text-ink-subtle" />
              {car.parking_location}
            </p>
          )}

          {car.notes && (
            <p className="mt-1 truncate text-xs text-ink-subtle" title={car.notes}>
              {car.notes}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
