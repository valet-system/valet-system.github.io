/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/utils/appHeight.js                                        │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Keeps a CSS variable, --app-h, equal to the height a phone user    │
 * │   can actually see.                                                  │
 * │                                                                     │
 * │ ── WHY A VARIABLE AND NOT JUST 100dvh ───────────────────────────────│
 * │   100dvh is the right answer and src/index.css uses it — but it      │
 * │   needs Safari 15.4, Chrome 108, Firefox 101. Older than that and    │
 * │   the declaration is dropped, the 100vh fallback takes over, and the │
 * │   nav drawer's footer goes back under the browser chrome exactly as  │
 * │   it did before. "Works in one browser, broken in another" is what   │
 * │   that failure looks like from the outside.                          │
 * │                                                                     │
 * │   So: --app-h is measured here and used as the fallback BEFORE dvh.  │
 * │   A browser that understands dvh ignores it; one that does not gets  │
 * │   a number that is correct anyway.                                    │
 * │                                                                     │
 * │ ── visualViewport, THEN innerHeight ─────────────────────────────────│
 * │   visualViewport.height is what is genuinely on screen and shrinks   │
 * │   when the on-screen keyboard opens. innerHeight does not, and on    │
 * │   older iOS it reports the address-bar-hidden height. Prefer the     │
 * │   first, fall back to the second.                                    │
 * │                                                                     │
 * │   The keyboard case matters here: an operator typing a guest's name  │
 * │   has half the screen left, and a panel sized to the full viewport   │
 * │   would put its buttons behind the keyboard.                          │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   src/main.jsx, once, at start-up. NOT dev-only — this one ships.    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

export function trackAppHeight() {
  const apply = () => {
    const height = window.visualViewport?.height ?? window.innerHeight
    // Rounded: a fractional pixel here produces a 1px seam under the drawer on
    // some zoom levels, which reads as a rendering fault.
    document.documentElement.style.setProperty('--app-h', `${Math.round(height)}px`)
  }

  apply()

  // resize covers rotation and desktop window drags. visualViewport covers the
  // address bar sliding away and the keyboard opening, neither of which fires a
  // window resize on every browser.
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', apply)
  window.visualViewport?.addEventListener('resize', apply)
}
