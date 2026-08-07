/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/StatTile.jsx                                │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The single-number tiles that sit in a row at the top of a          │
 * │   dashboard — "Cars today 128", "Pending retrieval 3".              │
 * │     StatTile     — one tile                                         │
 * │     StatRow      — the responsive grid that holds them              │
 * │     ProgressBar  — labelled bar, used by TokenMgmt for range usage  │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Three rules baked in, because a stat row is the easiest thing in   │
 * │   an app to get subtly wrong:                                        │
 * │                                                                     │
 * │   1. The NUMBER is the largest thing in the tile and the label is    │
 * │      small and above it. Reversed (big label, small number) is the   │
 * │      most common dashboard mistake — the eye has to hunt for the     │
 * │      value it came for.                                             │
 * │   2. Numbers use .tnum (tabular figures). Without it a count going   │
 * │      9 -> 10 changes the tile's width and the whole row twitches.   │
 * │      This row updates live over realtime, so it would twitch often. │
 * │   3. `tone` only tints the icon and the number, never the tile       │
 * │      background. Four differently-tinted tiles side by side look     │
 * │      like an alert state rather than a summary.                     │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   admin/Dashboard, admin/Analytics, admin/TokenMgmt,                 │
 * │   system/Analytics, operator/CheckIn                                │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   ui/Icon, ui/Spinner (Skeleton), utils/cn                          │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { Link } from 'react-router-dom'
import Icon from './Icon'
import { Skeleton } from './Spinner'
import { cn } from '@/utils/cn'

const TONE_TEXT = {
  neutral: 'text-ink',
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
  vip: 'text-vip',
}

const TONE_ICON = {
  neutral: 'bg-brand-soft text-ink-muted',
  success: 'bg-success-soft text-success',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info',
  vip: 'bg-vip-soft text-vip',
}

export default function StatTile({
  label,
  value,
  icon,
  tone = 'neutral',
  hint,
  loading = false,
  className = '',
  onClick,
  /** Route to open on click, e.g. "/admin/analytics". */
  to,
}) {
  // A real <Link> for a route and a <button> for an in-page action, never a
  // div with a click handler. A tile that navigates has to be middle-clickable
  // and open-in-new-tab-able, and one that scrolls must not look like a link.
  const interactive = Boolean(to || onClick)
  const Tag = to ? Link : onClick ? 'button' : 'div'

  return (
    <Tag
      to={to}
      type={!to && onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'rounded-card border border-line bg-surface p-4 text-left shadow-card',
        interactive &&
          // The border change matters more than the shadow on a cheap Android
          // screen in daylight, where a soft shadow is close to invisible.
          'cursor-pointer transition-all duration-150 hover:border-line-strong hover:shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.8125rem] font-medium leading-tight text-ink-subtle">{label}</p>
        {icon && (
          <span
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
              TONE_ICON[tone] ?? TONE_ICON.neutral,
            )}
          >
            <Icon name={icon} size={16} />
          </span>
        )}
      </div>

      {loading ? (
        <Skeleton className="mt-2 h-8 w-16" />
      ) : (
        <p
          className={cn(
            'tnum mt-1.5 text-3xl font-bold leading-none tracking-tight',
            TONE_TEXT[tone] ?? TONE_TEXT.neutral,
          )}
        >
          {value ?? '—'}
        </p>
      )}

      {hint && <p className="mt-1.5 text-xs text-ink-subtle">{hint}</p>}
    </Tag>
  )
}

/**
 * The grid stat tiles live in. 2 columns on a phone (a single column wastes
 * the width and pushes the actual work below the fold), 4 on a desktop.
 */
export function StatRow({ children, className = '' }) {
  return (
    <div className={cn('grid grid-cols-2 gap-3 lg:grid-cols-4', className)}>{children}</div>
  )
}

export function ProgressBar({ value = 0, max = 100, tone = 'info', label, className = '' }) {
  // Clamp: a range that has been over-allocated must not render a bar
  // wider than its track.
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0

  const fill = {
    info: 'bg-info',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
  }[tone]

  return (
    <div className={className}>
      {label && (
        <div className="mb-1.5 flex items-baseline justify-between text-sm">
          <span className="font-medium text-ink-muted">{label}</span>
          <span className="tnum font-semibold text-ink">
            {value} / {max}
          </span>
        </div>
      )}
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-500', fill)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
