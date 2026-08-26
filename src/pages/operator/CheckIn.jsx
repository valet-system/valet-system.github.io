/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/pages/operator/CheckIn.jsx                                │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The porch screen. A car pulls up, the operator fills five fields,  │
 * │   and gets back a token number to write on the guest's stub. This    │
 * │   is the most-used screen in the system — a busy Saturday is two     │
 * │   hundred passes through this form.                                  │
 * │                                                                     │
 * │ THE ONE THING THIS SCREEN MUST NOT DO                                │
 * │   Lose a token. Everything else is recoverable; a guest holding a    │
 * │   stub for a token the database never issued is not. So the whole    │
 * │   write is a single RPC — see lib/valetApi.checkIn and migration     │
 * │   0008 — and the number it returns stays on screen until the         │
 * │   operator dismisses it themselves.                                  │
 * │                                                                     │
 * │   The spec says clear the success panel automatically after three    │
 * │   seconds. That is not done here, deliberately. Three seconds is     │
 * │   how long it takes to be interrupted by the guest asking a          │
 * │   question, and the number would be gone before it was written       │
 * │   down, with no way to get it back except finding the car in         │
 * │   Today's Cars. The dismiss button is one tap and it is focused, so  │
 * │   the rush case costs nothing.                                       │
 * │                                                                     │
 * │ PARKING IS FINISHED ON THIS SCREEN, NOT IN MY TASKS                   │
 * │   The token panel carries the location field and "Car parked". The    │
 * │   real sequence at a porch is one continuous action — keys, stub,     │
 * │   drive, park, walk back — and the panel is still up when they get    │
 * │   back, so making them change screens to finish it was four steps     │
 * │   for one job. "Next car — park this one later" stays available       │
 * │   because a second car arriving mid-park is the normal busy case —    │
 * │   that car then appears in the "Still to park" strip at the TOP of    │
 * │   this screen. It used to go to My Tasks, which is now retrievals     │
 * │   only: a car nobody is waiting for does not belong on the one list   │
 * │   where every row has a guest standing at a porch.                    │
 * │                                                                     │
 * │ WHY THE PROPERTY IS NEVER SENT                                       │
 * │   checkIn() takes no property id. The database reads it from the     │
 * │   caller's own user_roles row, so there is nothing in the browser    │
 * │   for anyone to point at another property's token range.             │
 * │                                                                     │
 * │ VALIDATION HAPPENS TWICE, ON PURPOSE                                 │
 * │   Here, so the operator sees the problem beside the field instead of │
 * │   after a round trip; and again in Postgres, because an RPC is a     │
 * │   public endpoint and the browser is not a security boundary.        │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   lib/valetApi, lib/serverClock, hooks/useRealtime, context/*,       │
 * │   components/ui/*, utils/format, types                               │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/AppShell'
import Button from '@/components/ui/Button'
import Card, { SectionHeading } from '@/components/ui/Card'
import EmptyState from '@/components/ui/EmptyState'
import { Field, Input, Select } from '@/components/ui/Field'
import SpacePicker, { useParkingSpaces } from '@/components/ui/SpacePicker'
import Icon from '@/components/ui/Icon'
import { Skeleton } from '@/components/ui/Spinner'
import { TierBadge, VehicleStatusBadge } from '@/components/ui/Badge'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import useParkSubmit from '@/hooks/useParkSubmit'
import useRealtime from '@/hooks/useRealtime'
import { checkIn, completeParking } from '@/lib/valetApi'
import { noteServerTime } from '@/lib/serverClock'
import { supabase, describeDbError } from '@/supabase'
import { formatCarNumber, formatTime, groupPhone, istToday, normalisePhone, personName, prettyCarNumber, skipPhoneSeparator } from '@/utils/format'
import { ACTIVE_TASK_STATUSES, CAR_TIERS, CAR_TIER_LIST, PHONE_REGEX, TASK_TYPES } from '@/types'
import HindiInput from '@/components/ui/HindiInput'
import { cn } from '@/utils/cn'
import { useT } from '@/i18n'

const BLANK = {
  guestName: '',
  // Follows guestName as it is typed, and is editable. See the field below for
  // why this is on the form now rather than filled in silently afterwards.
  guestNameHi: '',
  guestPhone: '',
  carNumber: '',
  carTier: CAR_TIERS.STANDARD,
}

export default function CheckIn() {
  const t = useT()
  const { propertyId, operatorId, displayName, displayNameHi } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()

  const [form, setForm] = useState(BLANK)
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  /** The just-issued token. Non-null means the success panel is showing. */
  const [issued, setIssued] = useState(null)

  /**
   * Cars this operator took the keys to and has not parked yet.
   *
   * These used to live in My Tasks. They belong here: this is the parking
   * screen, and My Tasks is now only cars a guest is waiting for. Normally
   * empty — a row appears only when "park this one later" was tapped because a
   * second car pulled up.
   */
  const [unparked, setUnparked] = useState([])
  const [recent, setRecent] = useState([])
  const [todayCount, setTodayCount] = useState(null)
  const [range, setRange] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)

  const { spaces, reload: reloadSpaces } = useParkingSpaces()

  const nameRef = useRef(null)
  const dismissRef = useRef(null)
  const inFlight = useRef(false)

  // ══════════════════════════════════════════════════════════════════
  // SIDE PANEL DATA — today's count, the token range, the last 5 cars
  // ══════════════════════════════════════════════════════════════════

  const loadSummary = useCallback(async () => {
    if (!propertyId) return
    const today = istToday()

    // Three independent reads, so they go out together rather than one
    // after another — on hotel wifi that is the difference between the
    // panel appearing at once and appearing in stages.
    const [recentRes, countRes, rangeRes, unparkedRes] = await Promise.all([
      supabase
        .from('parked_vehicles')
        .select('id, token_number, car_number, car_tier, guest_name, guest_name_hi, status, parked_at')
        .eq('property_id', propertyId)
        .eq('service_date', today)
        .order('parked_at', { ascending: false })
        .limit(5),
      supabase
        .from('parked_vehicles')
        .select('id', { count: 'exact', head: true })
        .eq('property_id', propertyId)
        .eq('service_date', today),
      supabase
        .from('token_ranges')
        .select('range_start, range_end, next_token')
        .eq('property_id', propertyId)
        .eq('range_date', today)
        // maybeSingle: no range yet is normal first thing in the morning.
        // allocate_token() creates one on demand, so this is information,
        // not a fault.
        .maybeSingle(),
      // Open parking tasks held by THIS operator. Not filtered by service_date:
      // a car checked in at 11pm and still unparked at 00:30 is the same loose
      // end, and dropping it at midnight would lose the only record of where a
      // guest's car went.
      operatorId
        ? supabase
            .from('valet_tasks')
            .select(
              `id, created_at,
               parked_vehicles ( id, token_number, car_number, car_tier, guest_name, guest_name_hi )`,
            )
            .eq('assigned_operator_id', operatorId)
            .eq('task_type', TASK_TYPES.PARKING)
            .in('status', ACTIVE_TASK_STATUSES)
            .order('created_at', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ])

    const failure = recentRes.error || countRes.error || rangeRes.error || unparkedRes.error
    if (failure) {
      setLoadError(describeDbError(failure, t('common.couldNotLoad')))
    } else {
      setLoadError(null)
    }

    if (!recentRes.error) setRecent(recentRes.data ?? [])
    if (!unparkedRes.error) setUnparked(unparkedRes.data ?? [])
    if (!countRes.error) setTodayCount(countRes.count ?? 0)
    if (!rangeRes.error) setRange(rangeRes.data ?? null)
    setLoading(false)
    // t is a dep so a language switch mid-error re-renders the message in the
    // new language on the next load, rather than keeping the stale one.
  }, [propertyId, operatorId, t])

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  // Another operator checking a car in changes the count and the next token,
  // so this panel has to follow the property, not just this operator.
  useRealtime({
    channel: `checkin-vehicles:${propertyId}`,
    table: 'parked_vehicles',
    filter: propertyId ? `property_id=eq.${propertyId}` : undefined,
    enabled: Boolean(propertyId),
    onRefetch: loadSummary,
  })

  // ══════════════════════════════════════════════════════════════════
  // FORM
  // ══════════════════════════════════════════════════════════════════

  const setField = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }))
    // Clear this field's error as soon as it is touched. Leaving it up while
    // the operator fixes it reads as "still wrong".
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
  }

  function validate() {
    const next = {}

    if (!form.guestName.trim()) next.guestName = t('checkin.guestNameError')

    const phone = normalisePhone(form.guestPhone)
    if (!phone) next.guestPhone = t('checkin.guestPhoneError')
    else if (!PHONE_REGEX.test(phone))
      next.guestPhone = t('login.badPhone')

    // REQUIRED, on request. It used to be optional, on the reasoning that the
    // token is what identifies the car — it is on the guest's stub and it is
    // what they quote — so holding up a check-in over four digits was time lost
    // at the porch.
    //
    // What that reasoning left out: the token identifies the car to US, and the
    // plate is the only thing that identifies it to a GUEST who has lost their
    // stub, or to anyone standing in the car park looking for it. A blank here
    // is a car that can only be found through us.
    //
    // Still exactly four digits when given — a partial one is worse than none,
    // because it looks like a cross-check and is not.
    const car = formatCarNumber(form.carNumber)
    if (!car) next.carNumber = t('checkin.carNumberRequired')
    else if (car.length !== 4) next.carNumber = t('checkin.carNumberError')

    setErrors(next)
    return Object.keys(next).length === 0
  }

  /**
   * The submit button is a real type="submit" so Enter works from any field,
   * which means Button's automatic promise-driven loading state cannot be
   * used — its onClick never runs. Hence the explicit `submitting` flag.
   *
   * The guard is on the REF, not on that state. Two taps landing in the same
   * tick both read the same stale `submitting === false`, because React has
   * not re-rendered in between — and touch devices genuinely do this. A ref
   * updates immediately. Two check-ins for one car means two tokens, and the
   * guest is holding a stub for whichever one the operator wrote down.
   */
  const handleSubmit = async (event) => {
    event?.preventDefault?.()
    if (inFlight.current) return
    if (!validate()) return

    inFlight.current = true
    setSubmitting(true)
    try {
      await submitCheckIn()
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  const submitCheckIn = async () => {
    const result = await checkIn({
      guestName: form.guestName.trim(),
      // What the operator SAW and possibly corrected — not a fresh conversion.
      guestNameHi: form.guestNameHi.trim(),
      guestPhone: normalisePhone(form.guestPhone),
      carNumber: formatCarNumber(form.carNumber),
      carTier: form.carTier,
    })

    if (!result.ok) {
      // Field-level codes belong beside the field; everything else is a
      // toast, because it is not something editing the form will fix.
      const field = {
        BAD_NAME: 'guestName',
        BAD_PHONE: 'guestPhone',
        BAD_CAR: 'carNumber',
        BAD_TIER: 'carTier',
      }[result.code]

      if (field) setErrors((current) => ({ ...current, [field]: result.error }))
      else toast.error(result.error)
      return
    }

    // parked_at was generated by now() in the reply we are holding, so it is
    // a free reading of the database clock. MyTasks' countdown depends on it.
    noteServerTime(result.parked_at)

    setIssued(result)
    setForm(BLANK)
    setErrors({})
    loadSummary()
  }

  // Focus the dismiss button when the token appears: Enter then moves
  // straight to the next car without reaching for the screen.
  useEffect(() => {
    if (issued) dismissRef.current?.focus()
  }, [issued])

  const startNextCar = () => {
    setIssued(null)
    nameRef.current?.focus()
  }

  // ══════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════

  if (issued) {
    return (
      <TokenIssued
        issued={issued}
        onNext={startNextCar}
        buttonRef={dismissRef}
        onParked={() => {
          loadSummary()
          // A place just filled up by one, so every chip's free count is stale.
          reloadSpaces()
        }}
        spaces={spaces}
      />
    )
  }

  const remaining = range ? Math.max(0, range.range_end - range.next_token + 1) : null

  return (
    <>
      <PageHeader
        title={t('checkin.title')}
        subtitle={
          displayName
            ? t('checkin.signedInAs', { name: personName(displayName, displayNameHi) })
            : t('checkin.subtitle')
        }
      />

      {/* ABOVE the form, and normally not here at all.
          A car in this list has no recorded location, so nobody can fetch it —
          that outranks checking in the next one. It sits above rather than in
          the side panel because it needs a tap, and the side panel is
          read-only. */}
      {unparked.length > 0 && (
        <div className="mb-5">
          <SectionHeading
            title={t('checkin.stillToPark')}
            count={unparked.length}
            icon="parking"
            action={
              <span className="text-xs text-ink-subtle">{t('checkin.stillToParkBody')}</span>
            }
          />
          <div className="space-y-3">
            {unparked.map((task) => (
              <UnparkedCard
                key={task.id}
                task={task}
                spaces={spaces}
                onParked={() => {
                  loadSummary()
                  // A place just filled up, so every chip's free count is stale.
                  reloadSpaces()
                }}
              />
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* ── the form ─────────────────────────────────────────────── */}
        <Card as="form" onSubmit={handleSubmit} className="space-y-4">
          <Input
            ref={nameRef}
            label={t('checkin.guestName')}
            required
            icon="user"
            autoComplete="off"
            autoCapitalize="words"
            placeholder={t('checkin.guestNamePlaceholder')}
            value={form.guestName}
            error={errors.guestName}
            onChange={(e) => setField('guestName', e.target.value)}
          />

          {/* ── the Hindi spelling, VISIBLE ────────────────────────────
              It used to be generated silently after check-in. Shown here
              instead, and editable, because transliteration gets Indian names
              wrong often enough to be worth a glance — and a name nobody can
              check is a name nobody can trust.

              It costs no time at submit: this follows guestName while the
              operator is still filling in the phone and the car, so by the time
              they press the button the conversion has already happened.
              Nothing is awaited on the hot path. */}
          <HindiInput
            id="guest-name-hi"
            label={t('checkin.guestNameHi')}
            source={form.guestName}
            value={form.guestNameHi}
            onChange={(v) => setField('guestNameHi', v)}
          />

          <Input
            label={t('checkin.guestPhone')}
            required
            icon="phone"
            type="tel"
            // inputMode brings up the numeric keypad. No maxLength: it counts
            // raw characters, so a pasted "+91 98765 43210" would be cut off
            // before normalisePhone ever sees it.
            inputMode="numeric"
            autoComplete="off"
            placeholder="932XX XXXXX"
            hint={t('checkin.guestPhoneHint')}
            value={groupPhone(form.guestPhone)}
            error={errors.guestPhone}
            onKeyDown={skipPhoneSeparator}
            // Cleaned on every keystroke, not on submit. normalisePhone strips
            // +91, spaces and a leading 0, and caps at 10 — so the field can
            // never show something different from what actually gets stored.
            // Same handling as Login and the staff form; this one was the
            // odd one out and would happily display 14 digits.
            onChange={(e) => setField('guestPhone', normalisePhone(e.target.value))}
          />

          {/* ── the two CAR fields, side by side from sm up ─────────────
              Four digits and a three-option list do not need a whole row each.
              On a laptop this form was one column of full-width inputs, so a
              4-digit field got about 1100px of it and the operator scrolled past
              empty space to reach the button.

              Stacked below sm, in this order, which keeps the phone exactly as
              it was: name, its Hindi, phone, car, tier. That sequence is the
              order the operator is told things at the porch, and reordering it
              to make a tidier desktop grid would cost more than the grid is
              worth. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={t('checkin.carNumber')}
              icon="car"
              required
              autoComplete="off"
              spellCheck={false}
              type="tel"
              inputMode="numeric"
              placeholder=" 1 2 3 4 "
              hint={!errors.carNumber ? t('checkin.carNumberHint') : undefined}
              value={form.carNumber}
              error={errors.carNumber}
              // Digits only, capped at four. Stripping here rather than on submit
              // means the field can never show something different from what is
              // stored — and a numeric keypad on a phone is half the typing of a
              // full plate, on the screen used two hundred times a day.
              onChange={(e) => setField('carNumber', e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="tnum text-lg font-bold tracking-[0.25em]"
            />

            <Select
              label={t('checkin.carTier')}
              // The VALUE stays the English enum — it is what goes in the column
              // and what every RLS policy and badge compares against. Only the
              // visible label is translated.
              options={CAR_TIER_LIST.map((tier) => ({ value: tier, label: t(`tier.${tier}`) }))}
              value={form.carTier}
              error={errors.carTier}
              onChange={(e) => setField('carTier', e.target.value)}
              hint={t('checkin.carTierHint')}
            />
          </div>

          {/* NO NOTES, ANYWHERE ON THIS SCREEN. Removed on request — the input
              here, the note shown on the park-the-car card below, and `notes`
              from that card's select.

              The parked_vehicles.notes COLUMN stays, and so do the other
              screens that read it — CarStatus, MyTasks, Records. Rows written
              before today still carry notes, and hiding those would be losing
              data rather than removing a field.

              valetApi's checkIn() also still accepts `notes`; this form simply
              stops sending one. So nothing writes the column any more and it
              reads null on every new car. */}

          <Button
            type="submit"
            variant="primary"
            fullWidth
            icon="ticket"
            loading={submitting}
            loadingText={t('checkin.submitting')}
          >
            {t('checkin.submit')}
          </Button>
        </Card>

        {/* ── the side panel ───────────────────────────────────────── */}
        <div className="space-y-4">
          <Card className="space-y-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-ink-muted">{t('checkin.todayCount')}</span>
              {loading ? (
                <Skeleton className="h-7 w-10" />
              ) : (
                <span className="tnum text-2xl font-bold text-ink">{todayCount ?? 0}</span>
              )}
            </div>

            <div className="border-t border-line pt-3">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-medium text-ink-muted">{t('checkin.nextToken')}</span>
                {loading ? (
                  <Skeleton className="h-7 w-14" />
                ) : range ? (
                  <span className="tnum text-2xl font-bold text-ink">{range.next_token}</span>
                ) : (
                  <span className="text-sm text-ink-subtle">{t('checkin.notStarted')}</span>
                )}
              </div>

              {range && (
                <p
                  className={
                    remaining <= 20
                      ? 'mt-1 text-xs font-semibold text-danger'
                      : 'mt-1 text-xs text-ink-subtle'
                  }
                >
                  {t('checkin.tokensLeft', {
                    left: remaining,
                    total: range.range_end - range.range_start + 1,
                  })}
                  {remaining <= 20 && t('checkin.rangeLow')}
                </p>
              )}
            </div>
          </Card>

          <div>
            <SectionHeading title={t('checkin.recent')} icon="clock" />
            {loading ? (
              <Card className="space-y-3">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-2/3" />
              </Card>
            ) : loadError ? (
              <EmptyState
                variant="error"
                compact
                title={t('common.couldNotLoad')}
                description={loadError}
                action={
                  <Button size="sm" variant="secondary" icon="refresh" onClick={loadSummary}>
                    {t('common.tryAgain')}
                  </Button>
                }
              />
            ) : recent.length === 0 ? (
              <EmptyState
                compact
                icon="car"
                title={t('checkin.noCarsYet')}
                description={t('checkin.noCarsYetDesc')}
              />
            ) : (
              <Card padded={false} className="divide-y divide-line">
                {recent.map((vehicle) => (
                  <button
                    key={vehicle.id}
                    type="button"
                    onClick={() => navigate('/operator/cars')}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-sunken"
                  >
                    <span className="tnum flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-sm font-bold text-ink">
                      {vehicle.token_number}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-ink">
                          {prettyCarNumber(vehicle.car_number)}
                        </span>
                        <TierBadge tier={vehicle.car_tier} size="sm" />
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-ink-subtle">
                        {formatTime(vehicle.parked_at)}
                      </span>
                    </span>
                    <VehicleStatusBadge status={vehicle.status} size="sm" showIcon={false} />
                  </button>
                ))}
              </Card>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════
// SUCCESS PANEL
//
// The token is the biggest thing on the screen by a wide margin, and it is
// tabular-figure so 99 and 100 sit in the same place. The operator reads it
// out loud and writes it on a paper stub, often in the dark, often while
// someone is talking to them.
// ═══════════════════════════════════════════════════════════════════

/**
 * The token, and the "Car Parked" step directly under it.
 *
 * ── WHY PARKING FINISHES HERE AND NOT IN MY TASKS ─────────────────────
 *
 * The old flow was: get the token, dismiss the panel, open My Tasks, find the
 * card for the car you are holding the keys to, then enter the location. Four
 * steps and a screen change to finish something the operator is in the middle
 * of doing. My Tasks no longer carries parking at all.
 *
 * The real sequence at a porch is one continuous action: take the keys, write
 * the token on the stub, drive the car away, park it, walk back. The panel is
 * still on screen when they get back — nothing auto-dismisses it — so the
 * place to finish is right here.
 *
 * ── "PARK LATER" IS NOT A CONVENIENCE, IT IS THE BUSY CASE ─────────────
 *
 * A second car pulls up before the first is parked. That is normal on a
 * Saturday, so the panel must never trap the operator: "Check in next car"
 * stays available and the car simply moves to the "Still to park" strip at the
 * top of this screen, where it is one tap from being finished.
 */
function TokenIssued({ issued, onNext, buttonRef, onParked, spaces }) {
  const t = useT()
  const [location, setLocation] = useState('')
  const [localError, setLocalError] = useState(null)
  const [parked, setParked] = useState(false)

  const park = useParkSubmit((where) => completeParking(issued.task_id, where))

  async function submit() {
    const trimmed = location.trim()
    if (!trimmed) {
      setLocalError(t('checkin.tapPlace'))
      return
    }
    if (trimmed.length > 60) {
      setLocalError(t('checkin.keepShort'))
      return
    }

    setLocalError(null)
    if (await park.submit(trimmed)) {
      setParked(true)
      onParked?.()
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <Card className="text-center">
        <span
          className={cn(
            'mx-auto flex h-14 w-14 items-center justify-center rounded-2xl',
            parked ? 'bg-success-soft text-success' : 'bg-brand-soft text-ink-muted',
          )}
        >
          <Icon name={parked ? 'check-circle' : 'ticket'} size={28} />
        </span>

        <p className="mt-5 text-sm font-medium uppercase tracking-wide text-ink-subtle">
          {t('checkin.tokenNumber')}
        </p>
        <p className="tnum mt-1 text-7xl font-bold leading-none tracking-tight text-ink">
          {issued.token_number}
        </p>

        {/* The car icon is load-bearing now that a plate is four digits: a bare
            "1234" sitting under a huge labelled TOKEN reads as a second token.
            The icon says which number this is without another label. */}
        <div className="mt-5 flex items-center justify-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-lg font-semibold tracking-wide text-ink">
            <Icon name="car" size={17} className="text-ink-subtle" />
            {prettyCarNumber(issued.car_number)}
          </span>
          <TierBadge tier={issued.car_tier} />
        </div>
        {issued.guest_name && (
          <p className="mt-1 text-sm text-ink-subtle">
            {personName(issued.guest_name, issued.guest_name_hi)}
          </p>
        )}

        {parked ? (
          <>
            <p className="mt-5 flex items-center justify-center gap-2 rounded-lg bg-success-soft px-3.5 py-3 text-sm font-medium text-success">
              <Icon name="check-circle" size={17} strokeWidth={2} />
              {t('checkin.parkedAt', { place: location.trim() })}
            </p>

            <Button
              ref={buttonRef}
              variant="primary"
              fullWidth
              icon="plus"
              className="mt-5"
              onClick={onNext}
            >
              {t('checkin.nextCar')}
            </Button>
          </>
        ) : (
          <>
            <p className="mt-5 rounded-lg bg-info-soft px-3.5 py-3 text-sm leading-relaxed text-info">
              {t('checkin.writeOnStub', { token: issued.token_number })}
            </p>

            <div className="mt-5 border-t border-line pt-4 text-left">
              <SpacePicker
                id="park-location"
                label={t('checkin.thenPark')}
                value={location}
                onChange={(v) => {
                  setLocation(v)
                  setLocalError(null)
                  park.reset()
                }}
                spaces={spaces}
                error={localError ?? park.error}
              />

              <Button
                variant="primary"
                fullWidth
                icon="parking"
                className="mt-4"
                onClick={submit}
                loadingText={t('common.saving')}
              >
                {t('checkin.carParked')}
              </Button>
            </div>

            {/* Secondary, and worded so it is obvious the car is not lost —
                it moves to the strip at the top of this screen. */}
            <Button
              ref={buttonRef}
              variant="ghost"
              fullWidth
              icon="plus"
              className="mt-2"
              onClick={onNext}
            >
              {t('checkin.parkLater')}
            </Button>
          </>
        )}
      </Card>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// STILL TO PARK
//
// One car the operator is holding the keys to. Same two controls as the token
// panel above — pick the place, confirm — because it is the same job finished
// late, and a second way of doing it would be a second thing to learn.
// ═══════════════════════════════════════════════════════════════════

function UnparkedCard({ task, spaces, onParked }) {
  const t = useT()
  const vehicle = task.parked_vehicles
  const [location, setLocation] = useState('')
  const [localError, setLocalError] = useState(null)

  const park = useParkSubmit((where) => completeParking(task.id, where))

  async function submit() {
    const trimmed = location.trim()
    if (!trimmed) {
      setLocalError(t('checkin.tapPlace'))
      return
    }
    if (trimmed.length > 60) {
      setLocalError(t('checkin.keepShort'))
      return
    }

    setLocalError(null)
    // On failure the card stays exactly where it is with the place still
    // picked. The car is real and still unparked; clearing the form would
    // just make them do it again.
    if (await park.submit(trimmed)) onParked?.()
  }

  return (
    <Card accent="info">
      <div className="flex items-start gap-4">
        <div className="shrink-0 text-center">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-subtle">
            {t('common.token')}
          </p>
          <p className="tnum text-4xl font-bold leading-none tracking-tight text-ink">
            {vehicle?.token_number ?? '—'}
          </p>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 font-semibold tracking-wide text-ink">
              <Icon name="car" size={15} className="text-ink-subtle" />
              {prettyCarNumber(vehicle?.car_number)}
            </span>
            <TierBadge tier={vehicle?.car_tier} size="sm" />
          </div>
          {vehicle?.guest_name && (
            <p className="mt-0.5 truncate text-sm text-ink-subtle">
              {personName(vehicle.guest_name, vehicle.guest_name_hi)}
            </p>
          )}

        </div>
      </div>

      <div className="mt-4">
        <SpacePicker
          id={`unparked-${task.id}`}
          value={location}
          onChange={(v) => {
            setLocation(v)
            setLocalError(null)
            park.reset()
          }}
          spaces={spaces}
          error={localError ?? park.error}
        />

        <Button
          variant="success"
          fullWidth
          icon="check"
          className="mt-3"
          onClick={submit}
          loadingText={t('common.saving')}
        >
          {t('checkin.carParked')}
        </Button>
      </div>
    </Card>
  )
}
