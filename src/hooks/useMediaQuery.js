/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/hooks/useMediaQuery.js                                    │
 * │                                                                     │
 * │ WHAT THIS IS                                                        │
 * │   A media query as React state, so a component can be MOUNTED or    │
 * │   NOT mounted per viewport — rather than merely hidden.             │
 * │                                                                     │
 * │ ── WHY THIS EXISTS, AND IT IS NOT A STYLING CONCERN ────────────────│
 * │   `md:hidden` is CSS. The component still mounts, still runs its    │
 * │   effects, still opens its subscriptions — it is simply not painted. │
 * │   For layout that is exactly right and this hook would be the wrong │
 * │   tool. Reach for Tailwind's breakpoints every time.                 │
 * │                                                                     │
 * │   It is wrong when mounting TWICE is itself the bug. The top bar and │
 * │   the navigation rail each render a <NotificationBell>, one for      │
 * │   phones and one for desktop, and only ever one is visible. Both     │
 * │   mounted. Both called supabase.channel(`bell:<id>`) — the SAME      │
 * │   name, so the client handed the second one the channel the first    │
 * │   had already subscribed to, and adding a listener to a subscribed   │
 * │   channel throws:                                                    │
 * │                                                                     │
 * │     cannot add `postgres_changes` callbacks for realtime:bell:...    │
 * │     after `subscribe()`                                              │
 * │                                                                     │
 * │   That error escaped render and took the whole app down to a blank   │
 * │   page — no rail, no content, nothing but the background colour.     │
 * │                                                                     │
 * │   Two channel names would have silenced it and been worse: two live  │
 * │   subscriptions to the same rows, two alert sounds for one car.      │
 * │   Mounting one bell is the actual fix.                               │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   components/AppShell — to mount the top bar OR the rail controls.   │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useState } from 'react'

/**
 * @param query a CSS media query, e.g. '(min-width: 768px)'
 * @returns whether it currently matches
 */
export default function useMediaQuery(query) {
  // Read synchronously on the first render, not in an effect. An effect would
  // make the first paint always the "false" branch — so on a desktop the phone
  // top bar would mount for one frame, open its subscription, and unmount
  // again, which is the very thing this hook exists to prevent.
  const [matches, setMatches] = useState(() => window.matchMedia?.(query)?.matches ?? false)

  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return undefined

    const onChange = () => setMatches(mq.matches)
    // Once immediately: the query can have changed between the initial render
    // and this effect running — rotating a tablet during load is enough.
    onChange()

    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}
