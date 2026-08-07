/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/admin/Spaces.jsx                                    │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The list of places cars go at this property, and HOW MANY CARS each │
 * │   holds. The admin types them once here; every operator gets them as   │
 * │   chips showing the free space left (migrations 0016 + 0020,           │
 * │   ui/SpacePicker).                                                     │
 * │                                                                     │
 * │ OCCUPANCY IS COUNTED, NEVER STORED                                    │
 * │   There is no cars_parked column. parking_space_usage() counts the     │
 * │   cars actually sitting at each label, so handing a car back frees     │
 * │   its space with no counter that could drift. This screen and the      │
 * │   operator's chips read the SAME function, so "in use" cannot mean     │
 * │   two different things.                                               │
 * │                                                                     │
 * │ IT IS A NAME LIST, NOT A MODEL OF A CAR PARK                          │
 * │   No zones, no levels, no numbering scheme. Whatever the admin types  │
 * │   is what the operator taps — "Basement", "Porch", "Behind the        │
 * │   kitchen", "L2 B4". Every site is laid out differently and this app  │
 * │   has no business deciding how somebody else's car park is organised. │
 * │                                                                     │
 * │ ENTRY IS BULK                                                         │
 * │   Nobody types these one at a time. The field takes a whole list —    │
 * │   split on commas and newlines, so a pasted spreadsheet column and a  │
 * │   hand-typed line both work — and skips anything already there, so    │
 * │   re-pasting an overlapping list tops it up instead of failing.       │
 * │                                                                     │
 * │ DEACTIVATE, DO NOT DELETE — usually                                   │
 * │   A place taken out of service stops appearing on the operator's      │
 * │   screen but stays here to switch back on. Delete is offered too,     │
 * │   because a typo made during setup is not history worth keeping —     │
 * │   and it is safe, since parked_vehicles.parking_location is free      │
 * │   text and never points at this table. Past cars keep the name they   │
 * │   were parked under whatever happens here.                            │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase, context/*, components/ui/*                            │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/AppShell'
import Badge from '@/components/ui/Badge'
import Button from '@/components/ui/Button'
import Card, { CardHeader, SectionHeading } from '@/components/ui/Card'
import EmptyState from '@/components/ui/EmptyState'
import { Field } from '@/components/ui/Field'
import Icon from '@/components/ui/Icon'
import {
  HeaderSkeleton,
  RowsSkeleton,
  SectionHeadingSkeleton,
  StatRowSkeleton,
} from '@/components/ui/PageSkeleton'
import StatTile, { StatRow } from '@/components/ui/StatTile'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { useToast } from '@/context/ToastContext'
import useRealtime from '@/hooks/useRealtime'
import { supabase, describeDbError } from '@/supabase'
import { cn } from '@/utils/cn'

export default function Spaces() {
  const t = useT()
  const { propertyId, propertyName } = useAuth()
  const toast = useToast()

  const [spaces, setSpaces] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!propertyId) return

    // One RPC, and it counts the cars for us. This screen and the operator's
    // chips now read the SAME function, so "in use" cannot mean two things.
    const { data, error: err } = await supabase.rpc('parking_space_usage')

    if (err) {
      setError(describeDbError(err, t('spaces.couldNotLoadList')))
      setLoading(false)
      return
    }

    setError(null)
    setSpaces(
      (data ?? []).map((s) => ({
        id: s.id,
        label: s.label,
        capacity: Number(s.capacity ?? 1),
        inUse: Number(s.in_use ?? 0),
        is_active: s.is_active,
        sort_order: s.sort_order,
      })),
    )
    setLoading(false)
  }, [propertyId, t])

  useEffect(() => {
    load()
  }, [load])

  // The counts are live occupancy, so they go stale the moment an operator parks
  // a car. Throttled inside the hook, so a burst of check-ins is one refetch.
  useRealtime({
    channel: `spaces-usage:${propertyId}`,
    table: 'parked_vehicles',
    filter: propertyId ? `property_id=eq.${propertyId}` : undefined,
    enabled: Boolean(propertyId),
    onRefetch: load,
  })

  /**
   * Totals in CARS, not in places.
   *
   * "4 places" tells an admin nothing about whether they can take another
   * booking; "37 of 60 spaces used" does. Only active places count toward
   * capacity — a place out of service is not room you have.
   */
  const counts = useMemo(() => {
    const live = spaces.filter((s) => s.is_active)
    return {
      places: live.length,
      off: spaces.length - live.length,
      capacity: live.reduce((n, s) => n + s.capacity, 0),
      inUse: live.reduce((n, s) => n + s.inUse, 0),
      // Clamped at 0 because a stacked row can legitimately hold more cars than
      // its capacity, and "-3 free" is not a thing.
      free: Math.max(
        0,
        live.reduce((n, s) => n + Math.max(0, s.capacity - s.inUse), 0),
      ),
    }
  }, [spaces])

  async function setCapacity(space, capacity) {
    const next = Math.min(999, Math.max(1, Math.round(Number(capacity) || 1)))
    if (next === space.capacity) return

    const { error: err } = await supabase
      .from('parking_spaces')
      .update({ capacity: next })
      .eq('id', space.id)

    if (err) toast.error(describeDbError(err, t('spaces.couldNotCapacity')))
    else await load()
  }

  async function toggle(space) {
    const { error: err } = await supabase
      .from('parking_spaces')
      .update({ is_active: !space.is_active })
      .eq('id', space.id)

    if (err) toast.error(describeDbError(err, t('spaces.couldNotChange')))
    else await load()
  }

  async function remove(space) {
    const { error: err } = await supabase.from('parking_spaces').delete().eq('id', space.id)

    if (err) toast.error(describeDbError(err, t('spaces.couldNotDelete')))
    else {
      toast.success(t('spaces.removed', { place: space.label }))
      await load()
    }
  }

  if (loading) {
    return (
      <>
        <HeaderSkeleton action={false} />
        <StatRowSkeleton />
        <SectionHeadingSkeleton />
        <RowsSkeleton rows={3} height="h-20" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('spaces.title')}
        subtitle={propertyName}
        actions={
          <Button variant="secondary" size="md" icon="refresh" onClick={load}>
            {t('common.refresh')}
          </Button>
        }
      />

      {/* Totals in CARS. "4 places" does not tell an admin whether they can take
          another booking; "37 of 60 used" does. */}
      <StatRow className="mb-5">
        <StatTile
          label={t('spaces.totalSpaces')}
          value={counts.capacity}
          icon="parking"
          hint={t(counts.places === 1 ? 'spaces.acrossPlaces' : 'spaces.acrossPlaces_plural', {
            n: counts.places,
          })}
        />
        <StatTile
          label={t('spaces.carsParked')}
          value={counts.inUse}
          icon="car"
          tone="info"
          hint={t('spaces.ofTotal', { n: counts.capacity })}
        />
        <StatTile
          label={t('spaces.free')}
          value={counts.free}
          icon="check-circle"
          tone={counts.free === 0 && counts.capacity > 0 ? 'danger' : 'success'}
          hint={counts.free === 0 && counts.capacity > 0 ? t('spaces.parkIsFull') : undefined}
        />
        <StatTile
          label={t('spaces.outOfService')}
          value={counts.off}
          icon="x-circle"
          tone={counts.off > 0 ? 'warning' : 'neutral'}
          hint={counts.off > 0 ? t('spaces.notCounted') : undefined}
        />
      </StatRow>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:items-start">
        <div>
          <SectionHeading title={t('spaces.addPlaces')} icon="plus" />
          <AddSpaces onAdded={load} />
        </div>

        <div>
          <SectionHeading title={t('spaces.theList')} count={spaces.length} icon="parking" />

          {error ? (
            <EmptyState
              variant="error"
              title={t('spaces.couldNotLoadList')}
              description={error}
              action={
                <Button variant="secondary" icon="refresh" onClick={load}>
                  {t('common.tryAgain')}
                </Button>
              }
            />
          ) : spaces.length === 0 ? (
            <EmptyState
              icon="parking"
              title={t('spaces.nothingYet')}
              description={t('spaces.nothingYetBody')}
            />
          ) : (
            <div className="space-y-4">
              {/* ROWS, not chips. A chip fitted a name; it cannot also carry a
                  fill bar, a live count and an editable capacity without
                  becoming unreadable. One flat list in the order the admin typed
                  them — no zones or levels, because the admin names the places
                  and this app has no business modelling their car park. */}
              <Card padded={false} className="divide-y divide-line">
                {spaces.map((space) => (
                  <SpaceRow
                    key={space.id}
                    space={space}
                    onCapacity={(n) => setCapacity(space, n)}
                    onToggle={() => toggle(space)}
                    onRemove={() => remove(space)}
                  />
                ))}
              </Card>

              <p className="flex max-w-2xl items-start gap-2 text-xs leading-relaxed text-ink-subtle">
                <Icon name="info" size={13} className="mt-0.5 shrink-0" />
                <span>{t('spaces.explainer')}</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════
// ONE PLACE
// ═══════════════════════════════════════════════════════════════════

function SpaceRow({ space, onCapacity, onToggle, onRemove }) {
  const t = useT()

  /**
   * The capacity field is local while it is being typed.
   *
   * Writing on every keystroke would fire a query per digit and, worse, clamp
   * "20" to "2" the instant the first character landed. It commits on blur and
   * on Enter, which is when the admin has finished saying what they mean.
   */
  const [draft, setDraft] = useState(String(space.capacity))

  useEffect(() => setDraft(String(space.capacity)), [space.capacity])

  const free = Math.max(0, space.capacity - space.inUse)
  const over = space.inUse > space.capacity
  const full = free === 0
  // Capped at 100% so an over-stacked row shows a full bar rather than
  // overflowing its container.
  const pct = space.capacity > 0 ? Math.min(100, (space.inUse / space.capacity) * 100) : 0

  const commit = () => onCapacity(draft)

  return (
    <div className={cn('flex items-center gap-3 px-4 py-3', !space.is_active && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'truncate font-semibold text-ink',
              !space.is_active && 'line-through text-ink-subtle',
            )}
          >
            {space.label}
          </span>

          {space.is_active && over && (
            <Badge tone="danger" size="sm">
              {t('spaces.overCapacity', { inUse: space.inUse, capacity: space.capacity })}
            </Badge>
          )}
          {space.is_active && full && !over && (
            <Badge tone="warning" size="sm">
              {t('spaces.full')}
            </Badge>
          )}
          {!space.is_active && (
            <Badge tone="neutral" size="sm">
              {t('spaces.outOfService')}
            </Badge>
          )}
        </div>

        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-line">
            <div
              className={cn(
                'h-full rounded-full',
                over ? 'bg-danger' : full ? 'bg-warning' : 'bg-info',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="tnum text-xs text-ink-subtle">
            {space.inUse} / {space.capacity}
            {space.is_active && !full && !over && t('spaces.freeSuffix', { n: free })}
          </span>
        </div>
      </div>

      <label className="flex shrink-0 items-center gap-1.5">
        <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-ink-subtle">
          {t('spaces.spacesLabel')}
        </span>
        <input
          type="tel"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 3))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
          aria-label={t('spaces.howManyFit', { place: space.label })}
          className="tnum h-10 w-16 rounded-xl border border-line-strong bg-surface px-2 text-center text-base font-bold text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 sm:text-sm"
        />
      </label>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-md"
          // STATE, not action: an open eye means "operators can see this", a
          // crossed one means they cannot — the same way layer visibility works
          // in every design tool. Showing the action instead reads backwards to
          // anyone who has used one. The tooltip carries the action.
          icon={space.is_active ? 'eye' : 'eye-off'}
          onClick={onToggle}
          title={t(space.is_active ? 'spaces.takeOut' : 'spaces.putBack')}
          aria-label={t(space.is_active ? 'spaces.takeOutNamed' : 'spaces.putBackNamed', {
            place: space.label,
          })}
        />

        {/* Only once it is out of service, so deleting takes two deliberate
            steps. A live place is on an operator's screen right now. */}
        {!space.is_active && (
          <Button
            variant="ghost"
            size="icon-md"
            icon="x-circle"
            onClick={onRemove}
            title={t('spaces.deleteForever')}
            aria-label={t('spaces.deleteNamed', { place: space.label })}
            className="hover:bg-danger-soft hover:text-danger"
          />
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════

function AddSpaces({ onAdded }) {
  const t = useT()
  const toast = useToast()
  const [text, setText] = useState('')
  /**
   * One capacity for the whole paste, because that is how a car park is
   * described: "the basement has 20 bays", "the front row holds 6". Individual
   * places are adjusted in the list afterwards.
   */
  const [capacity, setCapacity] = useState('1')
  const [error, setError] = useState(null)

  /**
   * Split on commas AND newlines, so a pasted column from a spreadsheet and a
   * hand-typed "Basement, Porch, Front row" both work without the admin having
   * to know which one this field wanted.
   */
  const labels = useMemo(
    () =>
      text
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [text],
  )

  async function submit() {
    if (labels.length === 0) {
      setError(t('spaces.typeOne'))
      return
    }
    const tooLong = labels.find((l) => l.length > 24)
    if (tooLong) {
      setError(t('spaces.tooLong', { name: tooLong }))
      return
    }

    setError(null)
    const { data, error: err } = await supabase.rpc('add_parking_spaces', {
      p_labels: labels,
      p_capacity: Math.min(999, Math.max(1, Number(capacity) || 1)),
    })

    if (err) {
      setError(describeDbError(err, t('spaces.couldNotAdd')))
      return
    }

    const added = Number(data ?? 0)
    const skipped = labels.length - added

    // Says what was skipped rather than reporting a flat success. Re-pasting an
    // overlapping list is normal, and "added 3" when you pasted 20 needs an
    // explanation or it reads as a failure.
    toast.success(
      added === 0
        ? t('spaces.alreadyExist')
        : skipped > 0
          ? t('spaces.addedSkipped', { added, skipped })
          : t(added === 1 ? 'spaces.added' : 'spaces.added_plural', { n: added }),
    )

    setText('')
    await onAdded()
  }

  return (
    <Card className="mb-5">
      <CardHeader
        icon="parking"
        title={t('spaces.typeThePlaces')}
        subtitle={t('spaces.typeThePlacesBody')}
      />

      <div className="mt-4 space-y-3">
        <Field
          label={t('spaces.howManyEach')}
          htmlFor="space-capacity"
          hint={t('spaces.howManyEachHint')}
        >
          <input
            id="space-capacity"
            type="tel"
            inputMode="numeric"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value.replace(/\D/g, '').slice(0, 3))}
            className="tnum h-touch w-24 rounded-xl border border-line-strong bg-surface px-4 text-center text-lg font-bold text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
        </Field>

        <Field label={t('spaces.placeNames')} htmlFor="space-names" error={error}>
          <textarea
            id="space-names"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (error) setError(null)
            }}
            rows={7}
            // Deliberately mixed examples. This app does not decide how a car
            // park is organised — a name is whatever the admin says it is.
            placeholder={'Basement\nPorch\nFront row\nBehind the kitchen\nL2 B4'}
            className={cn(
              'w-full rounded-xl border bg-surface px-4 py-3',
              'text-base font-semibold text-ink outline-none',
              'placeholder:font-normal placeholder:text-ink-subtle',
              error
                ? 'border-danger focus:border-danger'
                : 'border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20',
            )}
          />
        </Field>

        {labels.length > 0 && (
          <p className="flex items-center gap-2 text-xs text-ink-subtle">
            <Badge tone="info" size="sm">
              {labels.length}
            </Badge>
            {t(labels.length === 1 ? 'spaces.toAdd' : 'spaces.toAdd_plural')}
            {t('spaces.totalSuffix', {
              n: labels.length * Math.max(1, Number(capacity) || 1),
            })}
          </p>
        )}

        <Button
          variant="primary"
          fullWidth
          icon="plus"
          onClick={submit}
          loadingText={t('spaces.adding')}
        >
          {labels.length === 0
            ? t('spaces.addButtonEmpty')
            : t(labels.length === 1 ? 'spaces.addButton' : 'spaces.addButton_plural', {
                n: labels.length,
              })}
        </Button>
      </div>
    </Card>
  )
}
