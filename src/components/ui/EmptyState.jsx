/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/EmptyState.jsx                              │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The placeholder shown in place of a list that has no rows, and    │
 * │   (via variant="error") in place of a list that failed to load.     │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Spec rule 18 requires an empty state on every list. An empty      │
 * │   list and a broken list look identical to a user — both are a      │
 * │   blank rectangle. "No cars checked in today" is information;       │
 * │   a blank rectangle is a support call. Operators mid-shift do not   │
 * │   report bugs, they stop trusting the app.                          │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   Every list/table page: operator/TodaysCars, operator/MyTasks,     │
 * │   admin/Dashboard, admin/Reviews, system/Users, system/Properties.  │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   ui/Icon (icon registry), utils/cn (className joiner)              │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import Icon from './Icon'
import { cn } from '@/utils/cn'

export default function EmptyState({
  icon = 'inbox',
  title,
  description,
  action,
  variant = 'empty', // 'empty' | 'error'
  className = '',
  compact = false,
}) {
  const isError = variant === 'error'

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-card border border-dashed text-center',
        // bg-surface/60 with NO blur was the bug: 40% of the photograph came
        // straight through, so the words painted on the wall in the image read
        // as if they were part of this card. Every other panel in the app uses
        // `glass`, whose blur is exactly what destroys that detail while
        // keeping the light. The DASHED border stays — it is the signal that
        // says "nothing here yet" rather than "a card failed to fill".
        isError
          ? 'border-danger/30 bg-danger-soft/60 backdrop-blur-md'
          : 'border-line-strong glass',
        compact ? 'px-4 py-8' : 'px-6 py-14',
        className,
      )}
      // role="alert" makes a screen reader announce a load failure immediately;
      // role="status" announces an empty result politely, without interrupting.
      role={isError ? 'alert' : 'status'}
    >
      <span
        className={cn(
          'mb-4 flex items-center justify-center rounded-2xl',
          compact ? 'h-11 w-11' : 'h-14 w-14',
          isError ? 'bg-danger-soft text-danger' : 'bg-brand-soft text-ink-subtle',
        )}
      >
        <Icon name={isError ? 'alert' : icon} size={compact ? 22 : 26} />
      </span>

      {/* A step LARGER than it was. The description below is now the same
          weight and colour, so size is the only thing left holding the
          hierarchy — without this the two lines read as one paragraph. */}
      <h3 className={cn('font-bold text-ink', compact ? 'text-base' : 'text-lg')}>{title}</h3>

      {/* The description is full ink and semibold, on request. It was
          ink-subtle, the quietest step in the palette and the usual choice for
          a supporting line — but this one sits on glass over a photograph
          rather than on a flat card, and quiet plus translucent is what made
          it hard to read. */}
      {description && (
        <p className="mt-1.5 max-w-sm text-sm font-semibold leading-relaxed text-ink">
          {description}
        </p>
      )}

      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
