/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: scripts/generate-icons.mjs                                    │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   A one-off build script that renders brand/logo-mark-full.png into  │
 * │   the PNG icon sizes a PWA needs. Run it with:                       │
 * │       npm run logo && npm run icons                                 │
 * │                                                                     │
 * │   The source is the Ambria car mark, cut out of the delivered        │
 * │   lockup by scripts/extract-logo.mjs. Only the CAR — the "AMBRIA"    │
 * │   wordmark is illegible below about 128px and turns to mush in a     │
 * │   32px tab icon, so a lockup makes a worse icon than a mark does.    │
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
const source = path.join(import.meta.dirname, '..', 'brand', 'logo-mark-full.png')

/** Brand navy — matches --c-brand in src/index.css and theme_color in the manifest. */
const BACKGROUND = '#0f172a'

const art_source = await readFile(source)

/**
 * Renders the logo at `size`, optionally inset so a launcher can crop it.
 *
 * `inset` is the fraction of the canvas the artwork occupies. 1 = full bleed
 * (standard icons, shown as-is). 0.6 = artwork fills the middle 60%, leaving a
 * safe margin all round (maskable icons).
 */
async function render(size, { inset = 1, filename }) {
  const art = Math.round(size * inset)
  const pad = Math.round((size - art) / 2)

  // No `density`: that only means anything for an SVG. The source is a raster
  // wide enough (664px) that every size below is a downscale, never an upscale.
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
      // Flat navy rather than transparency: a transparent maskable icon shows
      // the launcher's own background through it, which looks like a bug.
      background: BACKGROUND,
    },
  })
    .composite([{ input: artwork, top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer()

  await writeFile(path.join(publicDir, filename), out)
  console.log(`  ${filename.padEnd(28)} ${size}x${size}${inset < 1 ? `  (safe zone ${inset * 100}%)` : ''}`)
}

console.log('Generating PWA icons from brand/logo-mark-full.png')

// Standard icons — displayed exactly as provided.
await render(192, { filename: 'icon-192.png' })
await render(512, { filename: 'icon-512.png' })

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
await render(32, { filename: 'favicon-32.png' })
await render(180, { filename: 'favicon-180.png' })

console.log('Done.')
