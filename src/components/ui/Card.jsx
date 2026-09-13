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
  /**
   * Whether the pane responds to the pointer at all. On by default, so every
   * card in the app reacts without each page having to remember to ask.
   *
   * Pass `hover={false}` for a card that is pure container and nothing else —
   * a single full-width form panel, say, where brightening as the mouse
   * crosses it is noise carrying no information. A LIST of cards is the case
   * this default is for: the response tells you which row you are on.
   */
  hover = true,
  urgent = false,
  accent,
  ...rest
}) {
  return (
    <Tag
      className={cn(
        // `glass`, not bg-surface: a frosted pane over the backdrop photograph
        // rather than an opaque box on it. The rule — tint, lit rim, blur,
        // Safari prefix and the no-backdrop-filter fallback — lives in
        // index.css so Card, StatTile and the filter chips cannot drift apart.
        // It carries its own shadow, so shadow-card is gone from here.
        'rounded-card border glass',
        padded && 'p-4 sm:p-5',
        // ── TWO STRENGTHS, AND THE DIFFERENCE IS A PROMISE ───────────────
        // Both replace the old hover:shadow-raised, which barely registered
        // once the card had a shadow and a lit rim of its own from `glass`.
        //
        //   interactive  the pane brightens AND zooms 2%. Only for cards that
        //                actually do something when clicked — a surface that
        //                comes toward you and then ignores the click is a lie
        //                told by the whole card, not by one small icon.
        //   hover        it brightens and its rim catches, nothing more. An
        //                affordance ("you are on this one"), not an offer.
        //
        // Ordered so `interactive` wins: it comes second, and both write the
        // same properties, so the zoom is added rather than fought over.
        hover && !interactive && 'glass-lift',
        interactive && 'glass-hover cursor-pointer focus-visible:shadow-raised',
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
      {/* FULL INK. These headings are the one piece of text on most screens
          with no card behind them — they sit directly on the backdrop
          photograph, and both quieter steps in the palette washed out over the
          bright parts of the image. ink-subtle went first, then ink-muted; the
          uppercase, the letter-spacing and the size already say "label", so the
          colour does not also have to be quiet to carry that. */}
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink">
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
