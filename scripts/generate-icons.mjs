/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: scripts/generate-icons.mjs                                    │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   A one-off build script that renders the Ambria artwork into the    │
 * │   PNG icon sizes a PWA needs. Run it with:                          │
 * │       npm run logo && npm run icons                                 │
 * │                                                                     │
 * │   TWO sources, both cut out by scripts/extract-logo.mjs:             │
 * │     logo-lockup-full.png  car + "AMBRIA" — every app icon            │
 * │     logo-mark-full.png    the car alone  — the 32px tab favicon      │
 * │                                                                     │
 * │   Split because the wordmark needs about 128px to be a word. On a    │
 * │   home-screen icon it is comfortably legible and says who the app    │
 * │   belongs to; at 32px it is four grey smudges that read as a broken  │
 * │   image, so the tab gets the car on its own.                         │
 * │                                                                     │
 * │ ── CORNERS ──────────────────────────────────────────────────────────│
 * │   Rounded on the standard icons and favicons, SQUARE on maskable and │
 * │   apple-touch. Android and iOS mask those two themselves, and        │
 * │   rounding first rounds twice — a visible notch out of each corner.  │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Chrome will NOT show the "Install app" prompt unless the manifest │
 * │   lists a raster icon of at least 192x192 and one of 512x512. An     │
 * │   SVG icon alone is silently ignored for installability — the app    │
 * │   works, but the install button never appears and nobody can tell    │
 * │   you why. Android also needs a MASKABLE icon, or the launcher       │
 * │   crops our logo inside its own circle and clips the edges.          │
 * │                                                                     │
 * │ WHAT "MASKABLE" MEANS HERE                                           │
 * │   Android may crop a maskable icon to any shape (circle, squircle,   │
 * │   rounded square). Only the middle ~80% is guaranteed visible — the  │
 * │   "safe zone". So the maskable version is rendered at 60% scale on   │
 * │   a full-bleed background, giving the launcher room to crop without  │
 * │   ever cutting the car.                                             │
 * │                                                                     │
 * │ WHY A SCRIPT INSTEAD OF COMMITTED PNGs                                │
 * │   The logo is defined once, in brand/ambria-logo.png. Re-running     │
 * │   `npm run logo && npm run icons` regenerates every size, so the      │
 * │   icons cannot drift out of sync with                                 │
 * │   the brand — which is what happens when someone swaps the logo and  │
 * │   forgets the six PNGs sitting next to it.                          │
 * │                                                                     │
 * │ OUTPUT (all into public/)                                            │
 * │   icon-192.png, icon-512.png       — standard, used by the manifest  │
 * │   icon-maskable-192/512.png        — Android adaptive icons          │
 * │   apple-touch-icon.png (180)       — iOS home screen                 │
 * │   favicon-32.png                   — browser tab fallback            │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   sharp (devDependency — build tool only, never shipped)             │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const publicDir = path.resolve(import.meta.dirname, '..', 'public')
// brand/logo-mark-full.png, NOT public/logo-mark.png.
//
// The public copy is deliberately shrunk to ~220px for page weight, and a 512px
// icon rendered from that is an upscale — soft edges on the one image users see
// on their home screen. The full-resolution copy lives in brand/, which is
// outside the build, and both come from `npm run logo`.
const brandDir = path.join(import.meta.dirname, '..', 'brand')

/**
 * Two sources, because the right artwork depends on how big it will be seen.
 *
 * LOCKUP (car + "AMBRIA") for anything 180px and up — a home-screen icon is
 * rendered around that size and the wordmark is comfortably legible, so the icon
 * says who it is rather than just showing a car.
 *
 * MARK (car alone) for the 32px tab favicon. "AMBRIA" at 32px is four grey
 * smudges; it does not read as a word, it reads as a broken image.
 */
const LOCKUP = path.join(brandDir, 'logo-lockup-full.png')
const MARK = path.join(brandDir, 'logo-mark-full.png')

/**
 * The plate the artwork sits on: the app's own brand black, the same value as
 * --c-brand in src/index.css and theme-color in index.html and the manifest.
 *
 * Not brand navy (#0f172a), which this used to be. The artwork is drawn on
 * black, so a navy plate behind it made the home-screen icon read as a different
 * logo to the one on the letterhead — near-black next to navy is obvious side by
 * side, which is exactly how an app icon is seen.
 *
 * Deliberately NOT sampled from the artwork's own corners, which measure
 * rgb(16,18,20). That is the same black plus encoding noise, and chasing it
 * would drift the icon a shade away from the app chrome every time the logo is
 * re-exported. One token, three places, no drift.
 */
const BACKGROUND = '#0b0b0c'


/**
 * Renders the logo at `size`, optionally inset so a launcher can crop it.
 *
 * `inset` is the fraction of the canvas the artwork occupies. 1 = full bleed
 * (standard icons, shown as-is). 0.6 = artwork fills the middle 60%, leaving a
 * safe margin all round (maskable icons).
 */
async function render(size, { inset = 1, filename, art_file = LOCKUP, rounded = false }) {
  const art = Math.round(size * inset)
  const pad = Math.round((size - art) / 2)
  const art_source = await readFile(art_file)

  // No `density`: that only means anything for an SVG. The sources are rasters
  // wide enough (both 1024px) that every size below is a downscale, never an
  // upscale — which is why extract-logo.mjs emits full-resolution copies into
  // brand/ alongside the small ones it puts in public/.
  //
  // `contain` into a SQUARE with a 2.7:1 mark gives a full-width car centred
  // vertically, with empty bands above and below. That is the right treatment —
  // stretching it to fill would distort the car, and cropping would cut it.
  const artwork = await sharp(art_source)
    .resize(art, art, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()

  const out = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      // Flat colour rather than transparency: a transparent maskable icon
      // shows the launcher's own background through it, which looks like a bug.
      background: BACKGROUND,
    },
  })
    .composite([{ input: artwork, top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer()

  // ── rounded corners, and only where nothing else will round them ──
  //
  // The favicon.svg this replaced had rx="14" on a 64px square, and dropping
  // that made the tab icon a hard-edged black box.
  //
  // NOT applied to maskable or apple-touch: Android and iOS apply their OWN
  // mask to those. Rounding first means rounding twice, which shaves a visible
  // notch out of each corner.
  const final = rounded
    ? await sharp(out)
        .composite([
          {
            input: Buffer.from(
              `<svg width="${size}" height="${size}">` +
                `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="#fff"/>` +
                `</svg>`,
            ),
            blend: 'dest-in',
          },
        ])
        .png({ compressionLevel: 9 })
        .toBuffer()
    : out

  await writeFile(path.join(publicDir, filename), final)
  console.log(`  ${filename.padEnd(28)} ${size}x${size}${inset < 1 ? `  (safe zone ${inset * 100}%)` : ''}`)
}

console.log('Generating PWA icons — lockup for the app, car only for the 32px favicon')

// Standard icons — shown as provided, so they round their own corners.
//
// inset 0.86, not full bleed: at 1 the lockup spans the whole width and the
// outer letters of "AMBRIA" run into the rounded corners. A logo touching its
// own frame reads as cropped.
await render(192, { inset: 0.86, filename: 'icon-192.png', rounded: true })
await render(512, { inset: 0.86, filename: 'icon-512.png', rounded: true })

// Maskable icons — Android crops these, so keep the art inside the safe zone.
await render(192, { inset: 0.6, filename: 'icon-maskable-192.png' })
await render(512, { inset: 0.6, filename: 'icon-maskable-512.png' })

// iOS home screen. iOS ignores `purpose: maskable` and applies its own
// rounded-square mask, so a small inset keeps the wheels off the corners.
await render(180, { inset: 0.72, filename: 'apple-touch-icon.png' })

// Tab favicon. index.html points at these PNGs and no longer at an SVG: the
// brand arrived as a raster, and a stale favicon.svg listed FIRST would have
// won in every browser that prefers SVG — showing the old logo in the tab while
// every other icon showed the new one.
// The car alone here: see the note on MARK above.
await render(32, { filename: 'favicon-32.png', art_file: MARK, rounded: true })
await render(180, { inset: 0.86, filename: 'favicon-180.png', rounded: true })

console.log('Done.')
