/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/operator/TodaysCars.jsx                             │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Every car checked in at this property today, and where each one    │
 * │   is in its journey. This is the screen an operator opens when a     │
 * │   guest walks up holding a stub and asks a question.                 │
 * │                                                                     │
 * │ IT IS ALSO THE ONLY WAY TO START A RETRIEVAL RIGHT NOW               │
 * │   The design has the guest tap "Get My Car" in WhatsApp. That is     │
 * │   not built yet, and plenty of guests will never use it — they walk  │
 * │   up to the porch and ask. So a parked car here has a "Request car"  │
 * │   button that raises the same pending retrieval the webhook will,    │
 * │   unassigned, for the admin queue to dispatch.                       │
 * │                                                                     │
 * │   Without it, nothing in this system can create a retrieval, and     │
 * │   the entire retrieval half of My Tasks is unreachable code.         │
 * │                                                                     │
 * │ SEARCH IS SERVER-SIDE, THE STATUS PILLS ARE NOT                      │
 * │   The list is a 200-row PAGE, not the whole day — one property can    │
 * │   now reach a thousand cars, and re-sending all of them to a phone    │
 * │   on every realtime event is not viable. So text matching happens in  │
 * │   Postgres (search_todays_cars, migration 0012) and reaches every    │
 * │   car, while the three status pills filter the page already in        │
 * │   memory. A round trip per pill tap would make the fastest            │
 * │   interaction on the screen the slowest.                             │
 * │                                                                     │
 * │ WHY THE STATUS FILTER IS "IN THE CAR PARK" vs "ACTIVE"               │
 * │   Not a filter per status. An operator is only ever asking one of    │
 * │   two questions: which cars are being worked on right now, and       │
 * │   which are sitting still. Nine filter chips would bury both. Each   │
 * │   pill carries its count, so the answer is often there without the   │
 * │   tap.                                                              │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   lib/valetApi, hooks/useRealtime, components/ui/*, utils/format,    │
 * │   types                                                             │
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
import { TierBadge, VehicleStatusBadge } from '@/components/ui/Badge'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { useToast } from '@/context/ToastContext'
import useRealtime from '@/hooks/useRealtime'
import { requestRetrieval } from '@/lib/valetApi'
import { supabase, describeDbError } from '@/supabase'
import { useParkingSpaces } from '@/components/ui/SpacePicker'
import { formatPhone, formatTime, istToday, personName, prettyCarNumber, storedPlaceName, timeAgo } from '@/utils/format'
import { VEHICLE_AT_REST, VEHICLE_STATUS } from '@/types'
import { cn } from '@/utils/cn'

const FILTERS = [
  // Declared at module scope, so the label is a translation KEY resolved at
  // render time rather than a string baked in at import time — otherwise the
  // pills would keep their first language after a switch.
  { key: 'all', labelKey: 'cars.filterAll' },
  { key: 'active', labelKey: 'cars.filterActive' },
  { key: 'parked', labelKey: 'cars.filterParked' },
]

/**
 * How many cars one page holds.
 *
 * Not a scrolling limit anyone will hit by hand — 200 rows is already far
 * more than an operator reads. It is a ceiling on what a phone downloads on
 * every realtime refetch during a peak, and search reaches everything beyond
 * it. The server clamps this to 500 regardless (migration 0012).
 */
const PAGE_SIZE = 200

export default function TodaysCars() {
  // Loaded only to READ a Hindi place name. parking_location is free text
  // copied at park time, so the stored English has to be matched back to a
  // place to find its label_hi — see utils/format storedPlaceName and
  // migration 0029. The same hook the pickers use, so one fetch either way.
  const { spaces } = useParkingSpaces()
  const t = useT()
  const { propertyId, propertyName } = useAuth()
  const toast = useToast()

  const [cars, setCars] = useState([])
  /** How many cars exist today, which may be more than `cars` holds. */
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')

  /**
   * Debounced copy of `query`, and the ONLY thing that triggers a fetch.
   *
   * Searching server-side means a keystroke could be a round trip. At 250ms
   * "DL8CAF1234" is one query instead of ten, and the operator cannot type
   * fast enough to notice the delay.
   */
  const [term, setTerm] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setTerm(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  /**
   * One page of today's cars, or the matches for a search.
   *
   * This used to fetch the whole day and filter in JavaScript. At forty cars
   * that is simpler and better. At a thousand — which one property can now
   * reach in a day — it is ~200kB to a phone on hotel wifi, re-sent on every
   * realtime refetch, to show a list nobody scrolls. search_todays_cars()
   * does the matching in Postgres and returns a page. See migration 0012.
   */
  const load = useCallback(async () => {
    if (!propertyId) return

    const { data, error: err } = await supabase.rpc('search_todays_cars', {
      p_query: term || null,
      p_limit: PAGE_SIZE,
    })

    if (err) {
      setError(describeDbError(err, t('cars.couldNotLoad')))
      setLoading(false)
      return
    }

    setError(null)
    setCars(data ?? [])
    // total_today is repeated on every row — the count of the whole day, not
    // of this page, so the list can say "200 of 964" without a second query.
    setTotal(Number(data?.[0]?.total_today ?? 0))
    setLoading(false)
  }, [propertyId, term, t])

  useEffect(() => {
    load()
  }, [load])

  useRealtime({
    channel: `todays-cars:${propertyId}`,
    table: 'parked_vehicles',
    filter: propertyId ? `property_id=eq.${propertyId}` : undefined,
    enabled: Boolean(propertyId),
    onRefetch: load,
  })

  /**
   * Only the STATUS pills are applied here. Text matching moved to the
   * server; doing it in both places would mean two definitions of "matches"
   * that drift, and the local one would silently win on whatever it had.
   *
   * The pills stay local on purpose: there are three of them, they are
   * applied to a page that is already in memory, and a round trip per tap
   * would make the fastest interaction on the screen the slowest.
   */
  const visible = useMemo(
    () =>
      cars.filter((car) => {
        if (filter === 'parked' && !VEHICLE_AT_REST.includes(car.status)) return false
        if (filter === 'active' && VEHICLE_AT_REST.includes(car.status)) return false
        if (filter === 'active' && car.status === VEHICLE_STATUS.DELIVERED) return false
        return true
      }),
    [cars, filter],
  )

  /** True when the day has more cars than this page holds. */
  const truncated = !term && total > cars.length

  /**
   * Count per filter, so a pill says how many it will show before it is tapped.
   *
   * Counted from the loaded page, not from `total` — a pill that promised 340
   * and then listed 200 would be worse than no number at all. The truncation
   * notice above the list is what covers the difference.
   */
  const counts = useMemo(() => {
    const atRest = cars.filter((c) => VEHICLE_AT_REST.includes(c.status)).length
    const working = cars.filter(
      (c) => !VEHICLE_AT_REST.includes(c.status) && c.status !== VEHICLE_STATUS.DELIVERED,
    ).length
    return { all: cars.length, parked: atRest, active: working }
  }, [cars])

  const requestCar = async (car) => {
    const result = await requestRetrieval(car.id)
    if (!result.ok) {
      toast.error(result.error)
      // Almost always means someone already requested it, or it moved.
      load()
      return
    }
    toast.success(t('cars.requested', { token: car.token_number }))
    load()
  }

  if (loading) {
    return (
      <>
        <HeaderSkeleton action={false} />
        <StatRowSkeleton />
        <FilterBarSkeleton />
        <SectionHeadingSkeleton />
        <RowsSkeleton rows={5} height="h-24" />
      </>
    )
  }

  const parkedCount = cars.filter((c) => VEHICLE_AT_REST.includes(c.status)).length

  return (
    <>
      <PageHeader
        title={t('cars.title')}
        subtitle={propertyName ? `${propertyName} · ${istToday()}` : undefined}
        actions={
          <Button variant="secondary" size="md" icon="refresh" onClick={load}>
            {t('common.refresh')}
          </Button>
        }
      />

      <div className="mb-4 space-y-3">
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
          placeholder={t('cars.searchPlaceholder')}
          inputMode="search"
        />

        <div className="flex gap-2 overflow-x-auto pb-1">
          {FILTERS.map((option) => {
            const active = filter === option.key
            const n = counts[option.key] ?? 0

            return (
              <button
                key={option.key}
                type="button"
                onClick={() => setFilter(option.key)}
                aria-pressed={active}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-full px-3.5 py-2 text-sm transition-colors',
                  active
                    ? 'bg-brand font-semibold text-ink-inverse'
                    : 'border border-line-strong bg-surface font-medium text-ink-muted hover:bg-surface-sunken',
                )}
              >
                {t(option.labelKey)}
                {/* The count is what makes a pill worth tapping — "In the car
                    park 8" answers the question without the tap. */}
                <span
                  className={cn(
                    'tnum rounded-full px-1.5 py-0.5 text-xs font-bold leading-none',
                    active ? 'bg-white/20 text-ink-inverse' : 'bg-brand-soft text-ink-muted',
                  )}
                >
                  {n}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Says so when the list is a page rather than the day. Silently showing
          200 of 964 and calling it "All cars" is how an operator concludes a
          car was never checked in. */}
      {truncated && (
        <p className="mb-3 flex items-start gap-2 rounded-lg bg-info-soft px-3.5 py-2.5 text-xs leading-relaxed text-info">
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          <span>
            {t('cars.showingRecent', { shown: cars.length, total })}
          </span>
        </p>
      )}

      <SectionHeading
        title={t(term || filter !== 'all' ? 'cars.matching' : 'cars.recent')}
        count={visible.length}
        icon="car"
        action={
          <span className="text-xs text-ink-subtle">
            {/* `total`, not cars.length — cars is a page, and reporting the
                page size as the day's total would under-report the count on
                exactly the busy days when it matters. */}
            {t('cars.summary', { parked: parkedCount, total })}
          </span>
        }
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
      ) : cars.length === 0 ? (
        <EmptyState
          icon="car"
          title={t('cars.noneToday')}
          description={t('cars.noneTodayBody')}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="search"
          title={t('cars.nothingMatches')}
          description={t('cars.nothingMatchesBody')}
          action={
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setQuery('')
                setFilter('all')
              }}
            >
              {t('cars.clearSearch')}
            </Button>
          }
        />
      ) : (
        <div className="space-y-2.5">
          {visible.map((car) => (
            <CarRow
              key={car.id}
              car={car}
              spaces={spaces}
              onRequest={() => requestCar(car)}
            />
          ))}
        </div>
      )}
    </>
  )
}

function CarRow({ car, spaces, onRequest }) {
  const t = useT()
  const atRest = VEHICLE_AT_REST.includes(car.status)

  return (
    <Card
      padded={false}
      className="p-3.5 sm:p-4"
      accent={car.car_tier === 'VIP' ? 'vip' : undefined}
    >
      <div className="flex items-start gap-3.5">
        {/* The token is the only thing the guest can quote, so it is the
            largest thing on the row and carries its own label — an unlabelled
            number in a box is guessed at, not read. */}
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
            {/* Icon, not a bare number — a four-digit plate next to a
                four-digit token is otherwise two identical-looking numbers. */}
            <span className="inline-flex items-center gap-1.5 font-semibold tracking-wide text-ink">
              <Icon name="car" size={15} className="text-ink-subtle" />
              {prettyCarNumber(car.car_number)}
            </span>
            <TierBadge tier={car.car_tier} size="sm" />
            {/* Status sits on the right on a wide row — see the note there. It
                stays here on a phone, where there is no right to move it to. */}
            <span className="sm:hidden">
              <VehicleStatusBadge status={car.status} size="sm" />
            </span>
          </div>

          <p className="mt-1 truncate text-sm text-ink-muted">
            {personName(car.guest_name, car.guest_name_hi) || t('common.guest')}
            <span className="text-ink-subtle"> · {formatTime(car.parked_at)}</span>
            <span className="text-ink-subtle"> · {timeAgo(car.parked_at)}</span>
          </p>

          {/* ── phone and place, on ONE row with a real gap ───────────────
              These were two separate elements each carrying `inline-flex`,
              which makes a <p> inline — so the place ran straight on from the
              last digit of the number with nothing between them:
              "+91 97978 76646⊙back side". A flex row with a column gap is what
              that markup was reaching for. */}
          {(car.guest_phone || car.parking_location) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
              {/* A real tel: link, not text. When a car is blocking the porch
                  the operator needs to call this guest NOW, and reading ten
                  digits off one screen to type into another is where the
                  mistake happens. */}
              {car.guest_phone && (
                <a
                  href={`tel:+91${car.guest_phone}`}
                  onClick={(e) => e.stopPropagation()}
                  // Not text-info. Blue was the one cool colour left on a screen
                  // whose chrome is black and gold, and it read as a stray link
                  // pasted in from somewhere else.
                  className="tnum inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted transition-colors hover:text-accent"
                >
                  <Icon name="phone" size={13} className="text-ink-subtle" />
                  +91 {formatPhone(car.guest_phone)}
                </a>
              )}

              {car.parking_location && (
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink">
                  <Icon name="location" size={14} className="text-ink-subtle" />
                  {storedPlaceName(car.parking_location, spaces)}
                </span>
              )}
            </div>
          )}

          {car.notes && (
            <p className="mt-1.5 truncate text-xs text-ink-subtle" title={car.notes}>
              {car.notes}
            </p>
          )}
        </div>

        {/* ── the right-hand column ────────────────────────────────────
            On a laptop this row is over 1500px wide and every word of it was
            packed into the left third, leaving two thirds of empty card. The
            status is what an operator scans a list FOR, so it goes to the
            right edge where the eye can run straight down it, and the request
            button comes with it instead of being a full-width bar underneath.

            sm and up only. On a phone there is no room for a second column and
            both stay where they were. */}
        <div className="hidden shrink-0 flex-col items-end gap-2.5 sm:flex">
          <VehicleStatusBadge status={car.status} size="sm" />
          {atRest && (
            <Button variant="secondary" size="sm" icon="bell" onClick={onRequest}>
              {t('cars.requestCar')}
            </Button>
          )}
        </div>
      </div>

      {/* Phone only — sm and up gets this button in the right-hand column
          above. Full width here because a thumb reaching across a phone wants
          the whole row, not a small target in a corner. */}
      {atRest && (
        <Button
          variant="secondary"
          size="md"
          fullWidth
          icon="bell"
          className="mt-3 sm:hidden"
          onClick={onRequest}
        >
          {t('cars.requestCar')}
        </Button>
      )}
    </Card>
  )
}
