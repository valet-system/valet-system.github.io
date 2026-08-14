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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { hindiNameFor } from '@/lib/hindiText'
import { supabase, describeDbError } from '@/supabase'
import { cn } from '@/utils/cn'

/**
 * The heading row and every place row share this, so the number boxes line up
 * down the list instead of each row finding its own edge.
 *
 * The last two columns are FIXED WIDTHS, not `auto`, and that is the whole
 * point: each row is its own grid, so `auto` is measured per row — and the
 * delete button only exists on out-of-service rows. With `auto` the number
 * boxes would sit at a different x on those rows. 5.75rem is two icon-md
 * buttons (2.75rem each) plus the gap-1 between them.
 *
 * On a phone the Hindi name drops to its own line under the place name, because
 * four columns inside 390px leaves nothing readable. From sm up it gets a column
 * of its own beside the number box.
 */
// 11rem, not 9: the Hindi column holds the field AND the convert button, so the
// field itself only gets what is left. At 9rem that was 104px, and a name like
// "किचन की दीवार के पीछे" showed as "किचन की दीवा" — readable only by clicking into it.
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_4rem_5.75rem] items-center gap-x-3 gap-y-2 ' +
  'sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_4rem_5.75rem]'

const COLUMN_LABEL = 'text-[0.6875rem] font-bold uppercase tracking-wider text-ink-subtle'

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
        labelHi: s.label_hi ?? null,
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

  /**
   * Ids already put through transliteration this session, whether it worked.
   *
   * Without this, a place whose conversion FAILS — offline, or a label the
   * service cannot read — would be retried on every single reload, and this
   * screen reloads on every check-in at the property.
   */
  const triedHi = useRef(new Set())

  /**
   * Fills in the Hindi name for any place that has none.
   *
   * ── WHY IT RUNS HERE AND NOT AT ADD TIME ──
   *   add_parking_spaces returns a COUNT, not the rows it created, so the add
   *   handler has no ids to attach a Hindi name to. Reacting to the reloaded
   *   list instead needs no change to that function — and it does something
   *   better: places added before this feature existed get filled in too, which
   *   is the whole reason "back side" was showing on a Hindi screen.
   *
   * ── WHY SEQUENTIAL ──
   *   A pasted list can be twenty places. Twenty parallel calls to the
   *   transliteration service is how you get rate-limited and end up with
   *   nothing.
   */
  useEffect(() => {
    const pending = spaces.filter((s) => !s.labelHi && !triedHi.current.has(s.id))
    if (pending.length === 0) return

    let cancelled = false

    ;(async () => {
      let wrote = 0
      for (const space of pending) {
        // Marked before awaiting, so a reload arriving mid-flight cannot start a
        // second pass over the same place.
        triedHi.current.add(space.id)

        const hi = await hindiNameFor(space.label)
        if (cancelled) return
        // null means the label was already Devanagari, or the lookup failed.
        // Either way, leave it: English is a fine fallback and the admin can
        // type it or press the refresh button.
        if (!hi) continue

        const { error: err } = await supabase.rpc('admin_set_space_label_hi', {
          p_space_id: space.id,
          p_label_hi: hi,
        })
        if (!err) wrote += 1
      }
      // One reload for the batch, and only if something changed — otherwise this
      // effect would re-run itself for nothing.
      if (!cancelled && wrote > 0) await load()
    })()

    return () => {
      cancelled = true
    }
  }, [spaces, load])

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

  /**
   * Called after a bulk add, with the label -> Hindi map the form built while the
   * admin was typing.
   *
   * The Hindi is saved BEFORE load(), deliberately. The backfill effect above
   * reacts to `spaces`, so reloading first would let it start converting these
   * very labels a second time — two network calls each and a race over who
   * writes last. Saving first means the effect sees them already filled and
   * skips them.
   */
  async function handleAdded(hindiByLabel = {}) {
    const pairs = Object.entries(hindiByLabel).filter(([, hi]) => hi)

    if (pairs.length > 0) {
      // Read fresh rather than using `spaces`: the rows were created a moment
      // ago by add_parking_spaces and are not in state yet.
      const { data } = await supabase.rpc('parking_space_usage')

      for (const [label, hi] of pairs) {
        const row = (data ?? []).find((s) => s.label === label && !s.label_hi)
        if (!row) continue
        await supabase.rpc('admin_set_space_label_hi', {
          p_space_id: row.id,
          p_label_hi: hi,
        })
      }
    }

    await load()
  }

  /**
   * The Hindi spelling. Written through an RPC rather than a table update,
   * because parking_spaces has no policy that lets an admin write it — the same
   * reason admin_set_staff_name_hi exists. See migration 0029.
   */
  async function setLabelHi(space, labelHi) {
    if ((labelHi ?? '') === (space.labelHi ?? '')) return

    const { error: err } = await supabase.rpc('admin_set_space_label_hi', {
      p_space_id: space.id,
      p_label_hi: labelHi || null,
    })

    if (err) toast.error(describeDbError(err, t('spaces.couldNotHindi')))
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

      <div className="grid gap-5 xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] xl:items-start">
        {/* Sticky on wide screens so a long list can be scrolled while the box
            you type into stays put. top-20 clears the h-16 app header — the
            desktop sidebar pins itself at top-16 for the same reason. */}
        <div className="xl:sticky xl:top-20">
          <SectionHeading title={t('spaces.addPlaces')} icon="plus" />
          <AddSpaces onAdded={handleAdded} />
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
            /* Capped, because a row needs about this much and no more. Left to
               fill an xl screen it became a name pinned to one edge and a number
               box pinned to the other with a hand-width of nothing between them,
               which reads as two unrelated controls rather than one row. */
            <div className="max-w-3xl space-y-4">
              {/* ROWS, not chips. A chip fitted a name; it cannot also carry a
                  fill bar, a live count and an editable capacity without
                  becoming unreadable. One flat list in the order the admin typed
                  them — no zones or levels, because the admin names the places
                  and this app has no business modelling their car park. */}
              <div>
                {/* Headings once, instead of the word "Spaces" set beside every
                    single number box. With four places that was four labels
                    saying the same thing and no gain in clarity. */}
                <div className={cn(ROW_GRID, 'px-4 pb-2')}>
                  <span className={COLUMN_LABEL}>{t('spaces.placeColumn')}</span>
                  <span className={cn(COLUMN_LABEL, 'hidden sm:block')}>
                    {t('spaces.hindiColumn')}
                  </span>
                  <span className={cn(COLUMN_LABEL, 'text-center')}>
                    {t('spaces.capacityColumn')}
                  </span>
                  <span />
                </div>

                <Card padded={false} className="divide-y divide-line">
                  {spaces.map((space) => (
                    <SpaceRow
                      key={space.id}
                      space={space}
                      onCapacity={(n) => setCapacity(space, n)}
                      onLabelHi={(v) => setLabelHi(space, v)}
                      onToggle={() => toggle(space)}
                      onRemove={() => remove(space)}
                    />
                  ))}
                </Card>
              </div>

              {/* Four facts, one per line. As a single paragraph this was four
                  lines of small grey prose, and the one you needed was never
                  the first — so it got skipped whole. */}
              {/* The BOX is full width so its right edge lines up with the list
                  above it; the TEXT inside is held to a readable measure. Capping
                  the box instead left it visibly short of the card, which looked
                  like a mistake rather than a reading width. */}
              <div className="rounded-xl border border-line bg-surface-sunken/60 px-3.5 py-3">
                <p className={cn(COLUMN_LABEL, 'mb-2 flex items-center gap-1.5')}>
                  <Icon name="info" size={12} />
                  {t('spaces.howThisWorks')}
                </p>
                <ul className="max-w-2xl space-y-1.5 text-xs leading-relaxed text-ink-muted">
                  <Fact>{t('spaces.explainCapacity')}</Fact>
                  <Fact>{t('spaces.explainLive')}</Fact>
                  <Fact>{t('spaces.explainFull')}</Fact>
                  <Fact>{t('spaces.explainEye')}</Fact>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/** One line of the "how this works" note. */
function Fact({ children }) {
  return (
    <li className="flex gap-2">
      {/* bg-ink-subtle, not bg-line-strong: at 4px the lighter tone rendered as
          almost nothing and the lines read as an unbulleted block. */}
      <span aria-hidden="true" className="mt-[0.4rem] h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
      <span>{children}</span>
    </li>
  )
}

// ═══════════════════════════════════════════════════════════════════
// ONE PLACE
// ═══════════════════════════════════════════════════════════════════

function SpaceRow({ space, onCapacity, onLabelHi, onToggle, onRemove }) {
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

  /**
   * The Hindi name while it is being typed, for the same reason as the capacity
   * above: writing on every keystroke would fire a query per character.
   * It commits on blur and on Enter.
   */
  const [hiDraft, setHiDraft] = useState(space.labelHi ?? '')

  // Re-synced when the row reloads, so a save made elsewhere — or the automatic
  // conversion that runs after a bulk add — shows up here instead of leaving a
  // stale draft on screen.
  useEffect(() => setHiDraft(space.labelHi ?? ''), [space.labelHi])

  const free = Math.max(0, space.capacity - space.inUse)
  const over = space.inUse > space.capacity
  const full = free === 0
  // Capped at 100% so an over-stacked row shows a full bar rather than
  // overflowing its container.
  const pct = space.capacity > 0 ? Math.min(100, (space.inUse / space.capacity) * 100) : 0

  const commit = () => onCapacity(draft)

  return (
    <div className={cn(ROW_GRID, 'px-4 py-3', !space.is_active && 'opacity-60')}>
      <div className="min-w-0">
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
          {/* Fills the row. No max-width: capping it at 14rem left a hand-width
              of nothing between the count and the number box, which is exactly
              the disconnected look the width cap was meant to fix. The card's
              own max-w-3xl already stops this getting silly. */}
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
            <div
              className={cn(
                'h-full rounded-full',
                over ? 'bg-danger' : full ? 'bg-warning' : 'bg-info',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="tnum shrink-0 text-xs text-ink-subtle">
            {space.inUse} / {space.capacity}
            {space.is_active && !full && !over && t('spaces.freeSuffix', { n: free })}
          </span>
        </div>
      </div>

      {/* ── the Hindi name ────────────────────────────────────────────────
          Editable, and that is the point. Transliteration of Indian place names
          is right often enough to be worth doing and wrong often enough that a
          read-only guess would be worse than English — "back side" can come back
          as something an operator reads twice. So the app fills it in and the
          admin fixes what it got wrong.

          Empty is allowed and means "no Hindi spelling": every reader falls back
          to the English label. */}
      <div className="col-span-3 flex items-center gap-1 sm:col-span-1">
        <input
          type="text"
          value={hiDraft}
          onChange={(e) => setHiDraft(e.target.value.slice(0, 40))}
          onBlur={() => onLabelHi(hiDraft.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
          placeholder={space.label}
          // A long Hindi name — "किचन की दीवार के पीछे" — is wider than this column
          // on a desktop. Widening the column would steal it from the place name,
          // which matters more, so hover shows the rest instead. On a phone the
          // field is full width and nothing is cut.
          title={hiDraft || space.label}
          aria-label={t('spaces.hindiFor', { place: space.label })}
          className="h-10 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-2.5 text-sm text-ink outline-none placeholder:text-ink-subtle focus:border-brand focus:ring-2 focus:ring-brand/20"
        />

        {/* Re-runs the conversion. Needed because the automatic one happens once,
            when the place is added — an admin who clears the box, or who renamed
            the place in the database, has no other way to get it back. */}
        <Button
          variant="ghost"
          size="icon-sm"
          icon="refresh"
          onClick={async () => {
            const hi = await hindiNameFor(space.label)
            if (!hi) return
            setHiDraft(hi)
            onLabelHi(hi)
          }}
          title={t('spaces.convertAgain')}
          aria-label={t('spaces.convertAgainNamed', { place: space.label })}
          className="shrink-0"
        />
      </div>

      {/* No visible label of its own — the column heading above the list says
          "Spaces" once. aria-label still names the PLACE, which a shared column
          heading cannot do, so screen readers get "How many cars fit in
          Basement" rather than a bare "Spaces". */}
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
        className="tnum h-10 w-full rounded-xl border border-line-strong bg-surface px-2 text-center text-base font-bold text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 sm:text-sm"
      />

      {/* Delete FIRST, eye LAST — deliberately, and it looks backwards until you
          see the list. The eye is on every row; delete is on the rare
          out-of-service one. Putting delete last pushed the eye left on exactly
          those rows, so the one control present everywhere was the one that
          failed to line up, and it read as a rendering fault. Ordered this way
          the eye holds its column and delete reads as inserted beside it. */}
      <div className="flex items-center justify-end gap-1">
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
   * label -> Hindi spelling, built while the admin is still typing.
   *
   * Shown below the box so the conversion is visible BEFORE anything is
   * created, and handed to onAdded so the same values are what get saved —
   * converting again after the insert would double every network call.
   */
  const [hindi, setHindi] = useState({})

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

  /**
   * Converts anything new, 400ms after typing stops.
   *
   * Debounced because this runs on every keystroke of a twenty-line paste, and
   * sequential because twenty parallel calls to the transliteration service is
   * how you get rate-limited and end up with none of them.
   */
  useEffect(() => {
    const missing = labels.filter((l) => !(l in hindi))
    if (missing.length === 0) return

    let cancelled = false
    const timer = setTimeout(async () => {
      for (const label of missing) {
        const hi = await hindiNameFor(label)
        if (cancelled) return
        // Recorded even when null, so a label the service cannot read is not
        // retried on the next keystroke. null renders as "no Hindi".
        setHindi((prev) => ({ ...prev, [label]: hi }))
      }
    }, 400)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [labels, hindi])

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
    // The map goes with it: the page saves these rather than converting again.
    await onAdded(hindi)
    setHindi({})
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
            rows={5}
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

        {/* What will actually be created. Read-only on purpose: corrections
            belong in the list on the right, where they persist and where every
            place — not only the ones being added right now — can be fixed. */}
        {labels.length > 0 && (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-line bg-surface-sunken/60 px-3 py-2">
            {labels.map((label) => (
              <p key={label} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-ink-muted">{label}</span>
                <Icon name="chevron-right" size={12} className="shrink-0 text-ink-subtle" />
                <span className="min-w-0 flex-1 truncate font-medium text-ink">
                  {hindi[label] === undefined ? '…' : (hindi[label] ?? '—')}
                </span>
              </p>
            ))}
          </div>
        )}

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
