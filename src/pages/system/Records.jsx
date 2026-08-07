/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/system/Records.jsx                                  │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Every car ever checked in, across every property, searchable and   │
 * │   exportable as a spreadsheet. The record of who handed over which   │
 * │   car and when.                                                     │
 * │                                                                     │
 * │ NOTHING NEW IS STORED FOR THIS                                       │
 * │   parked_vehicles has held the name, number, car, tier, location and │
 * │   notes since migration 0001. This page adds the query, not the      │
 * │   data — see vehicle_records() in migration 0017.                     │
 * │                                                                     │
 * │ WHY THE FULL PHONE NUMBER, WHEN Reviews MASKS IT                      │
 * │   Opposite purposes. Judging service quality needs no way to contact │
 * │   anybody, so Reviews masks. This IS the contact record, so masking  │
 * │   it would make the export useless for the thing it exists for. The  │
 * │   operator already sees it in full on Today's Cars.                   │
 * │                                                                     │
 * │ ── THE EXPORT IS BOUNDED, AND SAYS SO ────────────────────────────────│
 * │   Four properties at a thousand cars a day is ~120,000 rows a month.  │
 * │   A silently truncated CSV is the worst possible outcome here: it     │
 * │   opens, it looks complete, and the rows that are missing are         │
 * │   invisible. So the export has a hard cap, and when a range exceeds   │
 * │   it the page refuses and says to narrow the dates instead of         │
 * │   handing over a file that lies.                                     │
 * │                                                                     │
 * │ WHY PAGING ORDERS ON TWO COLUMNS                                      │
 * │   service_date DESC, token DESC. On date alone, rows with the same    │
 * │   date could come back in a different order per page, which silently  │
 * │   duplicates some and skips others. The tie-break is in the RPC.      │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase, components/ui/*, utils/format                         │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/AppShell'
import Button from '@/components/ui/Button'
import Card, { SectionHeading } from '@/components/ui/Card'
import EmptyState from '@/components/ui/EmptyState'
import { SearchInput } from '@/components/ui/Field'
import Icon from '@/components/ui/Icon'
import {
  HeaderSkeleton,
  PillsSkeleton,
  RowsSkeleton,
  SectionHeadingSkeleton,
} from '@/components/ui/PageSkeleton'
import { TierBadge, VehicleStatusBadge } from '@/components/ui/Badge'
import { useToast } from '@/context/ToastContext'
import { useT } from '@/i18n'
import { supabase, describeDbError } from '@/supabase'
import {
  downloadCsv,
  formatDate,
  formatPhone,
  istDaysAgo,
  istToday,
  personName,
  prettyCarNumber,
} from '@/utils/format'

const PAGE = 100

/**
 * Hard ceiling on one export.
 *
 * Not a performance number — a truth one. Beyond this the page refuses rather
 * than producing a CSV that opens cleanly and is quietly missing rows.
 */
const EXPORT_MAX = 5000

// labelKey, not label: module scope runs once, before a language is chosen.
const RANGES = [
  { days: 1, labelKey: 'range.today' },
  { days: 7, labelKey: 'range.7d' },
  { days: 30, labelKey: 'range.30d' },
  { days: 90, labelKey: 'records.90d' },
  { days: 365, labelKey: 'records.1y' },
]

export default function Records() {
  const t = useT()
  const toast = useToast()

  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [properties, setProperties] = useState([])

  // Seeded from ?days= so "Cars today" elsewhere lands on today rather than on
  // a 30-day list the reader then has to narrow themselves.
  const [params] = useSearchParams()
  const [days, setDays] = useState(() => {
    const wanted = Number(params.get('days'))
    return RANGES.some((r) => r.days === wanted) ? wanted : 30
  })
  const [propertyId, setPropertyId] = useState('all')
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const [page, setPage] = useState(0)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [exporting, setExporting] = useState(false)

  // Debounced, because searching is a round trip. At 300ms a typed car number
  // is one query instead of ten.
  useEffect(() => {
    const t = setTimeout(() => {
      setTerm(query.trim())
      setPage(0)
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  // Any filter change invalidates the page number. Without this, narrowing a
  // range while on page 4 shows an empty table that looks like "no records".
  useEffect(() => setPage(0), [days, propertyId])

  useEffect(() => {
    supabase
      .from('properties')
      .select('id, name')
      .order('name')
      .then(({ data }) => setProperties(data ?? []))
  }, [])

  const args = useMemo(
    () => ({
      p_from: istDaysAgo(days - 1),
      p_to: istToday(),
      p_property_id: propertyId === 'all' ? null : propertyId,
      p_query: term || null,
    }),
    [days, propertyId, term],
  )

  const load = useCallback(async () => {
    setLoading(true)

    const { data, error: err } = await supabase.rpc('vehicle_records', {
      ...args,
      p_limit: PAGE,
      p_offset: page * PAGE,
    })

    if (err) {
      setError(describeDbError(err, t('records.couldNotLoad')))
      setLoading(false)
      return
    }

    setError(null)
    setRows(data ?? [])
    // total_rows is repeated on every row — the count for the whole filter, not
    // this page, so the header can say "100 of 8,412" without a second query.
    setTotal(Number(data?.[0]?.total_rows ?? 0))
    setLoading(false)
  }, [args, page])

  useEffect(() => {
    load()
  }, [load])

  const pages = Math.max(1, Math.ceil(total / PAGE))

  async function exportCsv() {
    if (total > EXPORT_MAX) {
      toast.error(
        `${total.toLocaleString()} records is too many for one file. Narrow the dates or pick a property — the limit is ${EXPORT_MAX.toLocaleString()}.`,
      )
      return
    }

    setExporting(true)

    // Refetched at full size rather than exporting what is on screen. Exporting
    // the visible page would hand over 100 rows labelled as the whole period.
    const { data, error: err } = await supabase.rpc('vehicle_records', {
      ...args,
      p_limit: 1000,
      p_offset: 0,
    })

    // The RPC clamps p_limit to 1000, so anything larger has to be paged out.
    let all = data ?? []
    if (!err && total > 1000) {
      for (let offset = 1000; offset < Math.min(total, EXPORT_MAX); offset += 1000) {
        // Sequential on purpose: this is a rare admin action, and firing five
        // concurrent heavy queries at the database to save two seconds is not a
        // trade worth making on a shared instance.
        // eslint-disable-next-line no-await-in-loop
        const next = await supabase.rpc('vehicle_records', {
          ...args,
          p_limit: 1000,
          p_offset: offset,
        })
        if (next.error) break
        all = all.concat(next.data ?? [])
      }
    }

    setExporting(false)

    if (err || all.length === 0) {
      toast.error(
        err ? describeDbError(err, t('records.couldNotExport')) : t('records.nothingToExport'),
      )
      return
    }

    // FOUR COLUMNS — name, number, tier, and who parked it.
    //
    // The table on screen shows more because that is what you search and verify
    // against; the file is for taking away and stays deliberately narrow. Adding
    // "just one more" column is how an export becomes a database dump nobody can
    // open — so "Parked by" is here only because comparing operator workload is
    // the stated reason this column exists at all. Anything else stays out.
    downloadCsv(
      `valet-guests-${istToday()}.csv`,
      all.map((r) => ({
        Name: r.guest_name ?? '',
        // ="…" forces Excel to keep it as TEXT. Without it a 10-digit number is
        // read as a number, loses any leading zero, and renders as 9.87654E+09 —
        // which makes the column useless for the one thing it is for.
        Number: r.guest_phone ? `="${r.guest_phone}"` : '',
        'Car tier': r.car_tier ?? '',
        // English, like the Operator column in the Reviews export: the file is
        // for payroll and comparison, and one stable spelling per person beats
        // matching whichever language the exporter had selected.
        'Parked by': r.parked_by ?? '',
      })),
    )

    toast.success(t('records.exported', { n: all.length.toLocaleString() }))
  }

  if (loading && rows.length === 0 && !error) {
    return (
      <>
        <HeaderSkeleton />
        <PillsSkeleton />
        <SectionHeadingSkeleton />
        <RowsSkeleton rows={6} height="h-12" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('records.title')}
        subtitle={t('records.subtitle')}
        actions={
          <>
            <Button variant="secondary" size="md" icon="refresh" onClick={load}>
              {t('common.refresh')}
            </Button>
            <Button
              variant="primary"
              size="md"
              icon="download"
              onClick={exportCsv}
              loading={exporting}
              loadingText={t('records.preparing')}
              disabled={total === 0}
            >
              {t('records.excel')}
            </Button>
          </>
        }
      />

      {/* Filters in one row above what they change. */}
      <div className="mb-4 space-y-3">
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
          placeholder={t('records.searchPlaceholder')}
          inputMode="search"
        />

        <div className="flex flex-wrap gap-2">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              onClick={() => setDays(r.days)}
              aria-pressed={days === r.days}
              className={
                days === r.days
                  ? 'rounded-full bg-brand px-3.5 py-2 text-sm font-semibold text-ink-inverse'
                  : 'rounded-full border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-sunken'
              }
            >
              {t(r.labelKey)}
            </button>
          ))}

          <select
            value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}
            aria-label={t('records.filterProperty')}
            className="h-11 rounded-xl border border-line-strong bg-surface px-3 text-base font-medium text-ink outline-none focus:border-brand sm:text-sm"
          >
            <option value="all">{t('records.allProperties')}</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <SectionHeading
        title={t('records.title')}
        icon="list"
        action={
          <span className="tnum text-xs text-ink-subtle">
            {total === 0
              ? t('records.none')
              : t('records.showingRange', {
                  from: (page * PAGE + 1).toLocaleString(),
                  to: Math.min((page + 1) * PAGE, total).toLocaleString(),
                  total: total.toLocaleString(),
                })}
          </span>
        }
      />

      {error ? (
        <EmptyState
          variant="error"
          title={t('records.couldNotLoadTitle')}
          description={error}
          action={
            <Button variant="secondary" icon="refresh" onClick={load}>
              {t('common.tryAgain')}
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="search"
          title={t(term ? 'records.nothingMatches' : 'records.noneInPeriod')}
          description={t(term ? 'records.nothingMatchesBody' : 'records.noneInPeriodBody')}
        />
      ) : (
        <>
          <Card padded={false} className="overflow-x-auto">
            <table className="w-full min-w-[72rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-subtle">
                  <th scope="col" className="px-4 py-3 font-semibold">{t('records.colDate')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('records.colProperty')}</th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">{t('common.token')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('records.colGuest')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('records.colPhone')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('records.colCar')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('records.colParkedAt')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('records.colHandledBy')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('records.colStatus')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-3 text-ink-muted">
                      {formatDate(`${r.service_date}T12:00:00+05:30`)}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{r.property_name}</td>
                    <td className="tnum px-3 py-3 text-right font-bold text-ink">
                      {r.token_number}
                    </td>
                    <td className="px-4 py-3 font-medium text-ink">{r.guest_name || '—'}</td>
                    <td className="px-4 py-3">
                      {r.guest_phone ? (
                        <a
                          href={`tel:+91${r.guest_phone}`}
                          className="tnum text-info hover:underline"
                        >
                          {formatPhone(r.guest_phone)}
                        </a>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold tracking-wide text-ink">
                          {r.car_number ? prettyCarNumber(r.car_number) : '—'}
                        </span>
                        <TierBadge tier={r.car_tier} size="sm" />
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{r.parking_location || '—'}</td>
                    <td className="px-4 py-3">
                      {/* Two names, because they are usually different people and
                          "handled by" with one name would credit the wrong one. */}
                      {r.parked_by || r.fetched_by ? (
                        <span className="block text-xs leading-relaxed">
                          {r.parked_by && (
                            <span className="block text-ink-muted">
                              <span className="text-ink-subtle">{t('records.parkedByWord')}</span>{' '}
                              {personName(r.parked_by, r.parked_by_hi)}
                            </span>
                          )}
                          {r.fetched_by && (
                            <span className="block text-ink-muted">
                              <span className="text-ink-subtle">{t('records.fetchedByWord')}</span>{' '}
                              {personName(r.fetched_by, r.fetched_by_hi)}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <VehicleStatusBadge status={r.status} size="sm" />
                        {Number(r.no_shows) > 0 && (
                          <span className="tnum text-xs text-warning">
                            {t(
                              Number(r.no_shows) === 1
                                ? 'records.noShowCount'
                                : 'records.noShowCount_plural',
                              { n: r.no_shows },
                            )}
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {pages > 1 && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button
                variant="secondary"
                size="md"
                icon="arrow-left"
                disabled={page === 0 || loading}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                {t('records.previous')}
              </Button>

              <span className="tnum text-sm text-ink-subtle">
                {t('records.pageOf', { page: page + 1, total: pages.toLocaleString() })}
              </span>

              <Button
                variant="secondary"
                size="md"
                icon="arrow-right"
                iconRight
                disabled={page >= pages - 1 || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('records.next')}
              </Button>
            </div>
          )}

          {total > EXPORT_MAX && (
            <p className="mt-4 flex max-w-3xl items-start gap-2 rounded-lg bg-info-soft px-3.5 py-2.5 text-xs leading-relaxed text-info">
              <Icon name="info" size={14} className="mt-0.5 shrink-0" />
              <span>
                {t('records.exportCap', {
                  total: total.toLocaleString(),
                  max: EXPORT_MAX.toLocaleString(),
                })}
              </span>
            </p>
          )}
        </>
      )}
    </>
  )
}
