/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/SpacePicker.jsx                             │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   "Where did you park it?" as a row of tappable chips instead of a   │
 * │   text field. The places come from parking_spaces — whatever the      │
 * │   admin calls them, typed once (migration 0016).                      │
 * │                                                                     │
 * │ WHY CHIPS                                                            │
 * │   Typing was the slowest step in the whole operator flow — a phone    │
 * │   keyboard, on a porch, two hundred times a shift. It also produced   │
 * │   four different spellings of one place, so nothing could ever be     │
 * │   searched or counted by location afterwards.                         │
 * │   A tap is one action and spells it the same way every time.          │
 * │                                                                     │
 * │ ── THE TWO FALLBACKS, AND WHY NEITHER IS OPTIONAL ────────────────────│
 * │                                                                     │
 * │   NOTHING DEFINED YET → a plain text field.                          │
 * │     A brand-new property has an empty list. If chips were the only    │
 * │     way, the first car of a new site could not be checked in until an │
 * │     admin had finished data entry — so the field is still there, with │
 * │     a line telling the admin where to fix it.                         │
 * │                                                                     │
 * │   "SOMEWHERE ELSE" → reveals the text field.                          │
 * │     Cars get left on the ramp, in the porch, behind the kitchen. A    │
 * │     picker that cannot express that would get the nearest wrong one   │
 * │     tapped instead, which is worse than free text: it reads as        │
 * │     precise and is not.                                              │
 * │                                                                     │
 * │ EVERY CHIP CARRIES ITS FREE SPACE, AND A FULL ONE IS DISABLED          │
 * │   "Basement 3 free", "Porch FULL". The count comes from                │
 * │   parking_space_usage() (migration 0020), which COUNTS the cars        │
 * │   actually at that label rather than reading a stored total — so       │
 * │   handing a car back frees its place with no bookkeeping to get wrong. │
 * │                                                                     │
 * │ ── WHY "SOMEWHERE ELSE" IS NOW LOAD-BEARING, NOT A CONVENIENCE ───────│
 * │   A full chip cannot be tapped. It used to be tappable on purpose:     │
 * │   valets stack and double-park, and a picker that refuses the honest   │
 * │   answer gets the nearest WRONG place tapped instead — which is worse  │
 * │   than a bad count, because then nobody can find the car.              │
 * │                                                                     │
 * │   That risk did not disappear when the chip was disabled; it moved.    │
 * │   The free-text escape hatch is what absorbs it, so it MUST stay       │
 * │   reachable, and a line under the chips points at it whenever          │
 * │   something is full. Remove either and a stacked car goes unrecorded.  │
 * │                                                                     │
 * │   A chip that is ALREADY the chosen value stays enabled even once it   │
 * │   fills up — otherwise re-opening a re-park card would disable the     │
 * │   chip it is showing as selected.                                      │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   operator/CheckIn (the park step), operator/MyTasks (park and        │
 * │   re-park)                                                           │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/supabase, context/AuthContext, ui/Field, ui/Icon               │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Field } from '@/components/ui/Field'
import Icon from '@/components/ui/Icon'
import { Skeleton } from '@/components/ui/Spinner'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { supabase } from '@/supabase'
import { cn } from '@/utils/cn'
import { placeName } from '@/utils/format'

/**
 * Loads this property's spaces, and which of them currently hold a car.
 *
 * Exported so a screen with several pickers on it (My Tasks with three parking
 * cards) fetches once instead of once per card.
 */
export function useParkingSpaces() {
  const { propertyId } = useAuth()
  const [spaces, setSpaces] = useState(null)

  const load = useCallback(async () => {
    if (!propertyId) return

    // One RPC, and it does the counting. It used to be two queries — the space
    // list, plus every parked car's location to count in JavaScript — which is
    // both a bigger payload and a second definition of "in use" that could
    // drift from the admin screen's. parking_space_usage() is the only one now.
    const { data, error } = await supabase.rpc('parking_space_usage')

    // An empty list is a valid answer — a new property has none yet — so a
    // failure and "none defined" must NOT look the same. null means "could not
    // load"; the picker falls back to a text field for either.
    if (error) {
      console.warn('[spaces] could not load parking spaces:', error.message)
      setSpaces(null)
      return
    }

    // Only active places reach the operator. The admin screen shows the rest.
    setSpaces(
      (data ?? [])
        .filter((s) => s.is_active)
        .map((s) => ({
          id: s.id,
          // label stays the CANONICAL name and is what gets written to
          // parked_vehicles.parking_location. labelHi is for reading only —
          // storing the Hindi would break the occupancy match, which compares
          // against `label`. See migration 0029.
          label: s.label,
          labelHi: s.label_hi ?? null,
          capacity: Number(s.capacity ?? 1),
          inUse: Number(s.in_use ?? 0),
        })),
    )
  }, [propertyId])

  useEffect(() => {
    load()
  }, [load])

  return { spaces, reload: load }
}

export default function SpacePicker({
  value,
  onChange,
  spaces,
  error,
  label,
  id = 'space-picker',
  autoFocus = false,
}) {
  const t = useT()
  /** Free text is showing, either by choice or because there are no chips. */
  const [manual, setManual] = useState(false)

  const hasChips = Boolean(spaces?.length)
  // A value that is not one of the chips came from free text, so keep the field
  // open — otherwise editing a re-park would silently discard it.
  const valueIsChip = useMemo(
    () => Boolean(value) && (spaces ?? []).some((s) => s.label === value),
    [spaces, value],
  )
  const showManual = manual || !hasChips || (Boolean(value) && !valueIsChip)

  if (spaces === undefined) {
    return <Skeleton className="h-24 w-full rounded-xl" />
  }

  return (
    <Field label={label ?? t('tasks.whereParked')} htmlFor={showManual ? id : undefined} error={error}>
      {hasChips && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {spaces.map((space) => {
              const selected = value === space.label
              // What the operator READS. `space.label` stays what gets SAVED —
              // onChange below, the comparison above, and the free-text box all
              // use the English label, because that is what the occupancy count
              // and every stored parking_location match on.
              const shown = placeName(space.label, space.labelHi)
              const free = Math.max(0, space.capacity - space.inUse)
              // A place already selected stays selectable even if it has since
              // filled up. Otherwise re-opening a re-park card would disable the
              // very chip it is showing as chosen, and the operator could not
              // save without changing an answer that was correct.
              const full = free === 0 && !selected

              return (
                <button
                  key={space.id}
                  type="button"
                  disabled={full}
                  onClick={() => {
                    if (full) return
                    onChange(space.label)
                    setManual(false)
                  }}
                  aria-pressed={selected}
                  // Full is announced, not implied by colour alone — and the
                  // announcement says it cannot be chosen, because a disabled
                  // control that does not explain itself reads as a broken one.
                  aria-label={
                    full
                      ? t('places.fullLabel', {
                          place: shown,
                          inUse: space.inUse,
                          capacity: space.capacity,
                        })
                      : `${shown}, ${free} of ${space.capacity} free`
                  }
                  className={cn(
                    // min-h-11 is the tap target, not the text size. This chip is
                    // tapped two hundred times a shift, one-handed, while holding
                    // car keys.
                    'inline-flex min-h-11 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold transition-colors',
                    selected
                      ? 'bg-brand text-ink-inverse'
                      : full
                        ? // FULL IS NOT SELECTABLE.
                          //
                          // It used to be, deliberately: valets stack and
                          // double-park, and a picker that refuses the honest
                          // answer gets the nearest WRONG place tapped instead,
                          // which is worse than a bad count — nobody can find
                          // the car. That risk has not gone away, so the escape
                          // hatch below is now load-bearing: "Somewhere else"
                          // must stay, and the note under the chips points at it.
                          'cursor-not-allowed border border-dashed border-line-strong bg-surface-sunken text-ink-subtle opacity-60'
                        : 'border border-line-strong bg-surface text-ink hover:bg-surface-sunken',
                  )}
                >
                  {selected && <Icon name="check" size={14} strokeWidth={2.5} />}
                  {shown}

                  <span
                    className={cn(
                      'tnum rounded-md px-1.5 py-0.5 text-[0.6875rem] font-bold leading-none',
                      selected
                        ? 'bg-white/20'
                        : full
                          ? 'bg-line text-ink-subtle'
                          : 'bg-brand-soft text-ink-muted',
                    )}
                  >
                    {full ? t('places.full') : t('places.free', { n: free })}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Only when it is relevant. A standing instruction nobody needs is
              read once and then never again, including on the shift where it
              matters. */}
          {spaces.some((s) => s.capacity - s.inUse <= 0 && value !== s.label) && (
            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-subtle">
              <Icon name="info" size={13} className="mt-0.5 shrink-0" />
              <span>{t('places.someFull')}</span>
            </p>
          )}

          {!showManual && (
            <button
              type="button"
              onClick={() => {
                setManual(true)
                onChange('')
              }}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3.5 text-sm font-medium text-info hover:bg-info-soft"
            >
              <Icon name="edit" size={14} />
              {t('places.somewhereElse')}
            </button>
          )}
        </div>
      )}

      {showManual && (
        <div className={hasChips ? 'mt-3' : undefined}>
          <input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t('places.otherPlaceholder')}
            autoCapitalize="characters"
            autoFocus={autoFocus}
            maxLength={60}
            className={cn(
              'h-touch w-full rounded-xl border bg-surface px-4',
              'text-base font-semibold uppercase text-ink outline-none',
              'placeholder:font-normal placeholder:normal-case placeholder:text-ink-subtle',
              error
                ? 'border-danger focus:border-danger'
                : 'border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20',
            )}
          />

          {hasChips ? (
            <button
              type="button"
              onClick={() => {
                setManual(false)
                onChange('')
              }}
              className="mt-2 text-xs font-semibold text-info hover:text-ink"
            >
              {t('places.backToList')}
            </button>
          ) : (
            <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink-subtle">
              <Icon name="info" size={13} className="mt-0.5 shrink-0" />
              <span>
                {t('places.noneSetUp')}
              </span>
            </p>
          )}
        </div>
      )}
    </Field>
  )
}
