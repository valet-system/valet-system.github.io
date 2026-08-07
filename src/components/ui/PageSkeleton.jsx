/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/PageSkeleton.jsx                            │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Placeholder shapes for a page that has not loaded yet, one per     │
 * │   kind of block: header, stat row, card, chart, list rows, table.    │
 * │   Each page composes the ones it actually uses.                      │
 * │                                                                     │
 * │ WHY NOT JUST PageSpinner                                             │
 * │   PageSpinner blanks the whole page and puts a dot in the middle of  │
 * │   it. Three things go wrong with that:                               │
 * │                                                                     │
 * │     - Everything arrives at once at a random moment, so the layout   │
 * │       jumps under a thumb that was already reaching for a button.    │
 * │     - A blank page carries no information. A skeleton says "four     │
 * │       numbers, then a chart" before the data lands, so the eye is    │
 * │       already in the right place.                                    │
 * │     - It reads as slower even when it is not. A shape that is        │
 * │       already correct feels like it is filling in; a spinner feels   │
 * │       like waiting.                                                  │
 * │                                                                     │
 * │ WHY THE SHAPES ARE DELIBERATELY SPECIFIC                             │
 * │   A generic grey block is barely better than a spinner. These match  │
 * │   the real components' heights and grid — h-touch inputs, the        │
 * │   4-column StatRow, chart bars with varied heights — because the     │
 * │   whole benefit is that nothing moves when the data replaces them.   │
 * │   If a page's layout changes, its skeleton has to change too.        │
 * │                                                                     │
 * │ NO RANDOM HEIGHTS                                                    │
 * │   The chart bars use a fixed pattern, not Math.random(). Random      │
 * │   heights re-roll on every React re-render, so the placeholder       │
 * │   visibly twitches while you look at it.                             │
 * │                                                                     │
 * │ MOTION                                                              │
 * │   The shimmer comes from Skeleton, and index.css already disables    │
 * │   animation under prefers-reduced-motion — so this is safe for       │
 * │   anyone who gets motion sick, with no extra handling here.          │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   every page while fetching, and AppShell as the Suspense fallback   │
 * │   for lazily-loaded routes                                           │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   ui/Spinner (Skeleton), ui/Card, utils/cn                            │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import Card from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Spinner'
import { cn } from '@/utils/cn'

/** Matches PageHeader: title, subtitle, and an action button on the right. */
export function HeaderSkeleton({ action = true }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <Skeleton className="h-7 w-52 rounded-lg" />
        <Skeleton className="mt-2 h-4 w-36" />
      </div>
      {action && <Skeleton className="h-11 w-28 shrink-0 rounded-xl" />}
    </div>
  )
}

/** Matches the 7 / 30 / 90 day range pills. */
export function PillsSkeleton({ count = 3 }) {
  return (
    <div className="mb-4 flex gap-2">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-10 w-24 rounded-full" />
      ))}
    </div>
  )
}

/** Matches StatRow: grid-cols-2 on a phone, 4 across from lg. */
export function StatRowSkeleton({ count = 4 }) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} padded={false} className="p-4">
          <div className="flex items-start justify-between gap-3">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          </div>
          <Skeleton className="mt-3 h-8 w-16 rounded-lg" />
          <Skeleton className="mt-2 h-3 w-24" />
        </Card>
      ))}
    </div>
  )
}

export function SectionHeadingSkeleton() {
  return <Skeleton className="mb-3 h-4 w-40" />
}

export function CardSkeleton({ lines = 3, className = '' }) {
  return (
    <Card className={className}>
      <Skeleton className="h-4 w-32" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn('mt-3 h-3.5', i === lines - 1 ? 'w-1/2' : 'w-full')}
        />
      ))}
    </Card>
  )
}

/**
 * Bars of varied height, so it reads as a chart rather than a grey slab.
 * The pattern is fixed and cycled — see the note on Math.random above.
 */
const BAR_PATTERN = [34, 52, 41, 68, 88, 74, 96, 61, 47, 72, 55, 38, 64, 80, 45, 29]

export function ChartSkeleton({ height = 200, bars = 16, className = '' }) {
  return (
    <Card className={className}>
      <div className="flex items-end gap-[2px] border-b border-line" style={{ height }}>
        {Array.from({ length: bars }, (_, i) => (
          <div key={i} className="flex flex-1 justify-center">
            <Skeleton
              className="w-full rounded-t"
              style={{ height: `${BAR_PATTERN[i % BAR_PATTERN.length]}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-[2px]">
        {Array.from({ length: bars }, (_, i) => (
          <div key={i} className="flex flex-1 justify-center">
            {i % 3 === 0 && <Skeleton className="h-2.5 w-5" />}
          </div>
        ))}
      </div>
    </Card>
  )
}

/** A list of cards — staff rows, car rows, queue cards. */
export function RowsSkeleton({ rows = 4, height = 'h-[4.75rem]', className = '' }) {
  return (
    <div className={cn('space-y-2.5', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn(height, 'rounded-card')} />
      ))}
    </div>
  )
}

export function FilterBarSkeleton() {
  return (
    <Card padded={false} className="mb-4 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Skeleton className="h-12 flex-1 rounded-xl" />
        <div className="flex gap-2">
          <Skeleton className="h-12 w-32 rounded-xl" />
          <Skeleton className="h-12 w-32 rounded-xl" />
        </div>
      </div>
    </Card>
  )
}

export function TableSkeleton({ rows = 4, cols = 6, className = '' }) {
  return (
    <Card padded={false} className={cn('overflow-hidden', className)}>
      <div className="flex gap-4 border-b border-line px-4 py-3">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className={cn('h-3', i === 0 ? 'w-32' : 'flex-1')} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b border-line px-4 py-4 last:border-0">
          {Array.from({ length: cols }, (_, i) => (
            <Skeleton key={i} className={cn('h-4', i === 0 ? 'w-32' : 'flex-1')} />
          ))}
        </div>
      ))}
    </Card>
  )
}

/**
 * The Suspense fallback for a lazily-loaded route.
 *
 * Deliberately generic — at this point the route's own module has not been
 * downloaded, so nothing knows which page is coming. It renders inside
 * AppShell, so the sidebar, top bar and property name stay put: the operator
 * sees the app, not a blank screen, and can still navigate somewhere else
 * while a chunk is still arriving on bad wifi.
 */
export default function RouteSkeleton() {
  return (
    <>
      <HeaderSkeleton />
      <StatRowSkeleton />
      <SectionHeadingSkeleton />
      <RowsSkeleton rows={3} />
    </>
  )
}
