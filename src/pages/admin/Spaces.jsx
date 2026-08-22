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
import { ConfirmModal } from '@/components/ui/Modal'
import Icon from '@/components/ui/Icon'
import {
  HeaderSkeleton,
  RowsSkeleton,
  SectionHeadingSkeleton,
  StatRowSkeleton,
} from '@/components/ui/PageSkeleton'
import StatTile, { StatRow } from '@/components/ui/StatTile'
import { useAuth } from '@/context/AuthContext'
import { ROLES } from '@/types'
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
 * The last two columns are FIXED WIDTHS, not `auto`. Each row is its own grid,
 * so `auto` is measured per row and any difference in content — a badge, a
 * longer name — would put the number boxes at a different x on that row.
 * 5.75rem is two icon-md buttons (2.75rem each) plus the gap-1 between them.
 *
 * On a phone the Hindi name drops to its own line under the place name, because
 * four columns inside 390px leaves nothing readable. From sm up it gets a column
 * of its own beside the number box.
 */
// 11rem, not 9: the Hindi column holds the field AND the convert button, so the
// field itself only gets what is left. At 9rem that was 104px, and a name like
// "किचन की दीवार के पीछे" showed as "किचन की दीवा" — readable only by clicking into it.
// Three columns, not four. The 4rem one held the per-place car limit, which
// migration 0035 removed.
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_5.75rem] items-center gap-x-3 gap-y-2 ' +
  'sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_5.75rem]'

const COLUMN_LABEL = 'text-[0.6875rem] font-bold uppercase tracking-wider text-ink-subtle'

export default function Spaces() {
  const t = useT()
  const { role, propertyId, propertyName } = useAuth()
  const toast = useToast()

  /**
   * ── ONE SCREEN, TWO ROLES ─────────────────────────────────────────────
   * A valet_admin has exactly one property and never sees a picker: `target`
   * is simply theirs. A system_admin has none of their own, so they choose,
   * and until they do there is nothing to show.
   *
   * The RPCs take the property as an argument and enforce the rule themselves
   * (migration 0035) — a valet_admin asking about someone else is refused by
   * Postgres, not by this component. What is in the browser is a convenience,
   * never the boundary.
   */
  const isSystemAdmin = role === ROLES.SYSTEM_ADMIN
  const [properties, setProperties] = useState([])
  const [chosen, setChosen] = useState('')
  const target = isSystemAdmin ? chosen : propertyId

  const [spaces, setSpaces] = useState([])
  /** The place the admin has asked to delete, until they confirm or cancel. */
  const [pendingDelete, setPendingDelete] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Only a system_admin needs this list, so only they fetch it.
  useEffect(() => {
    if (!isSystemAdmin) return
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('properties')
        .select('id, name')
        .eq('is_active', true)
        .order('name')
      if (!cancelled) setProperties(data ?? [])
    })()
    return () => {
      cancelled = true
    }
  }, [isSystemAdmin])

  const load = useCallback(async () => {
    // No property chosen yet — a system_admin who has just arrived. Not an
    // error, and not a request worth making.
    if (!target) {
      setSpaces([])
      setLoading(false)
      return
    }

    // One RPC, and it counts the cars for us. This screen and the operator's
    // chips now read the SAME function, so "in use" cannot mean two things.
    const { data, error: err } = await supabase.rpc('parking_space_usage', {
      p_property_id: target,
    })

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
        inUse: Number(s.in_use ?? 0),
        is_active: s.is_active,
        sort_order: s.sort_order,
      })),
    )
    setLoading(false)
  }, [target, t])

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
   * How many places, and how many cars are in them.
   *
   * There used to be a third pair — total capacity and spaces free — because
   * each place carried a car limit. Migration 0035 removed the limits, so
   * "37 of 60 used" has no 60 to compare against any more. What is left is
   * still the useful part: how many places exist, how many are out of service,
   * and how many cars are actually parked.
   */
  const counts = useMemo(() => {
    const live = spaces.filter((s) => s.is_active)
    return {
      places: live.length,
      off: spaces.length - live.length,
      inUse: live.reduce((n, s) => n + s.inUse, 0),
    }
  }, [spaces])

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
      const { data } = await supabase.rpc('parking_space_usage', { p_property_id: target })

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

    // Closed either way. Leaving it open on failure would hide the toast that
    // says what went wrong.
    setPendingDelete(null)

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
    /* ── ONE WIDTH FOR THE WHOLE SCREEN ───────────────────────────────────
       The shell deliberately puts no cap on a page, because a wide table wants
       every pixel. This screen does not: its widest row needs about 1170px —
       24rem for the add box, a gap, and 48rem for a list row — and past that it
       stopped being one layout.

       Measured at 1892px before this: the tiles stretched to 1620px and each one
       was 532px wide with a single digit floating in it, while the list below
       stopped at 768px. Two different right-hand edges on one screen read as
       something failing to load rather than as a deliberate measure.

       Capping HERE rather than per-block is what keeps the edges honest: the
       tiles, the two columns and the facts box all inherit it, so they cannot
       drift apart again when one of them changes. */
    <div className="max-w-[73rem]">
      <PageHeader
        title={t('spaces.title')}
        // A valet_admin has one site and the subtitle names it. A system_admin
        // picks, so the picker IS the subtitle — repeating the name underneath
        // the control that sets it is one label too many.
        subtitle={isSystemAdmin ? undefined : propertyName}
        actions={
          <Button variant="secondary" size="md" icon="refresh" onClick={load}>
            {t('common.refresh')}
          </Button>
        }
      />

      {/* ── CHIPS, not a dropdown ─────────────────────────────────────────
          A select costs two taps and hides the options until the first one.
          With four sites they all fit on one row, so choosing is one tap and
          you can see what you are choosing between.

          Same shape as the tabs on the Properties screen deliberately: this is
          the same idea — "which site am I looking at" — and it should not look
          like a different control on a different page. */}
      {isSystemAdmin && (
        <div
          role="tablist"
          aria-label={t('spaces.chooseSiteLabel')}
          // Scrolls rather than wraps: the Add property button has no limit on
          // it, and a second row of chips would push the list below the fold on
          // a phone. -mx-1 px-1 gives the focus ring on the first and last chip
          // room to draw outside the scroll container.
          className="scrollbar-none -mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1"
        >
          {properties.map((prop) => {
            const active = prop.id === chosen
            return (
              <button
                key={prop.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setChosen(prop.id)}
                className={cn(
                  // shrink-0 is what makes the row scroll instead of squeezing
                  // the names until they are unreadable.
                  'shrink-0 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-colors',
                  active
                    ? 'border-brand bg-brand text-ink-inverse'
                    : 'border-line-strong bg-surface text-ink-muted hover:text-ink',
                )}
              >
                {prop.name}
              </button>
            )
          })}
        </div>
      )}

      {/* A system_admin who has not chosen yet. Everything below needs a
          property, and rendering empty tiles and an add form that would fail
          would look broken rather than unanswered. */}
      {isSystemAdmin && !chosen && (
        <EmptyState
          icon="building"
          title={t('spaces.pickASite')}
          description={t('spaces.pickASiteBody')}
        />
      )}

      {target && (
        <>
      <StatRow className="mb-5">
        {/* Three tiles, not five. "Total spaces" and "Free" both counted
            against a per-place limit, and those limits went in migration 0035 —
            a "free" figure with nothing to be free OF would be a number the
            screen invents. */}
        <StatTile
          label={t('spaces.places')}
          value={counts.places}
          icon="parking"
          // No hint. It briefly carried spaces.notCounted — "not counted as room
          // you have" — which was written for the out-of-service tile beside it
          // and read as nonsense here, twice over since both tiles then showed
          // the same line.
        />
        <StatTile
          label={t('spaces.carsParked')}
          value={counts.inUse}
          icon="car"
          tone="info"
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
          <AddSpaces propertyId={target} onAdded={handleAdded} />
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
            /* No cap of its own any more: the page carries one, above. This was
               max-w-3xl, which was right in isolation and wrong together — it
               made the list narrower than the tiles above it. */
            <div className="space-y-4">
              {/* ROWS, not chips. A chip fits a name; it cannot also carry a
                  live car count, an editable Hindi spelling and two actions
                  without becoming unreadable. One flat list in the order the
                  admin typed them — no zones or levels, because the admin names
                  the places and this app has no business modelling their car
                  park. */}
              <div>
                {/* Headings once, instead of the word "Spaces" set beside every
                    single number box. With four places that was four labels
                    saying the same thing and no gain in clarity. */}
                <div className={cn(ROW_GRID, 'px-4 pb-2')}>
                  <span className={COLUMN_LABEL}>{t('spaces.placeColumn')}</span>
                  <span className={cn(COLUMN_LABEL, 'hidden sm:block')}>
                    {t('spaces.hindiColumn')}
                  </span>
                  <span />
                </div>

                <Card padded={false} className="divide-y divide-line">
                  {spaces.map((space) => (
                    <SpaceRow
                      key={space.id}
                      space={space}
                      onLabelHi={(v) => setLabelHi(space, v)}
                      onToggle={() => toggle(space)}
                      onRemove={() => setPendingDelete(space)}
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
      )}

      {/* The guard that replaced "take it out of service first".
          It names the place, because a mis-tapped row and the right row look
          identical once a dialog is covering the list — and it says out loud
          when cars are parked there, which is the one case where deleting
          actually costs something. */}
      <ConfirmModal
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => remove(pendingDelete)}
        title={t('spaces.deleteTitle', { place: pendingDelete?.label ?? '' })}
        description={
          pendingDelete?.inUse > 0
            ? t(
                pendingDelete.inUse === 1
                  ? 'spaces.deleteWhileParked'
                  : 'spaces.deleteWhileParked_plural',
                { place: pendingDelete.label, n: pendingDelete.inUse },
              )
            : t('spaces.deleteBody', { place: pendingDelete?.label ?? '' })
        }
        confirmLabel={t('spaces.deleteConfirm')}
      />
    </div>
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

function SpaceRow({ space, onLabelHi, onToggle, onRemove }) {
  const t = useT()

  /**
   * The Hindi name while it is being typed: writing on every keystroke would
   * fire a query per character. It commits on blur and on Enter.
   */
  const [hiDraft, setHiDraft] = useState(space.labelHi ?? '')

  // Re-synced when the row reloads, so a save made elsewhere — or the automatic
  // conversion that runs after a bulk add — shows up here instead of leaving a
  // stale draft on screen.
  useEffect(() => setHiDraft(space.labelHi ?? ''), [space.labelHi])

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

          {!space.is_active && (
            <Badge tone="neutral" size="sm">
              {t('spaces.outOfService')}
            </Badge>
          )}
        </div>

        {/* A count, not a fill bar. The bar measured cars against the place's
            limit, and with the limits gone there is no denominator to draw. */}
        <p className="tnum mt-1 text-xs text-ink-subtle">
          {t(space.inUse === 1 ? 'spaces.carsHere' : 'spaces.carsHere_plural', {
            n: space.inUse,
          })}
        </p>
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

      {/* Delete FIRST, eye LAST — deliberately, and it looks backwards until you
          see the list. Both are on every row now, and the eye is the one people
          reach for constantly, so it holds the right-hand column and delete sits
          beside it. */}
      <div className="flex items-center justify-end gap-1">
        {/* ON EVERY ROW NOW.
            It used to appear only once a place was already out of service, so
            deleting took two deliberate steps — and that WAS the confirmation,
            because remove() asks nothing before it fires. Two steps to undo a
            typo made thirty seconds ago is a bad trade, so the guard moved to
            where it belongs: a dialog that names the place, and says out loud
            when cars are parked in it. */}
        <Button
          variant="ghost"
          size="icon-md"
          icon="trash"
          onClick={onRemove}
          title={t('spaces.deleteForever')}
          aria-label={t('spaces.deleteNamed', { place: space.label })}
          // !text-danger, and the bang is NOT decoration. The ghost variant sets
          // text-ink-muted, and both are colour utilities of equal specificity, so
          // which one wins is decided by their order in the GENERATED stylesheet —
          // not by which is later in this class attribute. Measured: without the
          // bang this icon rendered rgb(71,85,105), identical to the eye beside
          // it. cn() joins strings and does not merge Tailwind conflicts.
          className="!text-danger hover:bg-danger-soft"
        />

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

function AddSpaces({ propertyId, onAdded }) {
  const t = useT()
  const toast = useToast()
  const [text, setText] = useState('')
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
      // Explicit, always. It defaults to the caller's own property in the
      // database, which is right for a valet_admin and useless for a system
      // admin — who has none.
      p_property_id: propertyId,
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
