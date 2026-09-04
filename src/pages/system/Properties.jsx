/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/system/Properties.jsx                               │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The four sites. Add one, correct its details, or take one out of  │
 * │   service. system_admin only — the RLS policy on `properties`        │
 * │   allows writes to nobody else.                                      │
 * │                                                                     │
 * │ A PROPERTY IS NEVER DELETED                                          │
 * │   is_active = false, always. Every parked_vehicles row, every task   │
 * │   and every review points at a property; deleting one would either   │
 * │   be refused by the foreign keys or orphan months of history that    │
 * │   is the record of cars real people handed over. There is also no    │
 * │   DELETE grant on any table in this project, by design.              │
 * │                                                                     │
 * │ WHAT DEACTIVATING ACTUALLY DOES — and what it does not               │
 * │   It stops reset_daily_tokens() creating a token range each night,   │
 * │   so check-in there fails the next day. It does NOT sign anybody     │
 * │   out, and it does NOT stop staff already at that property from      │
 * │   working today, because my_property_id() does not consult           │
 * │   properties.is_active.                                              │
 * │                                                                     │
 * │   So the confirmation says exactly that rather than implying a       │
 * │   clean shutdown. Staff have to be deactivated separately, in Users. │
 * │                                                                     │
 * │ WHY THE NAME MATTERS MORE THAN IT LOOKS                              │
 * │   It is unique (migration 0002) and it is the only thing             │
 * │   distinguishing one dashboard from another. Two properties called   │
 * │   "Ambria Restro" and nobody can tell whose numbers they are         │
 * │   reading, so the database refuses it and this screen says why.      │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase, components/ui/*, utils/format, types                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/AppShell'
import Button from '@/components/ui/Button'
import Card, { SectionHeading } from '@/components/ui/Card'
import EmptyState from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Field'
import Icon from '@/components/ui/Icon'
import Modal, { ConfirmModal } from '@/components/ui/Modal'
import {
  HeaderSkeleton,
  RowsSkeleton,
  SectionHeadingSkeleton,
  StatRowSkeleton,
} from '@/components/ui/PageSkeleton'
import StatTile, { StatRow } from '@/components/ui/StatTile'
import Badge from '@/components/ui/Badge'
import { useToast } from '@/context/ToastContext'
import { useT } from '@/i18n'
import { supabase, describeDbError } from '@/supabase'
import { cn } from '@/utils/cn'
import { formatPhone, initials, istToday, personName, prettyCarNumber } from '@/utils/format'
// For the ?role= links on the two staff tiles. The constant, not the string, so
// a rename of a role value cannot leave a link pointing at nothing.
import { ROLES, VEHICLE_STATUS_META } from '@/types'

/**
 * Scrolls the site list into view when the "Open sites" tile is tapped.
 *
 * `block: 'start'` and not 'center': the top bar is sticky, so centring would
 * put the heading behind it. scroll-mt on the target covers the rest.
 *
 * Honours prefers-reduced-motion — a smooth jump down a page is exactly the
 * movement that makes some people motion-sick.
 */
function scrollToSites() {
  const el = document.getElementById('sites-list')
  if (!el) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

export default function Properties() {
  const t = useT()
  const toast = useToast()

  const [properties, setProperties] = useState([])
  /** property_id -> { cars_today, operators, admins }, from property_overview(). */
  const [stats, setStats] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [editTarget, setEditTarget] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [toggleTarget, setToggleTarget] = useState(null)

  /**
   * Which tab is open: 'all', or a property id.
   *
   * Not in the URL. Records keeps its property filter in state too, and a
   * system admin lands here from the nav rather than from a link that names a
   * site — so there is nothing yet for a shareable URL to be worth.
   */
  const [tab, setTab] = useState('all')

  /**
   * Which tile on a property tab has been opened: 'cars' | 'operators' |
   * 'admins', or null for none.
   *
   * ── WHY CLICK AND NOT HOVER ───────────────────────────────────────────
   * The obvious reading of "show the details on hover" does not survive
   * contact with the devices this runs on. A phone has no hover; a tooltip
   * that only appears on a pointer is invisible to every operator and to a
   * system admin checking a site from their phone. Worse, it is invisible in a
   * way nobody reports, because nothing looks broken.
   *
   * So the tile is a button and the detail opens below it. Hover still does
   * something — StatTile lifts its border — but that is an affordance saying
   * "this is clickable", not the feature itself.
   */
  const [detail, setDetail] = useState(null)
  const [detailRows, setDetailRows] = useState([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(null)

  const load = useCallback(async () => {
    // The counts come from an RPC, not from fetching rows and counting them.
    // This screen used to pull every one of today's vehicles across ALL
    // properties — 4000 rows on a busy event day — to produce four integers,
    // plus the whole user_roles table for two more. Postgres counts next to
    // the data and sends back four rows. See migration 0012.
    const [propRes, overviewRes] = await Promise.all([
      supabase
        .from('properties')
        .select('id, name, address, phone, is_active, created_at')
        .order('name'),
      supabase.rpc('property_overview'),
    ])

    if (propRes.error) {
      setError(describeDbError(propRes.error, t('props.couldNotLoad')))
      setLoading(false)
      return
    }

    setError(null)
    setProperties(propRes.data ?? [])

    const byId = {}
    for (const row of overviewRes.data ?? []) byId[row.property_id] = row
    setStats(byId)
    setLoading(false)
  }, [t])

  useEffect(() => {
    load()
  }, [load])

  // Switching tabs closes whatever was open. Leaving it open would refetch for
  // the new site, which looks like the panel simply changed its numbers — and
  // the reader has no reason to think they are now looking at a different site.
  useEffect(() => {
    setDetail(null)
  }, [tab])

  /**
   * Fetches the rows behind one tile, on demand.
   *
   * On demand, and not with the page: three lists for four sites is twelve
   * queries to render a screen whose whole job is four numbers, and almost
   * nobody opens any of them. The counts already came from one RPC.
   */
  useEffect(() => {
    if (!detail || tab === 'all') return undefined

    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)

    ;(async () => {
      const query =
        detail === 'cars'
          ? supabase
              .from('parked_vehicles')
              .select('id, token_number, car_number, guest_name, guest_phone, status, parking_location')
              .eq('property_id', tab)
              // The IST service day, not the browser's calendar date — a car
              // checked in at 01:00 belongs to the night before, and the whole
              // system agrees on that boundary. See utils/format.
              .eq('service_date', istToday())
              .order('token_number')
          : supabase
              .from('user_roles')
              .select('id, name, name_hi, phone, role, is_active')
              .eq('property_id', tab)
              .eq('role', detail === 'operators' ? ROLES.OPERATOR : ROLES.VALET_ADMIN)
              .order('name')

      const { data, error: err } = await query
      if (cancelled) return

      if (err) setDetailError(describeDbError(err, t('props.couldNotLoad')))
      else setDetailRows(data ?? [])
      setDetailLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [detail, tab, t])

  const totals = useMemo(() => {
    const rows = Object.values(stats)
    const sum = (key) => rows.reduce((acc, row) => acc + Number(row[key] ?? 0), 0)

    return {
      active: properties.filter((p) => p.is_active).length,
      cars: sum('cars_today'),
      operators: sum('operators'),
      admins: sum('admins'),
    }
  }, [properties, stats])

  async function save({ id, name, address, phone, reviewLink }) {
    const payload = {
      name: name.trim(),
      address: address.trim() || null,
      phone: phone.trim() || null,
      // Trimmed to null, never ''. The CHECK constraint rejects a value that
      // is not a URL, and an empty string is not one.
      review_link: reviewLink?.trim() || null,
    }

    const { error: err } = id
      ? await supabase.from('properties').update(payload).eq('id', id)
      : await supabase.from('properties').insert({ ...payload, is_active: true })

    if (err) {
      // The unique index on name is the one that fires in practice.
      if (err.code === '23505' || (err.message ?? '').includes('duplicate key')) {
        return t('props.nameTaken')
      }
      return describeDbError(err, t('props.couldNotSave'))
    }

    toast.success(id ? `${payload.name} updated` : `${payload.name} added`)
    setEditTarget(null)
    setAddOpen(false)
    await load()
    return null
  }

  async function toggleActive() {
    const next = !toggleTarget.is_active
    const { error: err } = await supabase
      .from('properties')
      .update({ is_active: next })
      .eq('id', toggleTarget.id)

    if (err) {
      toast.error(describeDbError(err, t('props.couldNotChange')))
    } else {
      toast.success(`${toggleTarget.name} ${next ? 'reopened' : 'closed'}`)
      await load()
    }
    setToggleTarget(null)
  }

  if (loading) {
    return (
      <>
        <HeaderSkeleton />
        <StatRowSkeleton />
        <SectionHeadingSkeleton />
        <RowsSkeleton rows={4} height="h-[6.5rem]" />
      </>
    )
  }

  // DERIVED, not corrected with setTab during render — writing state while
  // rendering is how a render loop starts. A tab naming a property that has
  // since been deleted simply reads as 'all' until something else changes it,
  // rather than showing an empty list with no way to tell why.
  const activeTab = properties.some((p) => p.id === tab) ? tab : 'all'
  const visible =
    activeTab === 'all' ? properties : properties.filter((p) => p.id === activeTab)

  const targetStats = toggleTarget ? stats[toggleTarget.id] : null
  const staffAtTarget = targetStats
    ? Number(targetStats.operators ?? 0) + Number(targetStats.admins ?? 0)
    : 0

  return (
    <>
      <PageHeader
        title={t('props.title')}
        subtitle={t('props.subtitle')}
        actions={
          <Button icon="plus" size="md" onClick={() => setAddOpen(true)}>
            {t('props.add')}
          </Button>
        }
      />

      {properties.length > 0 && (
        <PropertyTabs properties={properties} value={activeTab} onChange={setTab} />
      )}

      {/* The tiles answer a different question depending on the tab: across the
          group, or about the one site being looked at. "Open sites: 4" inside a
          single property's tab would be answering a question nobody asked. */}
      {activeTab === 'all' ? (
        /* Every tile goes to the screen that answers it, and the two that lead
           to a list carry the filter with them — "5 operators" landing on an
           unfiltered staff page makes the reader redo the counting the tile
           already did. */
        <StatRow className="mb-5">
          <StatTile
            label={t('props.openSites')}
            value={totals.active}
            icon="building"
            hint={totals.active > 0 ? t('props.seeList') : undefined}
            onClick={totals.active > 0 ? () => scrollToSites() : undefined}
          />
          <StatTile
            label={t('props.carsToday')}
            value={totals.cars}
            icon="car"
            tone="info"
            to="/system/records?days=1"
            hint={t('props.openRecords')}
          />
          <StatTile
            label={t('props.operators')}
            value={totals.operators}
            icon="key"
            to={`/system/users?role=${ROLES.OPERATOR}`}
            hint={t('props.manageOperators')}
          />
          <StatTile
            label={t('props.valetAdmins')}
            value={totals.admins}
            icon="users"
            to={`/system/users?role=${ROLES.VALET_ADMIN}`}
            hint={t('props.manageAdmins')}
          />
        </StatRow>
      ) : (
        /* No `to` on these. The obvious destinations — records, staff — cannot
           yet be filtered to one property from a URL, so a link there would open
           a list covering all four and quietly contradict the number it was
           reached from. Instead each tile opens the rows behind its own number,
           in place, where the number's context is still on screen. */
        <>
          <StatRow className="mb-3">
            <StatTile
              label={t('props.carsToday')}
              value={Number(stats[activeTab]?.cars_today ?? 0)}
              icon="car"
              tone="info"
              hint={t(detail === 'cars' ? 'props.hideDetails' : 'props.seeDetails')}
              onClick={() => setDetail((d) => (d === 'cars' ? null : 'cars'))}
            />
            <StatTile
              label={t('props.operators')}
              value={Number(stats[activeTab]?.operators ?? 0)}
              icon="key"
              hint={t(detail === 'operators' ? 'props.hideDetails' : 'props.seeDetails')}
              onClick={() => setDetail((d) => (d === 'operators' ? null : 'operators'))}
            />
            <StatTile
              label={t('props.valetAdmins')}
              value={Number(stats[activeTab]?.admins ?? 0)}
              icon="users"
              hint={t(detail === 'admins' ? 'props.hideDetails' : 'props.seeDetails')}
              onClick={() => setDetail((d) => (d === 'admins' ? null : 'admins'))}
            />
          </StatRow>

          {detail && (
            <DetailPanel
              kind={detail}
              rows={detailRows}
              loading={detailLoading}
              error={detailError}
              onClose={() => setDetail(null)}
            />
          )}
        </>
      )}

      {error ? (
        <EmptyState
          variant="error"
          title={t('props.couldNotLoadTitle')}
          description={error}
          action={
            <Button variant="secondary" icon="refresh" onClick={load}>
              {t('common.tryAgain')}
            </Button>
          }
        />
      ) : properties.length === 0 ? (
        <EmptyState
          icon="building"
          title={t('props.noneYet')}
          description={t('props.noneYetBody')}
          action={
            <Button icon="plus" size="md" onClick={() => setAddOpen(true)}>
              {t('props.add')}
            </Button>
          }
        />
      ) : (
        <>
          <SectionHeading
            title={t('props.sites')}
            count={visible.length}
            icon="building"
            id="sites-list"
            className="scroll-mt-24"
          />
          <div className="space-y-2.5">
            {visible.map((property) => (
              <PropertyRow
                key={property.id}
                property={property}
                cars={Number(stats[property.id]?.cars_today ?? 0)}
                operators={Number(stats[property.id]?.operators ?? 0)}
                onEdit={() => setEditTarget(property)}
                onToggle={() => setToggleTarget(property)}
              />
            ))}
          </div>
        </>
      )}

      <PropertyModal
        open={addOpen || Boolean(editTarget)}
        target={editTarget}
        onClose={() => {
          setAddOpen(false)
          setEditTarget(null)
        }}
        onSave={save}
      />

      <ConfirmModal
        open={Boolean(toggleTarget)}
        onClose={() => setToggleTarget(null)}
        onConfirm={toggleActive}
        tone={toggleTarget?.is_active ? 'danger' : 'success'}
        title={t(toggleTarget?.is_active ? 'props.closeQ' : 'props.reopenQ', {
          name: toggleTarget?.name,
        })}
        description={
          toggleTarget?.is_active
            ? t(staffAtTarget === 1 ? 'props.closeBody' : 'props.closeBody_plural', {
                n: staffAtTarget,
              })
            : t('props.reopenBody')
        }
        confirmLabel={t(toggleTarget?.is_active ? 'props.closeSite' : 'props.reopen')}
      />
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════

/**
 * One tab per site, plus "All sites".
 *
 * ── WHY IT WRAPS RATHER THAN SCROLLS ──────────────────────────────────
 * It used to scroll sideways, reasoning that a second line pushes the numbers
 * below the fold on a phone. That was the wrong trade, on request and on
 * reflection: a tab off the right-hand edge is INVISIBLE. Nothing on screen
 * says Manaktala has a tab at all, so a site can go unlooked-at for weeks
 * because nobody knew to swipe. A second line costs forty pixels once; a hidden
 * tab costs the site.
 *
 * Squeezing is still refused — `shrink-0` stays — because the name is the one
 * thing that tells sites apart and a truncated one tells nobody anything.
 *
 * ── AND WHY THE NAMES ARE TRIMMED ─────────────────────────────────────
 * See trimHouseWord. "Ambria" on five tabs distinguishes none of them and takes
 * half the width of each; it comes off, with guards that give the full names
 * back rather than ever labelling two sites the same.
 *
 * ── WHY IT IS A TABLIST AND NOT FOUR BUTTONS ──────────────────────────
 * role="tab" with aria-selected is what tells a screen reader that these
 * choose between views of the same thing rather than performing four separate
 * actions. Arrow-key movement between tabs comes free from that in most
 * readers; plain buttons announce as an unrelated list.
 */
/**
 * Site names with the house word taken off the front.
 *
 * "Ambria" appears on nearly every site, so it distinguishes nothing while
 * taking about half of each tab. Dropping it is what gets six tabs onto one or
 * two rows instead of three.
 *
 * ── WHY NOT "THE PREFIX THEY ALL SHARE" ───────────────────────────────
 * That was the first version and it was too strict to be useful: one site
 * called "test" was enough to make nothing shared, so every tab kept the word
 * and the row went back to three lines. The common case is four Ambria sites
 * and one oddity, and that is exactly the case it refused to help with.
 *
 * So the word is trimmed from the names that HAVE it and the others are left
 * alone — "test" stays "test".
 *
 * ── THE TWO GUARDS THAT MAKE IT SAFE ──────────────────────────────────
 * UNIQUENESS. If "Ambria Restro" and "Restro" both existed, trimming would
 * label two different sites "Restro" and clicking either would look like a bug
 * in the filter. Checked after trimming, and the whole thing is abandoned if it
 * collapses two names into one.
 *
 * NON-EMPTY, as belt and braces. A site called exactly "Ambria" is already
 * safe by construction — a one-word name is never counted towards the house
 * word and never matches "Ambria " with its trailing space, so it keeps its
 * name while the others trim. The guard is there for the next edit, not for a
 * case that reaches it today.
 *
 * Either way the fallback is the full names, which are never wrong — only long.
 * The complete name also stays on each tab's title attribute.
 */
function trimHouseWord(names) {
  if (names.length < 2) return names

  // The first word that starts more than one name. Counting rather than taking
  // names[0]'s word means the odd site out cannot decide it for everybody.
  const counts = new Map()
  for (const n of names) {
    const [word, ...rest] = n.split(' ')
    if (word && rest.length) counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  let house = ''
  let best = 1
  for (const [word, count] of counts) {
    if (count > best) {
      house = word
      best = count
    }
  }
  if (!house) return names

  const trimmed = names.map((n) => (n.startsWith(`${house} `) ? n.slice(house.length + 1) : n))
  if (trimmed.some((n) => !n.trim())) return names
  if (new Set(trimmed).size !== new Set(names).size) return names
  return trimmed
}

function PropertyTabs({ properties, value, onChange }) {
  const t = useT()

  const labels = trimHouseWord(properties.map((p) => p.name ?? ''))

  const tabs = [
    { id: 'all', label: t('props.allSites') },
    ...properties.map((p, i) => ({
      id: p.id,
      label: labels[i],
      // The full name, so the trim never hides which site this is from
      // somebody who wants to check.
      title: p.name,
      closed: !p.is_active,
    })),
  ]

  return (
    <div
      role="tablist"
      aria-label={t('props.sites')}
      className="mb-4 flex flex-wrap gap-2"
    >
      {tabs.map((tab) => {
        const active = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            title={tab.title}
            className={cn(
              // shrink-0 still: without it flex shaves every tab until the
              // names are unreadable, which is the one outcome worse than a
              // second line.
              'shrink-0 rounded-xl border px-3 py-1.5 text-sm font-semibold transition-colors',
              active
                // White on the violet, NOT gold. Gold on this violet measures
                // 1.91:1 — below even the 3:1 WCAG allows for large text — and
                // it was legible in the mock only because the pill used to be
                // near-black. White on the brand is 5.70:1.
                ? 'border-brand bg-brand text-ink-inverse'
                : 'border-line-strong bg-surface text-ink-muted hover:border-line-strong hover:text-ink',
            )}
          >
            {tab.label}
            {/* A closed site still gets a tab — it has history worth reading —
                but it has to say so, or its zeroes read as a quiet day. */}
            {tab.closed && (
              <span className={cn('ml-1.5 text-xs font-medium', active ? 'opacity-75' : 'text-ink-subtle')}>
                {t('props.closedTag')}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The rows behind one tile's number.
 *
 * Deliberately plain: this answers "who are those two operators" and "which car
 * is the one car today", and then gets out of the way. It is not a second
 * staff-management screen — editing still happens in Users, where the delete
 * and deactivate guards live.
 */
function DetailPanel({ kind, rows, loading, error, onClose }) {
  const t = useT()

  return (
    <Card className="mb-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <SectionHeading
          title={t(
            kind === 'cars'
              ? 'props.carsToday'
              : kind === 'operators'
                ? 'props.operators'
                : 'props.valetAdmins',
          )}
          count={loading ? undefined : rows.length}
          icon={kind === 'cars' ? 'car' : kind === 'operators' ? 'key' : 'users'}
          className="mb-0"
        />
        <Button variant="ghost" size="sm" icon="x" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>

      {loading ? (
        <p className="py-3 text-sm text-ink-subtle">{t('common.loading')}</p>
      ) : error ? (
        <p className="py-3 text-sm text-danger">{error}</p>
      ) : rows.length === 0 ? (
        <p className="py-3 text-sm text-ink-subtle">
          {t(kind === 'cars' ? 'props.noCarsToday' : 'props.noStaffHere')}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) =>
            kind === 'cars' ? (
              <li key={row.id} className="flex items-center gap-3 py-2.5">
                <span className="tnum w-12 shrink-0 text-lg font-bold text-ink">
                  {row.token_number}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {prettyCarNumber(row.car_number)}
                  </span>
                  <span className="block truncate text-xs text-ink-subtle">
                    {[row.guest_name, row.parking_location].filter(Boolean).join(' · ') ||
                      t('common.notRecorded')}
                  </span>
                </span>
                <Badge tone={VEHICLE_STATUS_META[row.status]?.tone ?? 'neutral'}>
                  {t(`vehicle.${row.status}`)}
                </Badge>
              </li>
            ) : (
              <li key={row.id} className="flex items-center gap-3 py-2.5">
                {/* Initials, so a list of six names can be told apart at a
                    glance rather than read word by word. */}
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-accent">
                  {initials(personName(row.name, row.name_hi))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {personName(row.name, row.name_hi)}
                  </span>
                  <span className="block truncate text-xs text-ink-subtle">
                    {formatPhone(row.phone)}
                  </span>
                </span>
                {/* Only the exception is labelled. Tagging every active person
                    "Active" is five badges saying nothing and one saying
                    something, which is how the one gets missed. */}
                {!row.is_active && <Badge tone="danger">{t('staff.inactive')}</Badge>}
                {/* A real tel: link, not a button that copies the number. The
                    reason a system admin opens this list is usually to ring
                    whoever is on shift. */}
                {row.phone && (
                  <a
                    href={`tel:${row.phone}`}
                    aria-label={t('props.callNamed', { name: personName(row.name, row.name_hi) })}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line-strong text-ink-subtle transition-colors hover:border-accent hover:text-accent"
                  >
                    <Icon name="phone" size={16} />
                  </a>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </Card>
  )
}

function PropertyRow({ property, cars, operators, onEdit, onToggle }) {
  const t = useT()

  return (
    <Card padded={false} className={property.is_active ? 'p-4' : 'p-4 opacity-60'}>
      <div className="flex items-start gap-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-ink-muted">
          <Icon name="building" size={20} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{property.name}</span>
            {!property.is_active && (
              <Badge tone="warning" size="sm">
                {t('props.closed')}
              </Badge>
            )}
          </div>

          <p className="mt-0.5 truncate text-sm text-ink-subtle">
            {property.address || t('props.noAddress')}
            {property.phone && <span className="tnum"> · {property.phone}</span>}
          </p>

          <p className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
            <span className="inline-flex items-center gap-1">
              <Icon name="car" size={13} />
              <span className="tnum font-semibold">{cars}</span> {t('props.todaySuffix')}
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="key" size={13} />
              <span className="tnum font-semibold">{operators}</span>{' '}
              {t(operators === 1 ? 'props.operatorCount' : 'props.operatorCount_plural')}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-md"
            icon="edit"
            onClick={onEdit}
            aria-label={t('props.editNamed', { name: property.name })}
            title={t('props.editDetails')}
          />
          <Button
            variant="ghost"
            size="icon-md"
            icon={property.is_active ? 'x-circle' : 'check-circle'}
            onClick={onToggle}
            aria-label={t(property.is_active ? 'props.closeNamed' : 'props.reopenNamed', {
              name: property.name,
            })}
            title={t(property.is_active ? 'props.closeThis' : 'props.reopenThis')}
            className={
              property.is_active
                ? 'hover:bg-danger-soft hover:text-danger'
                : 'hover:bg-success-soft hover:text-success'
            }
          />
        </div>
      </div>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════

function PropertyModal({ open, target, onClose, onSave }) {
  const t = useT()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [phone, setPhone] = useState('')
  const [reviewLink, setReviewLink] = useState('')
  const [error, setError] = useState(null)
  const [nameError, setNameError] = useState(null)

  useEffect(() => {
    if (!open) return
    setName(target?.name ?? '')
    setAddress(target?.address ?? '')
    setPhone(target?.phone ?? '')
    setReviewLink(target?.review_link ?? '')
    setError(null)
    setNameError(null)
  }, [open, target])

  if (!open) return null

  const submit = async () => {
    if (name.trim().length < 3) {
      setNameError(t('props.enterName'))
      return
    }
    setNameError(null)
    setError(null)

    const failure = await onSave({ id: target?.id, name, address, phone, reviewLink })
    if (failure) {
      // A duplicate name is a problem with the name field, not the form.
      if (failure.toLowerCase().includes('name')) setNameError(failure)
      else setError(failure)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={target ? t('props.editTitle', { name: target.name }) : t('props.add')}
      size="md"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="md" onClick={submit} loadingText={t('common.saving')}>
            {t('common.save')}
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

        <Input
          label={t('props.name')}
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (nameError) setNameError(null)
          }}
          error={nameError}
          hint={!nameError ? t('props.nameHint') : undefined}
          autoCapitalize="words"
          placeholder={t('props.namePlaceholder')}
        />

        <Input
          label={t('props.address')}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={t('props.addressPlaceholder')}
        />

        <Input
          label={t('props.landline')}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t('props.landlinePlaceholder')}
          // Not normalisePhone: this is the site's own landline, printed on
          // signage. Staff and guest numbers are 10-digit mobiles; this is not
          // one and must not be forced into that shape.
          hint={t('props.landlineHint')}
        />

        <Input
          label={t('props.reviewLink')}
          value={reviewLink}
          onChange={(e) => setReviewLink(e.target.value)}
          placeholder="https://g.page/r/..."
          type="url"
          inputMode="url"
          // Per property, not one for the group: this is where a guest who
          // rated Excellent is sent to post it publicly, and each venue has its
          // own listing. Left empty, that guest is simply thanked — the message
          // never offers a link it does not have.
          hint={t('props.reviewLinkHint')}
        />
      </div>
    </Modal>
  )
}
