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
// For the ?role= links on the two staff tiles. The constant, not the string, so
// a rename of a role value cannot leave a link pointing at nothing.
import { ROLES } from '@/types'

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

  async function save({ id, name, address, phone }) {
    const payload = {
      name: name.trim(),
      address: address.trim() || null,
      phone: phone.trim() || null,
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

      {/* Every tile goes to the screen that answers it, and the two that lead to
          a list carry the filter with them — "5 operators" landing on an
          unfiltered staff page makes the reader redo the counting the tile
          already did. */}
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
            count={properties.length}
            icon="building"
            id="sites-list"
            className="scroll-mt-24"
          />
          <div className="space-y-2.5">
            {properties.map((property) => (
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
  const [error, setError] = useState(null)
  const [nameError, setNameError] = useState(null)

  useEffect(() => {
    if (!open) return
    setName(target?.name ?? '')
    setAddress(target?.address ?? '')
    setPhone(target?.phone ?? '')
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

    const failure = await onSave({ id: target?.id, name, address, phone })
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
      </div>
    </Modal>
  )
}
