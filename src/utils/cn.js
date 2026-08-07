/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/utils/cn.js                                               │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   A one-function helper that joins Tailwind class strings and drops  │
 * │   anything falsy, so conditional classes read cleanly:               │
 * │                                                                     │
 * │     cn('base', isActive && 'ring-2', disabled ? 'opacity-50' : null) │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Without it you end up with template strings like                   │
 * │     `base ${isActive ? 'ring-2' : ''} ${disabled ? '...' : ''}`      │
 * │   which produce double spaces and the literal words "false" and     │
 * │   "undefined" in the class attribute when a condition is falsy.      │
 * │                                                                     │
 * │ WHY NOT clsx + tailwind-merge                                        │
 * │   Those are two dependencies to solve a conflict problem we avoid by │
 * │   construction: every component in ui/ puts the caller's `className` │
 * │   LAST, so a caller override always wins the CSS cascade already.    │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   Every component in src/components.                                 │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   Nothing.                                                          │
 * └─────────────────────────────────────────────────────────────────────┘
 */

export function cn(...parts) {
  return parts.filter(Boolean).join(' ')
}

export default cn
