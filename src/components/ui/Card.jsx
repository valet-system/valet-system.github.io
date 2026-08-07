/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/Card.jsx                                    │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The surface every block of content sits on, plus its parts:        │
 * │     Card            — the bordered white panel                       │
 * │     CardHeader      — icon + title + subtitle + action row           │
 * │     CardDivider     — full-bleed hairline inside a card              │
 * │     SectionHeading  — the label above a group of cards, with count   │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Two props carry real meaning and should stay rationed:              │
 * │                                                                     │
 * │   `urgent` — pulsing red ring. Reserved for ONE thing: a retrieval   │
 * │   request the admin has not assigned yet. That restriction is what   │
 * │   makes it work. If three things on a screen pulse, nothing does.    │
 * │                                                                     │
 * │   `accent` — a 3px coloured left rail. Colour-codes a card without   │
 * │   tinting its background, which would hurt text contrast. Cheap,     │
 * │   quiet, scannable down a long list.                                │
 * │                                                                     │
 * │   SectionHeading takes a `count` because an operator needs to know   │
 * │   how much work is in a section without counting cards.              │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   Every page.                                                       │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   ui/Icon, utils/cn                                                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import Icon from './Icon'
import { cn } from '@/utils/cn'
export default function Card({
  children,
  className = '',
  as: Tag = 'div',
  padded = true,
  interactive = false,
  urgent = false,
  accent,
  ...rest
}) {
  return (
    <Tag
      className={cn(
        'rounded-card border border-line bg-surface shadow-card',
        padded && 'p-4 sm:p-5',
        interactive &&
          'cursor-pointer transition-shadow duration-150 hover:shadow-raised focus-visible:shadow-raised',
        urgent && 'border-danger/40 animate-pulse-ring',
        // A 3px left rail is a cheap, quiet way to colour-code a card without
        // tinting the whole background (which hurts text contrast).
        accent && 'border-l-[3px]',
        accent === 'danger' && 'border-l-danger',
        accent === 'success' && 'border-l-success',
        accent === 'warning' && 'border-l-warning',
        accent === 'info' && 'border-l-info',
        accent === 'vip' && 'border-l-vip',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  )
}

export function CardHeader({ title, subtitle, icon, action, className = '' }) {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-ink-muted">
            <Icon name={icon} size={18} />
          </span>
        )}
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-sm text-ink-subtle">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/** Hairline divider for splitting a card into sections. */
export function CardDivider({ className = '' }) {
  return <hr className={cn('-mx-4 my-4 border-t border-line sm:-mx-5', className)} />
}

/**
 * SectionHeading — separates blocks on a page ("Active tasks",
 * "Completed today"). `count` renders as a pill so the operator can see how
 * much work is in a section without counting cards.
 */
export function SectionHeading({ title, count, action, icon, className = '', id }) {
  return (
    // `id` is forwarded so a stat tile can scroll to a section. Without it the
    // prop is silently dropped and getElementById finds nothing — a dead tap
    // with no error anywhere.
    <div id={id} className={cn('mb-3 flex items-center justify-between gap-3', className)}>
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-subtle">
        {icon && <Icon name={icon} size={16} />}
        {title}
        {typeof count === 'number' && (
          <span className="tnum rounded-full bg-brand-soft px-2 py-0.5 text-xs font-bold text-ink-muted">
            {count}
          </span>
        )}
      </h2>
      {action}
    </div>
  )
}
