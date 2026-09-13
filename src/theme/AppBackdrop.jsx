/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/theme/AppBackdrop.jsx                                     │
 * │                                                                     │
 * │ WHAT THIS IS                                                        │
 * │   The photograph behind every screen, and the veil that makes it     │
 * │   survivable behind an operations UI.                                │
 * │                                                                     │
 * │   Paste the photo at src/theme/app-bg.<ext> — see README.md in this  │
 * │   folder. This component names no filename; background.js does.      │
 * │                                                                     │
 * │ ── THE VEIL IS A GRADIENT, NOT A FLAT WASH ─────────────────────────│
 * │   A flat veil has to be strong enough for the worst spot on the      │
 * │   photograph, which means the whole photograph ends up as strong as  │
 * │   its worst spot — you pay for the image and then hide it.           │
 * │                                                                     │
 * │   The gradient runs nearly solid at the BOTTOM-LEFT, which is where  │
 * │   the rail and the content are, and opens up toward the TOP-RIGHT,   │
 * │   which on every screen in this app is either empty or the tail of   │
 * │   a card row. So the photograph is visible where nothing has to be   │
 * │   read and absent where something does.                              │
 * │                                                                     │
 * │   It is painted in the page's OWN surface colour, so it goes dark at │
 * │   night instead of glowing. Its two ends are --veil-near and         │
 * │   --veil-far in index.css.                                           │
 * │                                                                     │
 * │ ── WHY THIS SURVIVES BEHIND A WORKING SCREEN ───────────────────────│
 * │   Because the app is built out of cards, and a card is opaque.       │
 * │   bg-surface is a solid colour in both themes, so every number and   │
 * │   name sits on its own flat ground no matter what is behind the      │
 * │   page. Put the same photograph behind bare text and it would be     │
 * │   unreadable — the card layout is what buys this, not the veil.      │
 * │                                                                     │
 * │ ── FIXED, NOT SCROLLING ────────────────────────────────────────────│
 * │   A background that scrolls with a long dashboard drags the eye and  │
 * │   runs out at the bottom of a tall page. Fixed, it behaves like a    │
 * │   window the content moves across.                                   │
 * │                                                                     │
 * │ ── OPTIONAL BY DESIGN ──────────────────────────────────────────────│
 * │   No photo pasted in yet? The image layer is not rendered at all and │
 * │   the veil covers a plain bg-surface-sunken, so the app looks        │
 * │   exactly as it did before. It ships either way.                     │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   components/AppShell (every signed-in screen) and pages/Login.      │
 * │   One mechanism, so the front door and the app cannot drift apart.   │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { BACKGROUND_URL } from '@/theme/background'

/**
 * `veilInset` — start the VEIL where the navigation rail ends (md and up).
 * The photograph itself always covers the whole viewport.
 *
 * ── WHY THIS EXISTS: DEFENCE, NOT DECORATION ──
 * The rail is opaque near-black by design, so nothing painted behind it is
 * ever visible. But both of these layers are `fixed`, and a fixed element
 * paints above ordinary in-flow content whatever the DOM order — so the moment
 * a z-index is missing or wrong, the veil washes over the rail and turns it
 * mid-grey. That failure has already been reported four times on this project.
 *
 * The z-index below is correct. This makes it moot: with the backdrop stopping
 * at the rail's edge there is nothing over the rail to get the ordering wrong
 * about, and the rail cannot be washed out by this component however the
 * layers end up stacked.
 *
 * AppShell passes it. Login does NOT, and must not — that page has no rail,
 * so an inset there would leave an unveiled strip of raw photograph down the
 * side of the sign-in screen.
 */
export default function AppBackdrop({ veilInset = false }) {
  // ── THE PHOTO IS ALWAYS FULL BLEED; ONLY THE VEIL MOVES ──────────────
  // The rail is a thin glass panel, and glass is only glass if there is
  // something behind it. The veil is near-solid at its start — that corner is
  // where the content lives — and the rail sits in exactly that corner, so
  // the photograph was being wiped out precisely where it needed to show.
  //
  // Insetting the VEIL and not the image leaves raw photograph behind the
  // rail, which the rail then veils itself with its own tint and blur. That
  // is what makes it read as frosted glass instead of a pale panel that
  // happens to blur nothing.
  //
  // w-72 on the rail, so md:left-72 here. THESE TWO NUMBERS MUST MATCH — see
  // the note on the <aside> in AppShell.
  const photoBox = 'fixed inset-0'
  const veilBox = veilInset ? 'fixed inset-y-0 left-0 right-0 md:left-72' : 'fixed inset-0'

  return (
    <>
      {/* aria-hidden and pointer-events-none on both layers: they cover the
          viewport, and without the latter they would swallow every click on
          the page behind them.

          z-0 is not cosmetic — see the note on leftInset above. Whatever
          renders these MUST sit on an explicit higher layer (AppShell uses
          z-10). Two elements both on z-auto are ordered by source alone,
          which is how this broke before. */}
      {/* Rendered only when a photo exists. An empty src or a background-image
          of `url(null)` would be a wasted request that resolves to the
          current page and, in dev, a confusing 404 in the network panel. */}
      {BACKGROUND_URL && (
        <div
          aria-hidden
          className={`app-backdrop pointer-events-none ${photoBox} z-0 bg-cover bg-center bg-no-repeat`}
          style={{ backgroundImage: `url(${BACKGROUND_URL})` }}
        />
      )}

      {/* The veil. Always rendered, photo or not: with no photo it is a
          gradient of the surface colour over the surface colour, which is
          invisible and costs nothing — and that is what makes the photograph
          genuinely optional instead of conditionally wired. */}
      <div aria-hidden className={`app-backdrop app-veil pointer-events-none ${veilBox} z-0`} />
    </>
  )
}
