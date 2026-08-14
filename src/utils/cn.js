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
 * │   Two dependencies, and most overrides do not need them. But be      │
 * │   clear about what this does NOT do: it does not resolve conflicts.  │
 * │                                                                     │
 * │ ── IT WILL NOT WIN A CONFLICT FOR YOU ───────────────────────────────│
 * │   This used to claim that because ui/ components put the caller's    │
 * │   `className` LAST, a caller override "always wins the cascade".     │
 * │   That is not how CSS works. Order inside the class ATTRIBUTE means  │
 * │   nothing; for two utilities of equal specificity the winner is      │
 * │   whichever comes later in the GENERATED STYLESHEET.                 │
 * │                                                                     │
 * │   Measured, on the delete button in admin/Spaces: Button's `ghost`   │
 * │   variant sets text-ink-muted, the caller passed text-danger, and    │
 * │   the icon rendered rgb(71,85,105) — the variant's colour. The fix   │
 * │   is the important modifier, `!text-danger`.                          │
 * │                                                                     │
 * │   So: adding a class this component does not already set works fine. │
 * │   REPLACING one it does set needs `!`, and needs checking in the     │
 * │   browser rather than assuming.                                      │
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
