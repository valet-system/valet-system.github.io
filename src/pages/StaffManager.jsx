/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/StaffManager.jsx                                    │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The staff management screen. Add a valet, deactivate someone who    │
 * │   left, and fix a name, a number or a PIN.                            │
 * │                                                                     │
 * │   ONE component serves TWO routes:                                   │
 * │     /system/users  system_admin — all staff, all 4 properties, and    │
 * │                    can create valet_admins as well as operators      │
 * │     /admin/staff   valet_admin  — operators at their own property     │
 * │                    only, and can only ever create operators          │
 * │                                                                     │
 * │   The differences are read from useAuth(), not passed as props, so    │
 * │   the two routes cannot drift apart. The server enforces the same     │
 * │   split independently — a valet_admin's claimed role and property are │
 * │   discarded in Postgres, so nothing here is load-bearing for          │
 * │   security. It is here so the UI does not offer choices that would    │
 * │   be rejected.                                                       │
 * │                                                                     │
 * │ ONE ROW, TWO ACTIONS: EDIT AND DEACTIVATE                             │
 * │   Name, number and PIN all live inside Edit. There is no separate     │
 * │   reset-PIN button and no bulk "Show PINs" column — an admin opening  │
 * │   a row is answering one question, and a PIN is just one of the       │
 * │   details.                                                           │
 * │                                                                     │
 * │ HOW PINs WORK HERE — and what it costs                                │
 * │   Since migration 0007 a PIN is stored encrypted in staff_pins, so it │
 * │   can be read back rather than only replaced. Migration 0009 narrowed │
 * │   that to one person per call and settled who may see whose:          │
 * │                                                                     │
 * │     system_admin   anyone, including themselves                       │
 * │     valet_admin    themselves + operators at their own property       │
 * │     operator       themselves only                                    │
 * │                                                                     │
 * │   Those rules live in Postgres, NOT here. This screen renders what    │
 * │   came back and shows the server's refusal if there was one.          │
 * │                                                                     │
 * │   Two consequences worth knowing:                                     │
 * │                                                                     │
 * │   1. Every read is logged to staff_pin_access with viewer, subject    │
 * │      and time. So the PIN is fetched when the Edit dialog OPENS, not  │
 * │      with the staff list — otherwise the log fills with views nobody  │
 * │      performed and stops being evidence of anything.                  │
 * │                                                                     │
 * │   2. An admin can now see AND change their own PIN here, so the old   │
 * │      "your own PIN must go through Change PIN, which verifies the     │
 * │      current one first" protection is gone. It had to go: once the    │
 * │      dialog displays your PIN, anyone at your unlocked laptop can     │
 * │      read it and walk through Change PIN anyway. Misuse is now        │
 * │      detectable rather than preventable.                              │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   App.jsx at /system/users and /admin/staff                          │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   lib/adminApi (Postgres RPC), lib/phoneAuth (PIN rules + generator), │
 * │   context/AuthContext, context/ToastContext, ui/*                     │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase, describeDbError, selectOptional } from '@/supabase'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { useToast } from '@/context/ToastContext'
import { PageHeader } from '@/components/AppShell'
import Card, { SectionHeading } from '@/components/ui/Card'
import Button from '@/components/ui/Button'
import Icon from '@/components/ui/Icon'
import Badge from '@/components/ui/Badge'
import Modal, { ConfirmModal } from '@/components/ui/Modal'
import EmptyState from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Spinner'
import { Field, Input, SearchInput, Select } from '@/components/ui/Field'
import HindiInput from '@/components/ui/HindiInput'
import {
  createStaff,
  changeStaffPhone,
  getStaffPin,
  renameStaff,
  setStaffActive,
  setStaffNameHi,
  setStaffPin,
  setStaffRole,
} from '@/lib/adminApi'
import { generatePin, isPinAcceptable, validatePhoneInput } from '@/lib/phoneAuth'
import {
  formatPhone,
  groupPhone,
  initials,
  normalisePhone,
  personName,
  skipPhoneSeparator,
} from '@/utils/format'
import { PIN_LENGTH, ROLES, ROLE_META } from '@/types'
import { cn } from '@/utils/cn'

export default function StaffManager() {
  const t = useT()
  const { isSystemAdmin, propertyId, propertyName, operatorId, refreshProfile } = useAuth()
  const toast = useToast()

  const [staff, setStaff] = useState([])
  const [properties, setProperties] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [search, setSearch] = useState('')
  /**
   * Seeded from ?role= so a stat tile elsewhere can link straight to the answer
   * — "5 operators" landing on an unfiltered staff list makes the reader do the
   * filtering the tile already did. Read ONCE as the initial value, not synced:
   * changing the dropdown afterwards must not be undone by the URL.
   */
  const [params] = useSearchParams()
  const [roleFilter, setRoleFilter] = useState(() => {
    const wanted = params.get('role')
    return Object.values(ROLES).includes(wanted) ? wanted : 'all'
  })
  const [propertyFilter, setPropertyFilter] = useState('all')
  const [showInactive, setShowInactive] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [deactivateTarget, setDeactivateTarget] = useState(null)

  /**
   * The PIN of a just-created account — { name, phone, pin, isReset }.
   * Non-null shows PinRevealModal.
   *
   * A modal rather than a toast, even though the PIN can be read again from
   * Edit: the admin has to say six digits out loud to someone standing in
   * front of them, and a toast slides away on a timer while they are still
   * talking. PIN CHANGES do not come through here — the admin typed those
   * themselves inside Edit, so they already know them.
   */
  const [credential, setCredential] = useState(null)

  // ══════════════════════════════════════════════════════════════════
  // LOAD
  // ══════════════════════════════════════════════════════════════════

  const load = useCallback(async () => {
    setLoadError(null)

    // name_hi arrives with migration 0022. Requested optimistically, and its
    // absence must not take the Users page down — that is the one screen an
    // admin would open to work out what is wrong. See selectOptional.
    const COLUMNS = 'id, user_id, name, phone, role, property_id, is_active, created_at, properties(id, name)'

    const staffQuery = (columns) => {
      let query = supabase.from('user_roles').select(columns).order('name')

      // RLS already limits a valet_admin to their own property, but being
      // explicit keeps the payload small and means the UI does not depend on a
      // policy staying exactly as it is today.
      if (!isSystemAdmin) {
        query = query.eq('property_id', propertyId).eq('role', ROLES.OPERATOR)
      }
      return query
    }

    const [{ data: rows, error }, propsResult] = await Promise.all([
      selectOptional(
        () => staffQuery(`id, user_id, name, name_hi, phone, role, property_id, is_active, created_at, properties(id, name)`),
        () => staffQuery(COLUMNS),
        'user_roles.name_hi',
      ),
      // Only the system admin picks a property; everyone else has exactly one.
      isSystemAdmin
        ? supabase.from('properties').select('id, name').eq('is_active', true).order('name')
        : Promise.resolve({ data: [], error: null }),
    ])

    if (error) {
      setLoadError(describeDbError(error, t('staff.couldNotLoad')))
      setLoading(false)
      return
    }

    setStaff(rows ?? [])
    setProperties(propsResult?.data ?? [])
    setLoading(false)
  }, [isSystemAdmin, propertyId])

  useEffect(() => {
    load()
  }, [load])

  // ══════════════════════════════════════════════════════════════════
  // FILTER — client-side. The whole staff list is at most ~40 rows across
  // 4 properties, so a round trip per keystroke would be slower and worse.
  // ══════════════════════════════════════════════════════════════════

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const digits = normalisePhone(search)

    return staff.filter((person) => {
      if (!showInactive && !person.is_active) return false
      if (roleFilter !== 'all' && person.role !== roleFilter) return false
      if (propertyFilter !== 'all' && person.property_id !== propertyFilter) return false

      if (!needle) return true
      // Match on name OR number — an admin looking someone up has one or the
      // other, rarely both.
      return (
        person.name?.toLowerCase().includes(needle) ||
        (digits.length >= 3 && person.phone?.includes(digits))
      )
    })
  }, [staff, search, roleFilter, propertyFilter, showInactive])

  const counts = useMemo(
    () => ({
      total: staff.filter((s) => s.is_active).length,
      operators: staff.filter((s) => s.is_active && s.role === ROLES.OPERATOR).length,
      inactive: staff.filter((s) => !s.is_active).length,
    }),
    [staff],
  )

  // ══════════════════════════════════════════════════════════════════
  // ACTIONS
  // ══════════════════════════════════════════════════════════════════

  async function handleCreated({ user, pin }, nameHiFailed) {
    setAddOpen(false)
    setCredential({ name: user.name, phone: user.phone, pin, isReset: false })
    // The account exists either way — see AddStaffModal.submit for why this is
    // a warning and not a failure. Said out loud so it does not go unnoticed:
    // the admin would otherwise find the name in English later and not know why.
    if (nameHiFailed) toast.error(t('hindiName.notSaved'))
    await load()
  }

  async function handleDeactivate() {
    const next = !deactivateTarget.is_active
    const result = await setStaffActive(deactivateTarget.id, next)

    if (!result.ok) {
      toast.error(result.error)
      setDeactivateTarget(null)
      return
    }

    toast.success(t(next ? 'staff.reactivated' : 'staff.deactivated', { name: deactivateTarget.name }))
    setDeactivateTarget(null)
    await load()
  }

  const canCreateAdmins = isSystemAdmin

  return (
    <>
      <PageHeader
        title={t(isSystemAdmin ? 'staff.usersTitle' : 'staff.valetTitle')}
        subtitle={
          isSystemAdmin
            ? t('staff.usersSubtitle')
            : t('staff.valetSubtitle', { property: propertyName })
        }
        actions={
          <Button icon="plus" size="md" onClick={() => setAddOpen(true)}>
            {t(isSystemAdmin ? 'staff.addUser' : 'staff.addValet')}
          </Button>
        }
      />

      {/* ── summary ─────────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone="neutral" size="lg" icon="users">
          {counts.total} active
        </Badge>
        {isSystemAdmin && (
          <Badge tone="info" size="lg" icon="key">
            {counts.operators} operators
          </Badge>
        )}
        {counts.inactive > 0 && (
          <Badge tone="warning" size="lg" icon="bell-off">
            {counts.inactive} inactive
          </Badge>
        )}
      </div>

      {/* ── filters ─────────────────────────────────────────────────── */}
      <Card padded={false} className="mb-4 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch('')}
            placeholder={t('staff.searchPlaceholder')}
            className="flex-1"
          />

          <div className="flex flex-wrap gap-2">
            {isSystemAdmin && (
              <>
                <select
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                  aria-label={t('staff.filterRole')}
                  className="h-12 rounded-xl border border-line-strong bg-surface px-3 text-sm font-medium text-ink outline-none focus:border-brand"
                >
                  <option value="all">{t('staff.allRoles')}</option>
                  <option value={ROLES.OPERATOR}>{t('staff.operators')}</option>
                  <option value={ROLES.VALET_ADMIN}>{t('staff.valetAdmins')}</option>
                  <option value={ROLES.SYSTEM_ADMIN}>{t('staff.systemAdmins')}</option>
                </select>

                <select
                  value={propertyFilter}
                  onChange={(e) => setPropertyFilter(e.target.value)}
                  aria-label={t('staff.filterProperty')}
                  className="h-12 rounded-xl border border-line-strong bg-surface px-3 text-sm font-medium text-ink outline-none focus:border-brand"
                >
                  <option value="all">{t('staff.allProperties')}</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </>
            )}

            <label className="flex h-12 cursor-pointer select-none items-center gap-2 rounded-xl border border-line-strong px-3 text-sm font-medium text-ink-muted">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                className="h-4 w-4 rounded border-line-strong accent-brand"
              />
              {t('staff.showInactive')}
            </label>
          </div>
        </div>
      </Card>

      {/* ── list ────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[5.5rem] rounded-card" />
          ))}
        </div>
      ) : loadError ? (
        <EmptyState
          variant="error"
          title={t('staff.couldNotLoadTitle')}
          description={loadError}
          action={
            <Button variant="secondary" size="md" icon="refresh" onClick={load}>
              {t('common.tryAgain')}
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="users"
          title={t(staff.length === 0 ? 'staff.noneYet' : 'staff.noMatches')}
          description={
            staff.length === 0
              ? isSystemAdmin
                ? t('staff.addFirstUser')
                : t('staff.addFirstValet')
              : t('staff.tryDifferent')
          }
          action={
            staff.length === 0 ? (
              <Button icon="plus" size="md" onClick={() => setAddOpen(true)}>
                {t(isSystemAdmin ? 'staff.addUser' : 'staff.addValet')}
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          <SectionHeading title={t('staff.heading')} count={visible.length} />
          <div className="space-y-2">
            {visible.map((person) => (
              <StaffRow
                key={person.id}
                person={person}
                isSelf={person.id === operatorId}
                showProperty={isSystemAdmin}
                onEdit={() => setEditTarget(person)}
                onToggleActive={() => setDeactivateTarget(person)}
              />
            ))}
          </div>
        </>
      )}

      {/* ── modals ──────────────────────────────────────────────────── */}
      <AddStaffModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={handleCreated}
        canCreateAdmins={canCreateAdmins}
        properties={properties}
        defaultPropertyId={propertyId}
        existingPhones={staff.map((s) => s.phone)}
      />

      <PinRevealModal credential={credential} onClose={() => setCredential(null)} />

      <EditStaffModal
        target={editTarget}
        isSelf={editTarget?.id === operatorId}
        canChangeRole={isSystemAdmin}
        properties={properties}
        onClose={() => setEditTarget(null)}
        onSaved={async (message, selfRoleChanged) => {
          setEditTarget(null)
          toast.success(message)
          await load()

          // Your own role decides your navigation and which routes you may
          // open, and AuthContext caches the user_roles row — so without this
          // the admin is left looking at a page their new role no longer
          // allows. refreshProfile re-reads it and ProtectedRoute redirects.
          if (selfRoleChanged) refreshProfile()
        }}
        existingPhones={staff.map((s) => s.phone)}
      />

      <ConfirmModal
        open={Boolean(deactivateTarget)}
        onClose={() => setDeactivateTarget(null)}
        onConfirm={handleDeactivate}
        tone={deactivateTarget?.is_active ? 'danger' : 'success'}
        title={
          deactivateTarget?.is_active
            ? t('staff.deactivateQ', { name: deactivateTarget?.name })
            : t('staff.reactivateQ', { name: deactivateTarget?.name })
        }
        description={
          deactivateTarget?.is_active
            ? t('staff.deactivateBody')
            : t('staff.reactivateBody')
        }
        confirmLabel={t(deactivateTarget?.is_active ? 'staff.deactivate' : 'staff.reactivate')}
      />
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// ROW
// ═══════════════════════════════════════════════════════════════════════

/**
 * Two actions, not three. Name, number and PIN all live behind Edit now — a
 * separate lock button implied they were separate jobs, when in practice an
 * admin opening this row is answering one question ("what are this person's
 * details, and are they right?") and a PIN is one of the details.
 *
 * No PIN is shown here. It is fetched only when the Edit dialog opens, so a
 * PIN is never on screen behind someone's shoulder just because they scrolled
 * past — and every read is a logged, deliberate act rather than a side effect
 * of loading a list.
 */
function StaffRow({ person, isSelf, showProperty, onEdit, onToggleActive }) {
  const t = useT()
  const meta = ROLE_META[person.role]

  return (
    <Card
      padded={false}
      className={cn('p-3.5', !person.is_active && 'opacity-60')}
      accent={person.role === ROLES.SYSTEM_ADMIN ? 'vip' : undefined}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-ink-muted">
          {initials(person.name)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate font-semibold text-ink">
              {personName(person.name, person.name_hi)}
            </p>
            {isSelf && (
              <Badge tone="info" size="sm">
                {t('staff.you')}
              </Badge>
            )}
            {!person.is_active && (
              <Badge tone="warning" size="sm">
                {t('staff.inactive')}
              </Badge>
            )}
          </div>

          {/* The number is the login identifier, so it gets equal billing with
              the name rather than being tucked away as a contact detail. */}
          <p className="tnum mt-0.5 text-sm text-ink-muted">+91 {formatPhone(person.phone)}</p>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={person.role === ROLES.OPERATOR ? 'neutral' : 'info'} size="sm" icon={meta?.icon}>
              {/* role.* keys, so the badge matches the filter dropdown above. */}
              {t(`role.${person.role}`)}
            </Badge>
            {showProperty && (
              <span className="text-xs text-ink-subtle">
                {person.properties?.name ?? t('staff.allProperties')}
              </span>
            )}

          </div>
        </div>

        {/* Actions. Icon-only on a phone (no room for labels), and the whole
            row stays a comfortable 44px+ tap target each. */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-md"
            icon="edit"
            onClick={onEdit}
            aria-label={t('staff.editNamed', { name: person.name })}
            title={t('staff.editTooltip')}
          />
          <Button
            variant="ghost"
            size="icon-md"
            icon={person.is_active ? 'x-circle' : 'check-circle'}
            onClick={onToggleActive}
            disabled={isSelf}
            aria-label={t(person.is_active ? 'staff.deactivateNamed' : 'staff.reactivateNamed', {
              name: person.name,
            })}
            title={
              isSelf
                ? t('staff.cannotDeactivateSelf')
                : t(person.is_active ? 'staff.deactivate' : 'staff.reactivate')
            }
            className={person.is_active ? 'hover:bg-danger-soft hover:text-danger' : 'hover:bg-success-soft hover:text-success'}
          />
        </div>
      </div>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// ADD
// ═══════════════════════════════════════════════════════════════════════

function AddStaffModal({
  open,
  onClose,
  onCreated,
  canCreateAdmins,
  properties,
  defaultPropertyId,
  existingPhones,
}) {
  const t = useT()
  const [name, setName] = useState('')
  const [nameHi, setNameHi] = useState('')
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [role, setRole] = useState(ROLES.OPERATOR)
  const [property, setProperty] = useState(defaultPropertyId ?? '')
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)

  // Reset every time the modal opens, so a previous half-filled attempt (or a
  // previous operator's PIN) never leaks into the next one.
  useEffect(() => {
    if (!open) return
    setName('')
    setPhone('')
    setPin(generatePin())
    setRole(ROLES.OPERATOR)
    setProperty(defaultPropertyId ?? '')
    setErrors({})
    setFormError(null)
  }, [open, defaultPropertyId])

  const needsProperty = role !== ROLES.SYSTEM_ADMIN

  async function handleSubmit(event) {
    event.preventDefault()

    const next = {}
    if (name.trim().length < 2) next.name = "Enter the person's full name"

    const phoneError = validatePhoneInput(phone)
    if (phoneError) next.phone = phoneError
    else if (existingPhones.includes(normalisePhone(phone))) {
      next.phone = t('staff.phoneTaken')
    }

    const pinCheck = isPinAcceptable(pin)
    if (!pinCheck.ok) next.pin = pinCheck.error

    if (needsProperty && !property) next.property = t('staff.chooseProperty')

    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length) return

    const result = await createStaff({
      name: name.trim(),
      phone: normalisePhone(phone),
      pin,
      role,
      propertyId: needsProperty ? property : null,
    })

    if (!result.ok) {
      setFormError(result.error)
      return
    }

    // SECOND call, and deliberately not fatal.
    //
    // The account, the identity and the PIN are already written and cannot be
    // rolled back from here. Refusing to finish because an optional label did
    // not save would leave the admin staring at an error for a valet who was
    // in fact created successfully — and they would try again and hit
    // PHONE_TAKEN. So it is reported and the flow continues; Edit can fix it.
    let nameHiFailed = false
    const trimmedHi = nameHi.trim()
    if (trimmedHi && result.user?.id) {
      const hiResult = await setStaffNameHi(result.user.id, trimmedHi)
      nameHiFailed = !hiResult.ok
    }

    await onCreated(result, nameHiFailed)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(canCreateAdmins ? 'staff.addUser' : 'staff.addValet')}
      description={t('staff.signInWith')}
      size="md"
      // A half-filled form should not vanish on a stray backdrop tap.
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="md" onClick={handleSubmit} loadingText={t('common.creating')}>
            {t('tokens.create')}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {formError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-3 text-sm font-medium text-danger"
          >
            <Icon name="alert" size={17} className="mt-0.5" strokeWidth={2} />
            <span>{formError}</span>
          </div>
        )}

        <Input
          label={t('staff.fullName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          placeholder={t('staff.namePlaceholder')}
          autoComplete="off"
          autoCapitalize="words"
          required
        />

        {/* Directly under the English name: it is a second spelling of the
            field above and should read as one thing with it. */}
        <HindiInput id="add-name-hi" source={name} value={nameHi} onChange={setNameHi} />

        <Field label={t('staff.mobileNumber')} htmlFor="add-phone" error={errors.phone} required
          hint={!errors.phone ? t('staff.signInHint') : undefined}>
          <div className="relative">
            <span className="pointer-events-none absolute left-0 top-0 flex h-touch w-14 items-center justify-center border-r border-line-strong text-[0.9375rem] font-semibold text-ink-subtle">
              +91
            </span>
            <input
              id="add-phone"
              value={groupPhone(phone)}
              onChange={(e) => setPhone(normalisePhone(e.target.value))}
              onKeyDown={skipPhoneSeparator}
              type="tel"
              inputMode="numeric"
              // No maxLength — it counts raw characters and truncates a pasted
              // "+91 98765 43210" before onChange can normalise it. See the
              // longer note in pages/Login.jsx.
              placeholder="98765 43210"
              className={cn(
                'tnum h-touch w-full rounded-xl border bg-surface pl-16 pr-4',
                'text-lg font-semibold tracking-[0.06em] text-ink outline-none',
                'placeholder:font-normal placeholder:tracking-normal placeholder:text-ink-subtle',
                errors.phone
                  ? 'border-danger focus:border-danger'
                  : 'border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20',
              )}
            />
          </div>
        </Field>

        {/* PIN. Pre-filled with a cryptographically random value rather than
            blank: left to choose, admins pick 123456 for everyone, and this
            system has no login lockout to compensate. */}
        <Field
          label={t('login.pin', { n: PIN_LENGTH })}
          htmlFor="add-pin"
          error={errors.pin}
          required
          hint={
            !errors.pin
              ? t('staff.pinHint')
              : undefined
          }
        >
          <div className="flex items-start gap-2">
            <input
              id="add-pin"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
              type="tel"
              inputMode="numeric"
              maxLength={PIN_LENGTH}
              className={cn(
                // min-w-0: without it this input refuses to shrink below its
                // ~20-character intrinsic width, which at this type size is
                // wider than the dialog — the button gets pushed off the edge
                // behind a horizontal scrollbar. See the same note in
                // PinSection.
                'tnum h-touch min-w-0 flex-1 rounded-xl border bg-surface px-4',
                'text-center text-2xl font-bold tracking-[0.35em] text-ink outline-none',
                errors.pin
                  ? 'border-danger focus:border-danger'
                  : 'border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20',
              )}
            />
            <Button
              variant="secondary"
              size="icon-lg"
              icon="refresh"
              onClick={() => {
                setPin(generatePin())
                setErrors((p) => ({ ...p, pin: null }))
              }}
              aria-label={t('staff.generatePin')}
              title={t('staff.generatePin')}
            />
          </div>
        </Field>

        {/* Role picker only for a system admin. A valet_admin never sees it,
            and the server would discard it anyway. */}
        {canCreateAdmins && (
          <Select
            label={t('staff.role')}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            options={[
              { value: ROLES.OPERATOR, label: t('staff.roleOperator') },
              { value: ROLES.VALET_ADMIN, label: t('staff.roleValetAdmin') },
              { value: ROLES.SYSTEM_ADMIN, label: t('staff.roleSystemAdmin') },
            ]}
          />
        )}

        {canCreateAdmins && needsProperty && (
          <Select
            label={t('staff.property')}
            value={property}
            onChange={(e) => setProperty(e.target.value)}
            error={errors.property}
            placeholder={t('staff.chooseProperty')}
            options={properties.map((p) => ({ value: p.id, label: p.name }))}
            required
          />
        )}

        {canCreateAdmins && !needsProperty && (
          <p className="flex items-start gap-2 rounded-lg bg-info-soft px-3.5 py-3 text-xs leading-relaxed text-info">
            <Icon name="info" size={15} className="mt-0.5" />
            <span>{t('staff.systemAdminNote')}</span>
          </p>
        )}

        {/* Lets Enter submit the form even though the real button is in the
            modal footer, outside this <form>. */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// PIN REVEAL — shown right after an account is created
//
// This used to be the only moment a PIN was readable. Since migration 0007 it
// is not: the PIN is stored encrypted and can be read back from Edit. The
// modal stays because saying six digits out loud to someone standing in front
// of you needs a surface that does not disappear on a timer.
// ═══════════════════════════════════════════════════════════════════════

function PinRevealModal({ credential, onClose }) {
  const t = useT()
  const [copied, setCopied] = useState(false)

  useEffect(() => setCopied(false), [credential])

  if (!credential) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(credential.pin)
      setCopied(true)
    } catch {
      // Clipboard needs HTTPS or localhost and can be blocked outright. The
      // PIN is on screen in large type either way, so this is a convenience
      // that is allowed to fail silently.
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t(credential.isReset ? 'staff.pinResetTitle' : 'staff.createdTitle')}
      size="sm"
      // A stray backdrop tap should not close this mid-sentence.
      closeOnBackdrop={false}
      footer={
        <Button variant="primary" size="md" fullWidth onClick={onClose}>
          {t('common.done')}
        </Button>
      }
    >
      <div className="text-center">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-success-soft text-success">
          <Icon name="check-circle" size={24} />
        </span>

        <p className="font-semibold text-ink">{credential.name}</p>
        <p className="tnum mt-0.5 text-sm text-ink-muted">+91 {formatPhone(credential.phone)}</p>

        <div className="mt-5 rounded-xl border-2 border-dashed border-line-strong bg-surface-sunken px-4 py-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            {t('staff.pinLabel')}
          </p>
          <p className="tnum mt-1.5 text-4xl font-bold tracking-[0.2em] text-ink">
            {credential.pin}
          </p>

          <Button
            variant="secondary"
            size="sm"
            icon={copied ? 'check' : 'download'}
            onClick={copy}
            className="mt-3"
          >
            {t(copied ? 'staff.copied' : 'staff.copyPin')}
          </Button>
        </div>

        <p className="mt-4 flex items-start gap-2 rounded-lg bg-info-soft px-3.5 py-3 text-left text-xs leading-relaxed text-info">
          <Icon name="info" size={15} className="mt-0.5 shrink-0" />
          <span>
            {t('staff.giveThisTo', { name: credential.name })}
          </span>
        </p>
      </div>
    </Modal>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// EDIT — name, number AND PIN, in one dialog
//
// These used to be two buttons on the row. They are one now because an admin
// opening a staff row is answering a single question — "are this person's
// details right?" — and which of those details happens to be a secret is an
// implementation detail of the database, not a distinction the admin cares
// about while someone stands in front of them.
//
// THE PIN IS FETCHED WHEN THIS OPENS, NOT WITH THE LIST
//   Every read is written to staff_pin_access with the viewer, the subject
//   and the time. Fetching per-row on page load would fill that log with
//   views nobody performed and make it worthless as evidence. Fetching here
//   is honest: the PIN is genuinely about to be readable.
//
//   It also means a PIN is never sitting in a list behind someone's shoulder.
//
// WHO SEES AND CHANGES WHAT is decided in Postgres (migration 0009), not
// here. This component renders whatever came back and shows the server's
// refusal if there was one. A valet_admin who somehow reached another
// property's row gets FORBIDDEN from the database, not a blank field.
// ═══════════════════════════════════════════════════════════════════════

function EditStaffModal({
  target,
  isSelf,
  onClose,
  onSaved,
  existingPhones,
  /** system_admin only. A valet_admin never sees the role or property fields. */
  canChangeRole = false,
  properties = [],
}) {
  const t = useT()
  const [name, setName] = useState('')
  const [nameHi, setNameHi] = useState('')
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [role, setRole] = useState(ROLES.OPERATOR)
  const [property, setProperty] = useState('')
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)

  /** null while loading, then { stored } or { error } from the server. */
  const [pinState, setPinState] = useState(null)
  /** The PIN as it was when the dialog opened, so we can tell if it changed. */
  const [originalPin, setOriginalPin] = useState('')
  const [pinVisible, setPinVisible] = useState(false)

  useEffect(() => {
    if (!target) return undefined

    setName(target.name ?? '')
    // Seeded from the row, which is what makes HindiInput start in manual
    // mode — a spelling already in the database was chosen by a person and
    // must not be auto-overwritten the moment this dialog opens.
    setNameHi(target.name_hi ?? '')
    setPhone(target.phone ?? '')
    setRole(target.role ?? ROLES.OPERATOR)
    setProperty(target.property_id ?? '')
    setErrors({})
    setFormError(null)
    setPin('')
    setOriginalPin('')
    setPinState(null)
    // Starts hidden. Choosing to edit someone is not the same as choosing to
    // show their PIN to whoever is standing at the desk — one tap reveals it.
    setPinVisible(false)

    let stale = false

    ;(async () => {
      const result = await getStaffPin(target.id)
      if (stale) return

      if (!result.ok) {
        setPinState({ error: result.error })
        return
      }
      setPinState({ stored: Boolean(result.stored) })
      setPin(result.pin ?? '')
      setOriginalPin(result.pin ?? '')
    })()

    // Guards against a slow reply for the PREVIOUS person landing after the
    // admin has already opened someone else — which would put one valet's PIN
    // under another valet's name.
    return () => {
      stale = true
    }
  }, [target])

  if (!target) return null

  const nameChanged = name.trim() !== target.name
  // Compares against '' for a row that has no Hindi name yet, so typing the
  // first one counts as a change and clearing an existing one does too.
  const nameHiChanged = nameHi.trim() !== (target.name_hi ?? '')
  const phoneChanged = normalisePhone(phone) !== target.phone
  const pinChanged = pin !== '' && pin !== originalPin
  const canEditPin = Boolean(pinState && !pinState.error)

  // A system_admin has no property, so the picker is irrelevant for that role
  // and the server nulls it regardless.
  const needsProperty = role !== ROLES.SYSTEM_ADMIN
  const roleChanged =
    canChangeRole &&
    (role !== target.role ||
      (needsProperty ? property : null) !== (target.property_id ?? null))

  async function handleSave() {
    const next = {}
    if (name.trim().length < 2) next.name = t('staff.enterName')

    if (phoneChanged) {
      const phoneError = validatePhoneInput(phone)
      if (phoneError) next.phone = phoneError
      else if (existingPhones.filter((p) => p !== target.phone).includes(normalisePhone(phone))) {
        next.phone = t('staff.phoneTaken')
      }
    }

    if (pinChanged) {
      const check = isPinAcceptable(pin)
      if (!check.ok) next.pin = check.error
    }

    if (roleChanged && needsProperty && !property) next.property = t('staff.chooseProperty')

    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length) return

    // ONE list, used both to decide whether there is anything to do and to
    // word the toast afterwards. It used to be two — a boolean chain here and
    // a separate array at the bottom — and they drifted: nameHiChanged was
    // added to the array but not to the chain, so changing ONLY the Hindi name
    // took the "nothing changed" path, closed the dialog and wrote nothing. It
    // looked exactly like a successful save. Keep them fused.
    const changed = [
      nameChanged && t('staff.fieldName'),
      nameHiChanged && t('staff.fieldNameHi'),
      phoneChanged && t('staff.fieldNumber'),
      pinChanged && t('staff.fieldPin'),
      roleChanged && t('staff.fieldRole'),
    ].filter(Boolean)

    if (changed.length === 0) {
      onClose()
      return
    }

    // Three separate calls because they are three different operations
    // server-side — changing a number moves the auth record too, and changing
    // a PIN moves the bcrypt hash and the encrypted copy together. Ordered
    // least-likely-to-fail first, so a rejection later in the sequence does
    // not throw away work that already succeeded.
    if (nameChanged) {
      const result = await renameStaff(target.id, name.trim())
      if (!result.ok) {
        setFormError(result.error)
        return
      }
    }

    if (nameHiChanged) {
      // '' erases it — see migration 0022. An admin who accepted a bad machine
      // transliteration has to be able to remove it, not only overwrite it.
      const result = await setStaffNameHi(target.id, nameHi.trim())
      if (!result.ok) {
        setFormError(result.error)
        return
      }
    }

    if (phoneChanged) {
      const result = await changeStaffPhone(target.id, normalisePhone(phone))
      if (!result.ok) {
        setFormError(result.error)
        return
      }
    }

    if (pinChanged) {
      const result = await setStaffPin(target.id, pin)
      if (!result.ok) {
        // PIN_TAKEN names whoever already has it, so it belongs on the field.
        setErrors({ pin: result.error })
        return
      }
    }

    // LAST in the sequence on purpose: it is the call most likely to be
    // refused, and both of its refusals are conditions the admin has to go and
    // resolve elsewhere (finish a car, promote someone). Running it first would
    // mean a rejection discards a name or PIN edit that was perfectly fine.
    if (roleChanged) {
      const result = await setStaffRole(target.id, role, needsProperty ? property : null)
      if (!result.ok) {
        setFormError(result.error)
        return
      }
    }

    await onSaved(
      t('staff.updated', { name: name.trim(), fields: changed.join(', ') }),
      // Changing your own role changes your own navigation and which routes
      // you may even open, and none of that is re-read until the profile is
      // reloaded. Without this the admin is left on a page their new role is
      // no longer allowed on.
      roleChanged && isSelf,
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('staff.editNamed', { name: target.name })}
      // md, not sm: this dialog carries three fields now, and the PIN row is
      // an input plus two 56px buttons. At sm they have 344px between them.
      size="md"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="md" onClick={handleSave} loadingText={t('common.saving')}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {formError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-3 text-sm font-medium text-danger"
          >
            <Icon name="alert" size={17} className="mt-0.5" strokeWidth={2} />
            <span>{formError}</span>
          </div>
        )}

        <Input
          label={t('staff.fullName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          autoCapitalize="words"
          required
        />

        <HindiInput
          id="edit-name-hi"
          source={name}
          value={nameHi}
          onChange={setNameHi}
          // What the DATABASE holds, straight off the row — not the dialog's
          // own state, which is still empty while this mounts. Together these
          // say "nothing has been changed yet", which is the one case where
          // the stored spelling must be left exactly as it is.
          storedSource={target.name}
          storedValue={target.name_hi}
        />

        <Field
          label={t('staff.mobileNumber')}
          htmlFor="edit-phone"
          error={errors.phone}
          required
          hint={
            !errors.phone && phoneChanged
              ? t('staff.phoneChangeHint')
              : undefined
          }
        >
          <div className="relative">
            <span className="pointer-events-none absolute left-0 top-0 flex h-touch w-14 items-center justify-center border-r border-line-strong text-[0.9375rem] font-semibold text-ink-subtle">
              +91
            </span>
            <input
              id="edit-phone"
              value={groupPhone(phone)}
              onChange={(e) => setPhone(normalisePhone(e.target.value))}
              onKeyDown={skipPhoneSeparator}
              type="tel"
              inputMode="numeric"
              // No maxLength — see the note in pages/Login.jsx.
              className={cn(
                'tnum h-touch w-full rounded-xl border bg-surface pl-16 pr-4',
                'text-lg font-semibold tracking-[0.06em] text-ink outline-none',
                errors.phone
                  ? 'border-danger focus:border-danger'
                  : 'border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20',
              )}
            />
          </div>
        </Field>

        {/* Role and property, system_admin only. A valet_admin editing their
            own operators never sees these — the server refuses them anyway
            (migration 0013), but a field that always fails is worse than no
            field. */}
        {canChangeRole && (
          <div className="space-y-4 border-t border-line pt-4">
            <Select
              label={t('staff.role')}
              value={role}
              onChange={(e) => {
                setRole(e.target.value)
                setErrors((current) => ({ ...current, property: undefined }))
              }}
              options={[
                { value: ROLES.OPERATOR, label: t('staff.roleOperator') },
                { value: ROLES.VALET_ADMIN, label: t('staff.roleValetAdmin') },
                { value: ROLES.SYSTEM_ADMIN, label: t('staff.roleSystemAdmin') },
              ]}
              hint={
                isSelf && role !== target.role
                  ? t('staff.ownAccountNote')
                  : undefined
              }
            />

            {needsProperty ? (
              <Select
                label={t('staff.property')}
                value={property}
                onChange={(e) => setProperty(e.target.value)}
                error={errors.property}
                options={[
                  { value: '', label: t('staff.choosePropertyDots') },
                  ...properties.map((p) => ({ value: p.id, label: p.name })),
                ]}
                required
              />
            ) : (
              <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-subtle">
                <Icon name="info" size={14} className="mt-0.5 shrink-0" />
                <span>
                  {t('staff.everyProperty')}
                </span>
              </p>
            )}

            {roleChanged && (
              <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-xs leading-relaxed text-warning">
                <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
                <span>
                  This will be refused if {isSelf ? 'you are' : `${target.name} is`} holding a
                  car right now — moving them mid-task would leave that car assigned to somebody
                  who can no longer finish it.
                </span>
              </p>
            )}
          </div>
        )}

        <div className="border-t border-line pt-4">
          <PinSection
            pinState={pinState}
            pin={pin}
            setPin={setPin}
            error={errors.pin}
            clearError={() => setErrors((current) => ({ ...current, pin: undefined }))}
            visible={pinVisible}
            setVisible={setPinVisible}
            canEdit={canEditPin}
            changed={pinChanged}
            isSelf={isSelf}
            name={target.name}
          />
        </div>
      </div>
    </Modal>
  )
}

function PinSection({
  pinState,
  pin,
  setPin,
  error,
  clearError,
  visible,
  setVisible,
  canEdit,
  changed,
  isSelf,
  name,
}) {
  const t = useT()

  // Still fetching.
  if (!pinState) {
    return (
      <Field label={t('staff.pinLabel')}>
        <Skeleton className="h-touch rounded-xl" />
      </Field>
    )
  }

  // The server said no — wrong property, wrong role, or a missing migration.
  // Say which, rather than showing an empty box that looks editable.
  if (pinState.error) {
    return (
      <Field label="PIN">
        <p className="flex items-start gap-2 rounded-lg bg-surface-sunken px-3.5 py-3 text-sm text-ink-muted">
          <Icon name="lock" size={15} className="mt-0.5 shrink-0" />
          <span>{pinState.error}</span>
        </p>
      </Field>
    )
  }

  const hint = changed
    ? t(isSelf ? 'staff.pinChangedHint' : 'staff.pinChangedHintOther')
    : t('staff.pinTypeOver')

  return (
    <Field
      label={isSelf ? t('staff.yourPin') : t('staff.theirPin', { name })}
      htmlFor="edit-pin"
      error={error}
      hint={error || !pinState.stored ? undefined : hint}
    >
      {/* Not a failure, and it must not read like one. This account's PIN was
          set before migration 0007 added encrypted storage, so the only copy
          is a bcrypt hash — and bcrypt is one-way by design. There is nothing
          to recover and no backfill that could exist. Setting one here writes
          the encrypted copy, and from then on it reads back normally. */}
      {!pinState.stored && (
        <p className="mb-2 flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2.5 text-xs leading-relaxed text-info">
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          <span>
            {t('staff.noStoredPin')}, and the
            old one is a one-way hash that nothing can read back. Set a PIN here once and it
            will show up from then on.
          </span>
        </p>
      )}

      <div className="flex items-start gap-2">
        <input
          id="edit-pin"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))
            if (error) clearError()
          }}
          type={visible ? 'text' : 'password'}
          inputMode="numeric"
          // new-password, not off: Chrome ignores off on password-type inputs
          // and would offer to autofill a saved credential here, which would
          // silently overwrite one valet's PIN with something unrelated.
          autoComplete="new-password"
          maxLength={PIN_LENGTH}
          placeholder={pinState.stored ? '' : t('staff.setNewPin')}
          disabled={!canEdit}
          className={cn(
            // min-w-0 is load-bearing. A flex child will not shrink below its
            // intrinsic min-content width, and an <input> reports a default of
            // ~20 characters — at text-2xl with 0.35em tracking that is far
            // wider than the dialog, so the row overflowed and pushed the two
            // buttons off the edge behind a horizontal scrollbar.
            'tnum h-touch min-w-0 flex-1 rounded-xl border bg-surface px-4',
            'text-center text-2xl font-bold tracking-[0.35em] text-ink outline-none',
            // The placeholder is a sentence, not a PIN, so it does not want
            // PIN typography — at 2xl with wide tracking it was the single
            // widest thing in the dialog.
            'placeholder:text-base placeholder:font-medium placeholder:tracking-normal',
            'disabled:cursor-not-allowed disabled:bg-surface-sunken',
            error
              ? 'border-danger focus:border-danger'
              : 'border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20',
          )}
        />

        <Button
          variant="secondary"
          size="icon-lg"
          icon={visible ? 'eye-off' : 'eye'}
          onClick={() => setVisible((current) => !current)}
          aria-label={t(visible ? 'login.hidePin' : 'login.showPin')}
          title={t(visible ? 'login.hidePin' : 'login.showPin')}
        />
        <Button
          variant="secondary"
          size="icon-lg"
          icon="refresh"
          disabled={!canEdit}
          onClick={() => {
            setPin(generatePin())
            setVisible(true)
            if (error) clearError()
          }}
          aria-label={t('staff.generateNewPin')}
          title={t('staff.generateNewPin')}
        />
      </div>
    </Field>
  )
}
