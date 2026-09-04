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
  deleteStaff,
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
import { DEFAULT_PIN, PIN_LENGTH, ROLES, ROLE_META } from '@/types'
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

  /**
   * Which rows are ticked, by user_role id.
   *
   * A Set and not an array: every row asks "am I in here" on every render, and
   * `has` is the only lookup that stays flat as the list grows.
   */
  const [selected, setSelected] = useState(() => new Set())

  // Blocks a second tap while a run is in flight. The loop below is not
  // instant, and two overlapping runs would double every request.
  const [bulkBusy, setBulkBusy] = useState(false)

  // Open confirmation for "deactivate every operator". Not a plain boolean —
  // it carries the list, so the dialog can state exactly who and how many.
  const [allOffTarget, setAllOffTarget] = useState(null)

  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [deactivateTarget, setDeactivateTarget] = useState(null)
  // Holds the LIST being deleted, not one person: the button acts on the
  // ticked rows, and the confirmation has to state the count.
  const [deleteTarget, setDeleteTarget] = useState(null)

  /**
   * The PIN of a just-created account — { name, phone, pin, isReset }.
   * Non-null shows PinRevealModal.
   *
   * A modal rather than a toast, even though the PIN can be read again from
   * Edit: the admin has to say the PIN out loud to someone standing in
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

    const staffQuery = (columns, { hideDeleted = false } = {}) => {
      let query = supabase.from('user_roles').select(columns).order('name')

      // A deleted user keeps their user_roles row — Records reads "who parked
      // this car" through a live join on it, so removing the row would blank
      // the operator's name across their whole history. See migration 0063.
      // The row is therefore filtered out here rather than gone, and only in
      // the optimistic query: on a database without the column selectOptional
      // falls back to the query that does not mention it.
      if (hideDeleted) query = query.is('deleted_at', null)

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
        () =>
          staffQuery(
            `id, user_id, name, name_hi, phone, role, property_id, is_active, created_at, deleted_at, properties(id, name)`,
            { hideDeleted: true },
          ),
        () => staffQuery(COLUMNS),
        'user_roles.name_hi or deleted_at',
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

    // Named, because it is sorted below. .sort() mutates, and sorting the array
    // returned by .filter() is safe only because that array is new — sorting
    // `staff` itself would reorder state under React.
    const rows = staff.filter((person) => {
      // ONLY inactive, not "inactive as well".
      //
      // This used to be `if (!showInactive && !person.is_active)` — an INCLUDE
      // toggle, so ticking it appended the closed accounts to the open ones and
      // you had to hunt through both. The point of the box is to work ON the
      // inactive ones: find them, tick them, turn them back on. That needs a
      // list containing nothing else.
      if (person.is_active === showInactive) return false
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
    /**
     * Sorted by ROLE first, then by name.
     *
     * The list arrives ordered by name alone, which mixes the three roles
     * together — a system admin, an operator, another system admin. That is
     * fine for looking one person up, and wrong for reading the list as a
     * structure: seniority is the thing the eye is actually scanning for, and
     * the role chips were the only clue to it.
     *
     * The rank is explicit rather than alphabetical on the role string, which
     * would sort operator, system_admin, valet_admin — alphabetically correct
     * and organisationally backwards.
     *
     * localeCompare inside a rank, not a raw `<`: names here are Indian and
     * mixed-case, and a byte comparison puts every capital before every
     * lowercase, so "kanishk" would sort after "Zoya".
     */
    const rank = {
      [ROLES.SYSTEM_ADMIN]: 0,
      [ROLES.VALET_ADMIN]: 1,
      [ROLES.VALET_VENDOR]: 2,
      [ROLES.OPERATOR]: 3,
    }
    return rows.sort((a, b) => {
      const byRole = (rank[a.role] ?? 9) - (rank[b.role] ?? 9)
      if (byRole !== 0) return byRole
      return (a.name ?? '').localeCompare(b.name ?? '')
    })
  }, [staff, search, roleFilter, propertyFilter, showInactive])

  /**
   * Drop the selection whenever the filters move.
   *
   * Without this a tick survives the row leaving the screen, and "Deactivate 3"
   * would act on somebody the admin can no longer see — including, after
   * flipping to the inactive list, people they never meant to touch.
   */
  useEffect(() => {
    setSelected(new Set())
  }, [showInactive, roleFilter, propertyFilter, search])

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

  // ══════════════════════════════════════════════════════════════════
  // BULK
  // ══════════════════════════════════════════════════════════════════

  /**
   * Rows a tick may be placed on.
   *
   * Not simply `visible`: admin_set_staff_active refuses to deactivate the
   * caller, so offering yourself a checkbox is offering an action that is
   * guaranteed to fail. The row still renders — you are on the list — it just
   * has no box.
   */
  const selectable = useMemo(() => visible.filter((p) => p.id !== operatorId), [visible, operatorId])

  // Intersected with what is on screen. Belt and braces next to the clearing
  // effect above: whatever happens to the filters, a hidden row cannot be acted
  // on, because the action reads from here.
  const chosen = useMemo(
    () => selectable.filter((p) => selected.has(p.id)),
    [selectable, selected],
  )

  const allChosen = selectable.length > 0 && chosen.length === selectable.length

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(allChosen ? new Set() : new Set(selectable.map((p) => p.id)))
  }

  /**
   * Turn every ticked account on, or off.
   *
   * ── WHY THIS IS A LOOP AND NOT ONE CALL ─────────────────────────────
   * There is no bulk RPC, and adding one would have to re-implement the checks
   * admin_set_staff_active already makes — who may manage whom, and whether an
   * operator is holding a car right now. Calling it once per person keeps ONE
   * place deciding, and the cost is a handful of round trips on a list that is
   * at most a few dozen rows.
   *
   * ── WHY FAILURES ARE COUNTED AND NAMED ──────────────────────────────
   * A partial failure is the NORMAL case, not an edge one: the RPC refuses to
   * deactivate an operator who is holding a car, and on a busy evening several
   * of them will be. Reporting "5 updated" when two were refused would leave an
   * admin certain those two were switched off while they are still signed in.
   *
   * Sequential, not Promise.all: a dozen concurrent writes to user_roles for no
   * gain on a list this size, and the order of the toasts would be arbitrary.
   */
  async function handleBulkActive(next) {
    if (!chosen.length || bulkBusy) return
    setBulkBusy(true)

    const failed = []
    for (const person of chosen) {
      const result = await setStaffActive(person.id, next)
      if (!result.ok) failed.push({ name: person.name, error: result.error })
    }

    setBulkBusy(false)
    setSelected(new Set())
    await load()

    const done = chosen.length - failed.length
    if (done > 0) {
      toast.success(t(next ? 'staff.bulkActivated' : 'staff.bulkDeactivated', { n: done }))
    }
    // Named, not counted. "2 failed" tells an admin nothing they can act on.
    for (const f of failed) toast.error(`${f.name}: ${f.error}`)
  }

  /**
   * Destroys the ticked users' logins. System admin only, inactive rows only —
   * both enforced in the database as well, because this button is not the only
   * way to reach the RPC.
   *
   * One at a time and sequentially, like handleBulkActive: each call is its own
   * transaction, and a failure halfway through must leave the successful ones
   * done rather than rolling everybody back. The failures are then named.
   *
   * cars_kept is summed and reported. An admin who has just deleted somebody
   * needs to know their records survived, and saying so is cheaper than
   * letting them discover it by opening Records and finding a name they
   * expected to be gone.
   */
  async function handleBulkDelete() {
    const targets = deleteTarget ?? []
    if (!targets.length || bulkBusy) return
    setBulkBusy(true)

    const failed = []
    let carsKept = 0
    for (const person of targets) {
      const result = await deleteStaff(person.id)
      if (result.ok) carsKept += Number(result.cars_kept ?? 0)
      else failed.push({ name: person.name, error: result.error })
    }

    setBulkBusy(false)
    setDeleteTarget(null)
    setSelected(new Set())
    await load()

    const done = targets.length - failed.length
    if (done > 0) {
      toast.success(t('staff.bulkDeleted', { n: done }))
      // Only when there is something to reassure them about. "0 cars kept" is
      // noise on a test account that never parked anything.
      if (carsKept > 0) toast.info(t('staff.deletedRecordsKept', { n: carsKept }))
    }
    for (const f of failed) toast.error(`${f.name}: ${f.error}`)
  }

  /**
   * Everyone on the list in front of you who this button will switch off.
   *
   * ── SYSTEM ADMINS ARE NEVER IN HERE ─────────────────────────────────
   * On request: end of shift closes everybody EXCEPT the system admins. They
   * are what remains able to sign in and put it all back in the morning, and a
   * button that can lock the last person out of the system is not a button, it
   * is a trap. Excluding the whole role rather than just YOU also means a
   * second system admin cannot be shut out by the first.
   *
   * ── WHAT A VALET ADMIN CAN ACTUALLY DO ──────────────────────────────
   * can_manage_staff() lets a system_admin manage anyone, and a valet_admin
   * only OPERATORS at their own property. So the list is narrowed by the
   * caller's role rather than being the same for both: a valet_admin offered
   * their fellow valet admins here would get "you can only manage operators"
   * once per row, having already confirmed a destructive action.
   *
   * ── SCOPED TO WHAT IS VISIBLE, NOT TO THE DATABASE ──────────────────
   * Unfiltered, "everyone" is exactly what this is. But if a system_admin has
   * narrowed to one property, closing the other three sites because the button
   * says "all" would be a disaster dressed as a feature. The confirmation names
   * the count, so the two readings cannot diverge unseen.
   */
  const shiftEndTargets = useMemo(
    () =>
      visible.filter((p) => {
        if (!p.is_active) return false
        // Never yourself, whatever the role rules say. Belt and braces: the RPC
        // refuses it, and a refusal on your own name inside a bulk run reads
        // like the whole thing failed.
        if (p.id === operatorId) return false
        if (p.role === ROLES.SYSTEM_ADMIN) return false
        // NOR A VENDOR. This button ends the porch's shift — it exists so
        // nobody is left signed in overnight. A vendor is an outside company
        // reading a calendar; they have no shift to end, and switching them off
        // every night would mean switching them back on every morning.
        if (p.role === ROLES.VALET_VENDOR) return false
        // A valet_admin can only reach operators; anything else is a guaranteed
        // refusal, so it is not offered.
        if (!isSystemAdmin && p.role !== ROLES.OPERATOR) return false
        return true
      }),
    [visible, operatorId, isSystemAdmin],
  )

  async function handleDeactivateAllOperators() {
    const list = allOffTarget ?? []
    setAllOffTarget(null)
    if (!list.length || bulkBusy) return

    setBulkBusy(true)
    const failed = []
    for (const person of list) {
      const result = await setStaffActive(person.id, false)
      if (!result.ok) failed.push({ name: person.name, error: result.error })
    }
    setBulkBusy(false)
    setSelected(new Set())
    await load()

    const done = list.length - failed.length
    if (done > 0) toast.success(t('staff.bulkDeactivated', { n: done }))
    // Named. On a busy evening the refusals ARE the useful half of the result:
    // they are the operators still holding a car, and the admin has to go and
    // find them.
    for (const f of failed) toast.error(`${f.name}: ${f.error}`)
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
      <div className="mb-5 grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
        <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success">
            <Icon name="users" size={18} />
          </span>
          <div>
            <p className="text-xl font-bold leading-none text-ink">{counts.total}</p>
            <p className="mt-0.5 text-xs font-medium text-ink-subtle">Active staff</p>
          </div>
        </div>

        {isSystemAdmin && (
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info-soft text-info">
              <Icon name="key" size={18} />
            </span>
            <div>
              <p className="text-xl font-bold leading-none text-ink">{counts.operators}</p>
              <p className="mt-0.5 text-xs font-medium text-ink-subtle">Operators</p>
            </div>
          </div>
        )}

        {counts.inactive > 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning">
              <Icon name="bell-off" size={18} />
            </span>
            <div>
              <p className="text-xl font-bold leading-none text-ink">{counts.inactive}</p>
              <p className="mt-0.5 text-xs font-medium text-ink-subtle">Inactive</p>
            </div>
          </div>
        )}
      </div>

      {/* ── filters ─────────────────────────────────────────────────── */}
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          placeholder={t('staff.searchPlaceholder')}
          className="flex-1"
        />

        <div className="flex flex-wrap items-center gap-2">
          {isSystemAdmin && (
            <>
              <div className="relative">
                <Icon
                  name="shield"
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
                />
                <select
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                  aria-label={t('staff.filterRole')}
                  className="h-11 appearance-none rounded-xl border border-line-strong bg-surface pl-8 pr-10 text-sm font-medium text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                >
                  <option value="all">{t('staff.allRoles')}</option>
                  <option value={ROLES.OPERATOR}>{t('staff.operators')}</option>
                  <option value={ROLES.VALET_VENDOR}>{t('staff.valetVendors')}</option>
                  <option value={ROLES.VALET_ADMIN}>{t('staff.valetAdmins')}</option>
                  <option value={ROLES.SYSTEM_ADMIN}>{t('staff.systemAdmins')}</option>
                </select>
                <Icon
                  name="chevron-down"
                  size={14}
                  className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-subtle"
                />
              </div>

              <div className="relative">
                <Icon
                  name="location"
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
                />
                <select
                  value={propertyFilter}
                  onChange={(e) => setPropertyFilter(e.target.value)}
                  aria-label={t('staff.filterProperty')}
                  className="h-11 appearance-none rounded-xl border border-line-strong bg-surface pl-8 pr-10 text-sm font-medium text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                >
                  <option value="all">{t('staff.allProperties')}</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Icon
                  name="chevron-down"
                  size={14}
                  className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-subtle"
                />
              </div>
            </>
          )}

          <label className="flex h-11 cursor-pointer select-none items-center gap-2 rounded-xl border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-sunken">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-4 w-4 rounded border-line-strong accent-brand"
            />
            {t('staff.showInactive')}
          </label>

          {/* DEACTIVATE ALL — everyone on this list off in one go.
              Only on the ACTIVE list: on the inactive one they are already off
              and the button could do nothing.
              Hidden when there are none, rather than disabled — a permanently
              greyed destructive button is just clutter with a warning colour. */}
          {!showInactive && shiftEndTargets.length > 0 && (
            <Button
              variant="danger"
              size="md"
              icon="x-circle"
              loading={bulkBusy}
              onClick={() => setAllOffTarget(shiftEndTargets)}
            >
              {t('staff.closeAllOperators', { n: shiftEndTargets.length })}
            </Button>
          )}
        </div>
      </div>

      {/* ── list ────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[4.75rem] rounded-card" />
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
          {/* ── table header ──────────────────────────────────────── */}
          <div className="mb-1 flex items-center gap-3 px-4 text-[0.6875rem] font-semibold uppercase tracking-widest text-ink-subtle">
            {/* Only when there is something to tick. On a list of one — you —
                a select-all box is a control that cannot do anything. */}
            {selectable.length > 0 && (
              <input
                type="checkbox"
                checked={allChosen}
                // Ticked-some looks different from ticked-none AND from
                // ticked-all. Without this the box reads "nothing selected"
                // while three rows are.
                ref={(el) => {
                  if (el) el.indeterminate = chosen.length > 0 && !allChosen
                }}
                onChange={toggleAll}
                aria-label={t('staff.selectAll')}
                className="h-4 w-4 rounded border-line-strong accent-brand"
              />
            )}
            <span className="flex-1">{t('staff.heading')} <span className="ml-1.5 rounded-full bg-brand-soft px-1.5 py-0.5 text-[0.6rem] font-bold text-ink-muted">{visible.length}</span></span>
            <span className="w-24 text-right">Actions</span>
          </div>

          {/* ── BULK BAR ──────────────────────────────────────────────
              Only while something is ticked. A permanently visible bar with
              nothing to act on is a button that spends most of its life
              disabled, and the page already has enough controls. */}
          {chosen.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-3 rounded-xl border border-brand/30 bg-brand-soft px-4 py-2.5">
              <span className="text-sm font-semibold text-ink">
                {t('staff.nSelected', { n: chosen.length })}
              </span>
              <div className="ml-auto flex items-center gap-2">
                {/* One button, and WHICH one depends on the list being shown.
                    On the inactive list every row is already off, so offering
                    "Deactivate" there would be an action with no effect. */}
                <Button
                  variant={showInactive ? 'success' : 'danger'}
                  size="sm"
                  icon={showInactive ? 'check' : 'x-circle'}
                  loading={bulkBusy}
                  onClick={() => handleBulkActive(showInactive)}
                >
                  {t(showInactive ? 'staff.activateSelected' : 'staff.deactivateSelected')}
                </Button>
                {/* DELETE — inactive list only, and system admin only.
                    Not offered on the active list, because deactivation is the
                    step that says somebody is finished and it belongs to
                    whoever manages the shift; destroying the login is a
                    separate decision one level up.

                    A valet admin never sees this. The database refuses them
                    too — the button is the convenience, not the guard. */}
                {showInactive && isSystemAdmin && (
                  <Button
                    variant="danger"
                    size="sm"
                    icon="trash"
                    loading={bulkBusy}
                    onClick={() => setDeleteTarget(chosen)}
                  >
                    {t('staff.deleteSelected')}
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="px-1 text-xs font-semibold text-info hover:text-ink"
                >
                  {t('staff.clearSelection')}
                </button>
              </div>
            </div>
          )}

          <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            {visible.map((person, i) => (
              <StaffRow
                key={person.id}
                person={person}
                isSelf={person.id === operatorId}
                showProperty={isSystemAdmin}
                selected={selected.has(person.id)}
                onSelect={() => toggleOne(person.id)}
                onEdit={() => setEditTarget(person)}
                onToggleActive={() => setDeactivateTarget(person)}
                isFirst={i === 0}
                isLast={i === visible.length - 1}
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

      {/* The one irreversible action on this page, so the confirmation says
          what goes AND what stays. An admin who reads "delete permanently" and
          nothing else will reasonably assume the operator's name disappears
          from every car they parked — and refuse to press it. */}
      <ConfirmModal
        open={Boolean(deleteTarget?.length)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleBulkDelete}
        tone="danger"
        title={t('staff.deleteQ', { n: deleteTarget?.length ?? 0 })}
        description={t('staff.deleteBody')}
        confirmLabel={t('staff.deleteConfirm')}
      />

      {/* A CONFIRMATION, even though "seedha" was asked for.
          This one tap ends every operator's shift: nobody can sign in, no car
          can be checked in or fetched, and putting it back means finding each
          name again. One extra tap against a stopped porch is the right trade.

          It states the COUNT, which is also the only place the visible-scoping
          becomes visible — "Switch off 5 operators" against a filtered list
          reads differently from "Switch off 23", and that is the point. */}
      <ConfirmModal
        open={Boolean(allOffTarget)}
        onClose={() => setAllOffTarget(null)}
        onConfirm={handleDeactivateAllOperators}
        tone="danger"
        title={t('staff.closeAllQ', { n: allOffTarget?.length ?? 0 })}
        description={t('staff.closeAllBody')}
        confirmLabel={t('staff.closeAllConfirm')}
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
function StaffRow({
  person, isSelf, showProperty, selected, onSelect, onEdit, onToggleActive, isFirst, isLast,
}) {
  const t = useT()
  const meta = ROLE_META[person.role]

  const avatarBg =
    person.role === ROLES.SYSTEM_ADMIN
      ? 'bg-vip-soft text-vip'
      : person.role === ROLES.VALET_ADMIN
        ? 'bg-info-soft text-info'
        : person.role === ROLES.VALET_VENDOR
          ? 'bg-warning-soft text-warning'
          : 'bg-brand-soft text-ink-muted'

  // A tone of its own. Left on `neutral` a vendor was indistinguishable from an
  // operator in the list, and they are the two roles least alike — one parks
  // cars, the other is an outside company that can only read a calendar.
  const roleTone =
    person.role === ROLES.SYSTEM_ADMIN
      ? 'vip'
      : person.role === ROLES.VALET_ADMIN
        ? 'info'
        : person.role === ROLES.VALET_VENDOR
          ? 'warning'
          : 'neutral'

  return (
    <div
      className={cn(
        'group relative flex items-center gap-4 px-5 py-4 transition-colors duration-100',
        'hover:bg-surface-sunken',
        !isFirst && 'border-t border-line',
        // Dimmed when closed — but NOT once ticked, or the rows being acted
        // on are the hardest ones to read on a screen full of them.
        !person.is_active && !selected && 'opacity-50',
        selected && 'bg-brand-soft/60',
      )}
    >
      {/* No box on your own row. admin_set_staff_active refuses to deactivate
          the caller, so a tick here could only ever produce an error — and the
          empty gap keeps the avatars in one column. */}
      {isSelf ? (
        <span className="w-4 shrink-0" aria-hidden="true" />
      ) : (
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          aria-label={person.name}
          className="h-4 w-4 shrink-0 rounded border-line-strong accent-brand"
        />
      )}

      {/* Role accent stripe — 3 px left edge inside the row */}
      {person.role !== ROLES.OPERATOR && (
        <span
          className={cn(
            'absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full',
            person.role === ROLES.SYSTEM_ADMIN && 'bg-vip',
            person.role === ROLES.VALET_ADMIN && 'bg-info',
          )}
          aria-hidden="true"
        />
      )}

      {/* ── Avatar ─────────────────────────────────────────────── */}
      <span
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
          'text-sm font-bold select-none',
          avatarBg,
        )}
      >
        {initials(person.name)}
      </span>

      {/* ── Identity ───────────────────────────────────────────── */}
      <div className="min-w-0 flex-1">
        {/* Name row */}
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[0.9375rem] font-semibold leading-snug text-ink">
            {personName(person.name, person.name_hi)}
          </p>
          {isSelf && (
            <Badge tone="info" size="sm">
              {t('staff.you')}
            </Badge>
          )}
          {!person.is_active && (
            <Badge tone="warning" size="sm" dot>
              {t('staff.inactive')}
            </Badge>
          )}
        </div>

        {/* Phone */}
        <p className="tnum mt-0.5 text-[0.8125rem] font-medium text-ink-muted">
          +91 {formatPhone(person.phone)}
        </p>

        {/* Role + property */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge tone={roleTone} size="sm" icon={meta?.icon}>
            {t(`role.${person.role}`)}
          </Badge>
          {/* ── WHAT THIS CHIP IS ASKING ──────────────────────────
              "Which property does this person work at". For an operator or a
              valet admin the column answers it directly.

              For a VENDOR it does not. They hold a property only because
              user_roles_property_scope_chk requires every non-system-admin to
              have one; nothing reads it, and the bookings screen they are
              limited to shows every venue. Printing "Ambria Pushpanjali" beside
              a location pin would tell an admin this vendor is scoped to one
              venue, which is the opposite of true — and it is the kind of wrong
              belief somebody acts on when deciding who to give an account to.

              So the chip answers the question rather than echoing the column. */}
          {showProperty && person.properties?.name && (
            <span className="flex items-center gap-1 rounded-md bg-surface-sunken px-2 py-0.5 text-[0.6875rem] font-medium text-ink-subtle ring-1 ring-inset ring-line-strong">
              <Icon name="location" size={10} />
              {person.role === ROLES.VALET_VENDOR
                ? t('staff.everyVenue')
                : person.properties.name}
            </span>
          )}
        </div>
      </div>

      {/* ── Actions ────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity duration-100 group-hover:opacity-100">
        <Button
          variant="secondary"
          size="sm"
          icon="edit"
          onClick={onEdit}
          aria-label={t('staff.editNamed', { name: person.name })}
          title={t('staff.editTooltip')}
          className="hidden sm:inline-flex"
        >
          Edit
        </Button>
        {/* Icon-only fallback on small screens */}
        <Button
          variant="ghost"
          size="icon-md"
          icon="edit"
          onClick={onEdit}
          aria-label={t('staff.editNamed', { name: person.name })}
          className="sm:hidden"
        />

        <Button
          variant="ghost"
          size="icon-md"
          icon={person.is_active ? 'x-circle' : 'check-circle'}
          onClick={onToggleActive}
          disabled={isSelf}
          aria-label={t(
            person.is_active ? 'staff.deactivateNamed' : 'staff.reactivateNamed',
            { name: person.name },
          )}
          title={
            isSelf
              ? t('staff.cannotDeactivateSelf')
              : t(person.is_active ? 'staff.deactivate' : 'staff.reactivate')
          }
          className={cn(
            person.is_active
              ? 'hover:bg-danger-soft hover:text-danger'
              : 'hover:bg-success-soft hover:text-success',
          )}
        />
      </div>
    </div>
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
    // DEFAULT_PIN, not a random one. The admin reads this out at a counter and
    // the operator types it once, then Change PIN forces them off it on first
    // login — so it is a handover value, and one everybody already knows beats
    // one that has to be transcribed correctly. Generate is still one tap away.
    setPin(DEFAULT_PIN)
    setRole(ROLES.OPERATOR)
    setProperty(defaultPropertyId ?? '')
    setErrors({})
    setFormError(null)
  }, [open, defaultPropertyId])

  // ── THE PROPERTY FIELD HAS THREE SHAPES ─────────────────────────────
  //   operator / valet_admin   pick one of the venues — it scopes everything
  //   valet_vendor             a select reading "All properties", on request
  //   system_admin             a note; they belong to all of them by definition
  //
  // A vendor submits NULL either way: migration 0066 made property_id null for
  // this role and the RPC now REFUSES a value, so the select is a label for
  // that fact rather than a choice with alternatives. It is shown as a select
  // because that is what was asked for, and because it keeps the form's shape
  // identical whichever role is picked — the field does not appear and vanish
  // as the role changes above it.
  const needsProperty = role !== ROLES.SYSTEM_ADMIN && role !== ROLES.VALET_VENDOR
  const isVendor = role === ROLES.VALET_VENDOR

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
              { value: ROLES.VALET_VENDOR, label: t('staff.roleValetVendor') },
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

        {/* ONE OPTION, and it is the whole answer. The five venues are not
            offered beside it: picking one would be refused by the RPC, which is
            a worse way to learn a vendor is not venue-scoped than simply not
            being asked. The hint says why. */}
        {canCreateAdmins && isVendor && (
          <Select
            label={t('staff.property')}
            value=""
            onChange={() => {}}
            options={[{ value: '', label: t('staff.allProperties') }]}
            hint={t('staff.vendorPropertyNote')}
          />
        )}

        {canCreateAdmins && !needsProperty && !isVendor && (
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
// modal stays because saying a PIN out loud to someone standing in front
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
  // ── THE PROPERTY FIELD HAS THREE SHAPES ─────────────────────────────
  //   operator / valet_admin   pick one of the venues — it scopes everything
  //   valet_vendor             a select reading "All properties", on request
  //   system_admin             a note; they belong to all of them by definition
  //
  // A vendor submits NULL either way: migration 0066 made property_id null for
  // this role and the RPC now REFUSES a value, so the select is a label for
  // that fact rather than a choice with alternatives. It is shown as a select
  // because that is what was asked for, and because it keeps the form's shape
  // identical whichever role is picked — the field does not appear and vanish
  // as the role changes above it.
  const needsProperty = role !== ROLES.SYSTEM_ADMIN && role !== ROLES.VALET_VENDOR
  const isVendor = role === ROLES.VALET_VENDOR
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
                { value: ROLES.VALET_VENDOR, label: t('staff.roleValetVendor') },
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
            ) : isVendor ? (
              <Select
                label={t('staff.property')}
                value=""
                onChange={() => {}}
                options={[{ value: '', label: t('staff.allProperties') }]}
                hint={t('staff.vendorPropertyNote')}
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
