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
        isError ? 'border-danger/30 bg-danger-soft/40' : 'border-line-strong bg-surface/60',
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

      <h3 className={cn('font-semibold text-ink', compact ? 'text-sm' : 'text-base')}>{title}</h3>

      {description && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-subtle">{description}</p>
      )}

      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
