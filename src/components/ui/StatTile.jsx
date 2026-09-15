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

import { Children } from 'react'
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
  /**
   * The ICON's tint, when it should differ from the number's colour.
   *
   * `tone` colours both, which is right for a number that means something —
   * a red count of overdue cars. It is wrong for a row of tiles that are
   * merely different subjects: the reference gives each tile its own pastel
   * icon (amber sites, blue cars, green operators, rose admins) while every
   * NUMBER stays near-black, because colouring four numbers four ways
   * implies four different kinds of alarm and there is no alarm at all.
   *
   * Defaults to `tone`, so nothing that already sets `tone` changes.
   */
  iconTone,
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
      // `group` so the round affordance at the bottom-right can respond to a
      // hover anywhere on the tile — the whole card is the target, and a
      // button that only lights up when you are exactly on it reads as the
      // rest of the card being dead.
      className={cn(
        // `glass`, the same utility Card uses. This tile builds its own
        // container rather than wrapping <Card>, which is exactly why it was
        // left behind when the cards were first made translucent — the stat row
        // stayed opaque white and read as an older component. Sharing the rule
        // in index.css is what stops that happening again.
        // min-w-0 is what lets a phone lay these out at all. A CSS grid
        // column is minmax(AUTO, 1fr) by default, and `auto` means it cannot
        // be narrower than its content's min-content width — here that is a
        // footer link like "Manage operators ->", around 200px. Two of those
        // in grid-cols-2 forced the row past 390px, which made <main> scroll
        // sideways and dragged every other block on the page out with it:
        // the tab chips and the site rows were cut off by an overflow they
        // had no part in.
        'group flex min-w-0 flex-col rounded-2xl border p-5 text-left glass',
        // Matches Card: every tile lifts, a clickable one also zooms.
        // glass-hover/-lift rather than hover:shadow-raised, because the tile
        // already carries a shadow and a lit rim from `glass` — a slightly
        // larger shadow was a change almost nobody could see, least of all on
        // a cheap Android screen in daylight, which is where half this app is
        // used. The pane brightening against the photograph reads instantly.
        !interactive && 'glass-lift',
        interactive &&
          'glass-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30',
        className,
      )}
    >
      {/* ICON ON THE LEFT, not floated opposite the label. With the icon in
          the top-right corner the eye reads label, then jumps right to the
          icon, then back left and down to the number. Leading with the icon
          makes each tile one left-to-right unit, which is what lets a row of
          four be scanned rather than read. */}
      <div className="flex items-start gap-3.5">
        {icon && (
          <span
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
              TONE_ICON[iconTone ?? tone] ?? TONE_ICON.neutral,
            )}
          >
            <Icon name={icon} size={20} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[0.8125rem] font-medium leading-tight text-ink-muted">{label}</p>
          {loading ? (
            <Skeleton className="mt-2 h-8 w-16" />
          ) : (
            <p
              className={cn(
                'tnum mt-1 text-3xl font-bold leading-none tracking-tight',
                TONE_TEXT[tone] ?? TONE_TEXT.neutral,
              )}
            >
              {value ?? '—'}
            </p>
          )}
        </div>
      </div>

      {/* mt-auto so the footer sits on the floor of the tile. A row of four
          whose numbers are 4, 0, 6 and 7 is all one height, but the moment a
          label wraps on a narrow window the hints would otherwise sit at four
          different heights. */}
      {hint && (
        <div className="mt-auto flex items-center justify-between gap-2 pt-3.5">
          <span className="inline-flex min-w-0 items-center gap-1 text-xs text-ink-subtle">
            <span className="truncate">{hint}</span>
            <Icon name="arrow-right" size={12} className="shrink-0" />
          </span>
          {/* Only when there is somewhere to go. A round arrow on a tile that
              does nothing is a button that does not work. */}
          {interactive && (
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line text-ink-subtle transition-colors group-hover:border-brand group-hover:bg-brand group-hover:text-on-brand"
            >
              <Icon name="arrow-right" size={14} />
            </span>
          )}
        </div>
      )}
    </Tag>
  )
}

/**
 * The grid stat tiles live in. 2 columns on a phone (a single column wastes
 * the width and pushes the actual work below the fold), 4 on a desktop.
 */
/**
 * The columns follow the number of TILES, rather than always being four.
 *
 * It was `lg:grid-cols-4` flat, which is right for the four-tile screens and
 * wrong for every other count: three tiles filled three quarters of the row and
 * stopped short of the content underneath, which reads as a broken layout
 * rather than as a row with three things in it.
 *
 * Overriding it through className does not work here and the attempt is worth
 * naming: cn() joins strings and does NOT merge Tailwind conflicts, so passing
 * `lg:grid-cols-3` emits both classes and which one wins is decided by their
 * order in the generated stylesheet — not by the order written here. Counting
 * the children is the fix that cannot be got wrong at the call site.
 *
 * Children.toArray, not Children.count: toArray drops the nulls and falses that
 * a conditional tile leaves behind, so `{isAdmin && <StatTile/>}` does not
 * reserve a column it never fills.
 */
const COLUMNS = {
  1: 'lg:grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
}

export function StatRow({ children, className = '' }) {
  const count = Children.toArray(children).length

  return (
    <div
      className={cn(
        // grid-cols-2 on a phone whatever the count — two tiles side by side is
        // the readable limit at 390px, and a single column would push the list
        // below the fold.
        'grid grid-cols-2 gap-3',
        COLUMNS[count] ?? 'lg:grid-cols-4',
        className,
      )}
    >
      {children}
    </div>
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
