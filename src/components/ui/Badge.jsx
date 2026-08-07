/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/Badge.jsx                                   │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The generic Badge pill, plus five typed wrappers that render a     │
 * │   domain value directly:                                            │
 * │     VehicleStatusBadge  checked_in ... delivered  (9 states)         │
 * │     TaskStatusBadge     pending ... completed     (7 states)         │
 * │     TaskTypeBadge       parking / retrieval                         │
 * │     RatingBadge         excellent / good / poor                     │
 * │     TierBadge           Standard / Premium / VIP                     │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Pages never choose a colour. They pass the raw domain value and    │
 * │   the *_META maps in src/types decide tone + label + icon. That is   │
 * │   why "fetching" is the same blue on the operator's phone, in the    │
 * │   admin queue and in the analytics table, with nobody coordinating.  │
 * │   Without this, 9 statuses x 12 pages is 108 chances to pick a       │
 * │   slightly different green.                                         │
 * │                                                                     │
 * │   The prop is called `tone`, not `color`, on purpose: it names the   │
 * │   MEANING, not the pigment. Re-theming is then a token change in     │
 * │   index.css rather than a rename across every page.                 │
 * │                                                                     │
 * │   Unknown values degrade to a neutral badge showing the raw string   │
 * │   instead of crashing — if someone adds a status in SQL and forgets  │
 * │   src/types, the page still renders and the gap is visible.          │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   All task cards, all tables, retrieval queue, reviews, analytics.   │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   ui/Icon, utils/cn, src/types (the *_META maps)                     │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import Icon from './Icon'
import { useT } from '@/i18n'
import { cn } from '@/utils/cn'
import {
  CAR_TIER_META,
  RATING_META,
  TASK_STATUS_META,
  TASK_TYPE_META,
  VEHICLE_STATUS_META,
} from '@/types'

const TONES = {
  neutral: 'bg-brand-soft text-ink-muted ring-line-strong',
  success: 'bg-success-soft text-success ring-success/25',
  danger: 'bg-danger-soft text-danger ring-danger/25',
  warning: 'bg-warning-soft text-warning ring-warning/30',
  info: 'bg-info-soft text-info ring-info/25',
  vip: 'bg-vip-soft text-vip ring-vip/35',
  /** Solid — for the one badge on screen that must win, e.g. a live countdown. */
  solid: 'bg-brand text-ink-inverse ring-transparent',
}

const SIZES = {
  sm: 'h-6 px-2 text-xs gap-1 rounded-md',
  md: 'h-7 px-2.5 text-[0.8125rem] gap-1.5 rounded-md',
  lg: 'h-9 px-3 text-sm gap-1.5 rounded-lg',
}

export default function Badge({
  children,
  tone = 'neutral',
  size = 'md',
  icon,
  dot = false,
  className = '',
  ...rest
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center font-semibold ring-1 ring-inset',
        // whitespace-nowrap: a wrapped two-line badge inside a table cell
        // wrecks row heights.
        'whitespace-nowrap',
        TONES[tone] ?? TONES.neutral,
        SIZES[size] ?? SIZES.md,
        className,
      )}
      {...rest}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {icon && <Icon name={icon} size={size === 'sm' ? 12 : 14} strokeWidth={2} />}
      {children}
    </span>
  )
}

/**
 * Renders from a *_META lookup. Unknown values degrade to a neutral badge
 * showing the raw string rather than crashing — if someone adds a status in
 * SQL and forgets src/types, the page still renders and the gap is visible.
 *
 * ── EVERY STATUS BADGE IN THE APP IS TRANSLATED HERE ──────────────────
 *
 * `ns` is the dictionary namespace and the raw database value is the key, so
 * a vehicle status of 'at_pickup' renders t('vehicle.at_pickup'). Doing it in
 * this one component covers every badge on every screen — the alternative was
 * a second `labelHi` field on each *_META entry in src/types, which would put
 * the Hindi somewhere no translator would ever look.
 *
 * The English text stays in src/types as the fallback: a status added in SQL
 * and forgotten in the dictionary still reads, in English, rather than showing
 * a raw key like "vehicle.towed" to an operator.
 */
function MetaBadge({ meta, value, ns, showIcon = true, ...rest }) {
  const t = useT()

  if (!value) return null
  const entry = meta[value]
  if (!entry) return <Badge tone="neutral" {...rest}>{String(value)}</Badge>

  const key = `${ns}.${value}`
  const translated = t(key)

  return (
    <Badge tone={entry.tone} icon={showIcon ? entry.icon : undefined} {...rest}>
      {translated === key ? entry.label : translated}
    </Badge>
  )
}

/** Vehicle lifecycle: checked_in ... delivered. */
export function VehicleStatusBadge({ status, ...rest }) {
  return <MetaBadge meta={VEHICLE_STATUS_META} ns="vehicle" value={status} {...rest} />
}

/** Task lifecycle: pending ... completed. */
export function TaskStatusBadge({ status, ...rest }) {
  return <MetaBadge meta={TASK_STATUS_META} ns="task" value={status} {...rest} />
}

/** parking vs retrieval. */
export function TaskTypeBadge({ type, ...rest }) {
  return <MetaBadge meta={TASK_TYPE_META} ns="taskType" value={type} {...rest} />
}

/** excellent / good / poor. */
export function RatingBadge({ rating, ...rest }) {
  return <MetaBadge meta={RATING_META} ns="rating" value={rating} {...rest} />
}

/**
 * Standard / Premium / VIP.
 * Standard is intentionally suppressed by default: it is ~80% of cars, so
 * badging every one of them adds visual noise and makes VIP harder to spot.
 * Pass `alwaysShow` in a table column where a blank cell would be confusing.
 */
export function TierBadge({ tier, alwaysShow = false, ...rest }) {
  if (!tier) return null
  if (tier === 'Standard' && !alwaysShow) return null
  return <MetaBadge meta={CAR_TIER_META} ns="tier" value={tier} {...rest} />
}
