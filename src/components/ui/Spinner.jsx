/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/Spinner.jsx                                 │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Three loading indicators:                                         │
 * │     Spinner      — inline, sits inside buttons                      │
 * │     PageSpinner  — full-height, for route / auth bootstrap          │
 * │     Skeleton     — grey placeholder shaped like the incoming row    │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Built as an SVG arc rather than the usual CSS border trick, so it │
 * │   stays perfectly circular at any size and inherits currentColor    │
 * │   from its parent — one component works on a dark primary button    │
 * │   and on a white card with no variants.                             │
 * │                                                                     │
 * │   Skeleton exists separately because a spinner inside a list makes  │
 * │   the layout jump when data lands. A placeholder the same shape as  │
 * │   the real row does not — which matters when an operator is already │
 * │   reaching for the screen.                                          │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   ui/Button (inline), ProtectedRoute + AuthContext (PageSpinner),   │
 * │   list pages while fetching (Skeleton)                              │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   utils/cn                                                          │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { cn } from '@/utils/cn'
export default function Spinner({ size = 20, className = '', label = 'Loading' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label={label}
      className={cn('animate-spin shrink-0', className)}
    >
      {/* track */}
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      {/* moving arc — ~25% of the circumference */}
      <path
        d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Full-page loader for route-level suspense / auth bootstrapping. */
export function PageSpinner({ label = 'Loading' }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
      <Spinner size={32} className="text-brand" label={label} />
      <p className="text-sm text-ink-subtle">{label}</p>
    </div>
  )
}

/**
 * Skeleton — shown while data loads instead of a spinner in a list.
 * A shape that matches the incoming content stops the layout from jumping,
 * which matters when an operator is already reaching for the screen.
 */
export function Skeleton({ className = '', style }) {
  return (
    // `style` is here for percentage heights that Tailwind cannot express as a
    // class — the varied bars in ChartSkeleton. Everything else uses classes.
    <div className={cn('relative overflow-hidden rounded-md bg-line/60', className)} style={style}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-surface/70 to-transparent" />
    </div>
  )
}
