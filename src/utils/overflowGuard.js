/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/utils/overflowGuard.js                                    │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   A development-only watchdog that shouts, with the element's name,  │
 * │   the moment the page becomes scrollable sideways.                    │
 * │                                                                     │
 * │ ── WHY IT EXISTS ────────────────────────────────────────────────────│
 * │   Sideways scroll on a phone has been the single most reported fault │
 * │   in this app, and every time it took a long hunt to find the one    │
 * │   element that could not shrink. It is also the least visible fault  │
 * │   there is on a laptop: at 1280px nothing overflows, so it ships.    │
 * │                                                                     │
 * │   src/index.css now CLIPS horizontal overflow at the root, so an     │
 * │   operator never gets a page that slides under their thumb. That     │
 * │   fixes the symptom and hides the cause — which is exactly why this  │
 * │   exists. Clip for them, name and shame for us.                      │
 * │                                                                     │
 * │ ── IT IS NOT IN THE PRODUCTION BUNDLE ───────────────────────────────│
 * │   The whole body is behind `import.meta.env.DEV`, so the bundler     │
 * │   drops it. Nothing here runs on an operator's phone.                │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   src/main.jsx, once, at start-up                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

/** Names the widest thing sticking out, ignoring anything meant to scroll. */
function findCulprit() {
  const root = document.documentElement
  const width = root.clientWidth
  let worst = null

  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect()
    if (!rect.width) continue
    if (rect.right <= width + 1 && rect.left >= -1) continue

    // A wide table inside its own overflow-x container is the documented
    // pattern, not a bug. Walk up and skip anything already handled.
    let parent = el.parentElement
    let handled = false
    while (parent && parent !== document.body) {
      const overflowX = window.getComputedStyle(parent).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'clip' || overflowX === 'hidden') {
        handled = true
        break
      }
      parent = parent.parentElement
    }
    if (handled) continue

    if (!worst || rect.right > worst.rect.right) worst = { el, rect }
  }
  return worst
}

export function watchForOverflow() {
  if (!import.meta.env.DEV) return

  let last = -1

  const check = () => {
    const root = document.documentElement
    // scrollWidth is clipped at the root now, so measure the CONTENT instead:
    // body's scrollWidth still grows when a child sticks out.
    const overflow = Math.round(document.body.scrollWidth - root.clientWidth)
    if (overflow <= 1 || overflow === last) {
      if (overflow <= 1) last = -1
      return
    }
    last = overflow

    const worst = findCulprit()
    // eslint-disable-next-line no-console
    console.warn(
      `[layout] ${overflow}px of horizontal overflow at ${root.clientWidth}px wide.\n` +
        (worst
          ? `         <${worst.el.tagName.toLowerCase()} class="${worst.el.getAttribute('class') ?? ''}">\n` +
            `         spans ${Math.round(worst.rect.left)}..${Math.round(worst.rect.right)} — "${(worst.el.textContent ?? '').trim().slice(0, 40)}"\n`
          : '         could not pin it to one element.\n') +
        '         The root clips this so operators never see it. Fix the element, ' +
        'usually with min-w-0 / basis-0 / truncate.',
      worst?.el,
    )
  }

  // On resize and whenever the DOM settles, which covers route changes without
  // needing to know about the router.
  const debounced = (() => {
    let timer = null
    return () => {
      clearTimeout(timer)
      timer = setTimeout(check, 300)
    }
  })()

  window.addEventListener('resize', debounced)
  new MutationObserver(debounced).observe(document.body, { childList: true, subtree: true })
  debounced()
}
