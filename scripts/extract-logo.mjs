/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: scripts/extract-logo.mjs                                      │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Turns the supplied brand artwork into the two images the app        │
 * │   actually uses. Run it with:                                        │
 * │       npm run logo                                                  │
 * │                                                                     │
 * │   IN   brand/ambria-logo.png   the lockup as delivered: gold car     │
 * │                               above the AMBRIA wordmark, on black,   │
 * │                               no transparency, 1402x1122            │
 * │                                                                     │
 * │   OUT  public/logo-mark.png    the CAR alone, transparent            │
 * │        public/logo-lockup.png  car + wordmark, transparent           │
 * │                                                                     │
 * │ ── WHY THE SOURCE IS NOT IN public/ ─────────────────────────────────│
 * │   Everything in public/ is copied into dist/ and deployed. The        │
 * │   source is 900 KB and no page ever requests it, so shipping it put   │
 * │   900 KB of dead weight on a site whose whole point is loading fast   │
 * │   on a cheap phone. brand/ is outside the build.                      │
 * │                                                                     │
 * │ ── HOW THE BACKGROUND COMES OFF ─────────────────────────────────────│
 * │   The artwork has no alpha channel and its background is near-flat    │
 * │   very dark (measured: rgb(10..14)), while the car is gold and the    │
 * │   wordmark white. So alpha is derived from LUMINANCE — dark becomes   │
 * │   transparent — with a soft ramp rather than a hard cut, or every     │
 * │   antialiased edge would come out jagged.                            │
 * │                                                                     │
 * │   The car is an outline, so the black INSIDE it drops out too. That   │
 * │   is wanted: the mark then sits on any dark surface without carrying  │
 * │   a visible black rectangle around with it.                          │
 * │                                                                     │
 * │ ── WHY TWO CROPS, AND WHY THE MARK HAS NO WORDMARK ──────────────────│
 * │   "AMBRIA" is unreadable below about 128px. In a 32px tab icon or a   │
 * │   26px drawer badge it is mush that makes the whole logo look         │
 * │   broken, so anywhere small gets the car alone.                       │
 * │                                                                     │
 * │ ── AND WHY THEY ARE RESIZED DOWN ────────────────────────────────────│
 * │   These are shipped to every operator on first load. The lockup is    │
 * │   displayed at 168x81 and the mark at most 72x26; emitting them at    │
 * │   the source's 919px and 664px cost 351 KB and 156 KB for pixels no   │
 * │   screen can show. Held at 3x the largest display size, which covers  │
 * │   the densest phone.                                                  │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   sharp (devDependency — build tool only, never shipped)             │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import path from 'node:path'
import sharp from 'sharp'

const root = path.resolve(import.meta.dirname, '..')
const source = path.join(root, 'brand', 'ambria-logo.png')
const publicDir = path.join(root, 'public')

/** Below this luminance a pixel is background. Measured: the black is 10-14. */
const DARK = 18
/** Fully opaque at and above this. The ramp between the two keeps edges smooth. */
const SOLID = 58
/** Anything brighter than this counts as artwork when finding the bounds. */
const INK = 40

const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true })
const { width: W, height: H, channels: C } = info

const lumAt = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]

/**
 * ── REPAIRING THE LAST "A" ────────────────────────────────────────────────
 *
 * In the delivered artwork BOTH A's are drawn with their right stroke broken:
 * a bare "Λ" with a small detached wedge floating at the bottom right. Measured
 * on brand/ambria-logo.png, the two glyphs are pixel-for-pixel the same shape
 * (each split on 61 of its 126 rows, at the same rows), so this is how the
 * typeface was drawn — but at the sizes this app shows it, the last one reads
 * as a letter that got clipped.
 *
 * So the last A is closed up and given a crossbar. ONLY the last one, on
 * request — the first A is left exactly as delivered.
 *
 * The numbers are measured off the source, not guessed:
 *   apex               x1086, y657
 *   stroke weight      21px
 *   right stroke       upper piece ends y734 at x1104-1124
 *                      lower piece resumes y767 at x1119-1140
 *   so the gap is that same bar continuing on the same diagonal.
 *
 * This edits the pixel buffer in memory. brand/ambria-logo.png itself is never
 * written to, so the original stays the original — delete this function and
 * re-run `npm run logo` to get back to the artwork as supplied.
 */
function repairLastA() {
  const white = (x, y) => {
    const i = (y * W + x) * C
    data[i] = 255
    data[i + 1] = 255
    data[i + 2] = 255
  }

  // Bridge the break: interpolate the stroke's left edge across the gap and
  // fill the stroke's own width to the right of it.
  for (let y = 734; y <= 767; y++) {
    const t = (y - 734) / (767 - 734)
    const left = Math.round(1104 + t * (1119 - 1104))
    for (let x = left; x <= left + 20; x++) white(x, y)
  }

  // The crossbar, spanning inner edge to inner edge. Both strokes drift right
  // as y grows, so both ends track that diagonal instead of sitting at fixed x.
  //
  // Centred on y755, 21px tall to match the stroke weight. The height is worth
  // stating because it is the whole look of the letter: the A runs y657-783, so
  // this sits about a fifth of the way up from the baseline. Higher and it
  // reads as a different typeface to the rest of the word; much lower and the
  // counter closes up and the A turns into a triangle.
  for (let y = 745; y <= 765; y++) {
    const t = (y - 734) / (767 - 734)
    const from = Math.round(1069 - t * (1069 - 1053))
    const to = Math.round(1104 + t * (1119 - 1104))
    for (let x = from; x <= to; x++) white(x, y)
  }
}

repairLastA()

/**
 * The tight box around everything brighter than INK, within a band of rows.
 *
 * A band, because the car and the wordmark are two separate blocks of bright
 * pixels with a dark gap between them — so "the car" is a row range, not a
 * cleverer kind of search.
 */
function boundsWithin(yFrom, yTo) {
  let minX = W
  let maxX = 0
  let minY = H
  let maxY = 0

  for (let y = yFrom; y < yTo; y++) {
    for (let x = 0; x < W; x++) {
      if (lumAt((y * W + x) * C) <= INK) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < minX) throw new Error(`nothing brighter than ${INK} between rows ${yFrom}-${yTo}`)
  return { minX, maxX, minY, maxY }
}

/**
  * Crops the box, keys the background out, and writes it at `outWidth`.
  *
  * `dir` exists because the two consumers want opposite things: the app wants
  * these small, and generate-icons.mjs renders a 512px icon and so needs a
  * source at least that wide. A 220px mark upscaled to 512 is a soft icon, which
  * is exactly what the icon script's own comment promises never happens.
  */
async function emit({ box, pad, outWidth, filename, dir = publicDir }) {
  const left = Math.max(0, box.minX - pad)
  const top = Math.max(0, box.minY - pad)
  const w = Math.min(W - left, box.maxX - box.minX + 1 + pad * 2)
  const h = Math.min(H - top, box.maxY - box.minY + 1 + pad * 2)

  // From the repaired pixel buffer, NOT from `source` again — re-reading the
  // file here would silently discard repairLastA() and ship the broken glyph.
  const crop = await sharp(data, { raw: { width: W, height: H, channels: C } })
    .extract({ left, top, width: w, height: h })
    .raw()
    .toBuffer()

  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0, o = 0; i < crop.length; i += 3, o += 4) {
    const l = 0.2126 * crop[i] + 0.7152 * crop[i + 1] + 0.0722 * crop[i + 2]
    const alpha = Math.max(0, Math.min(1, (l - DARK) / (SOLID - DARK)))
    rgba[o] = crop[i]
    rgba[o + 1] = crop[i + 1]
    rgba[o + 2] = crop[i + 2]
    rgba[o + 3] = Math.round(alpha * 255)
  }

  const out = path.join(dir, filename)
  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .resize({ width: outWidth, fit: 'inside', withoutEnlargement: true })
    // palette: these are two flat colours and their antialiasing, so an indexed
    // PNG is visually identical at a fraction of the size.
    .png({ compressionLevel: 9, palette: true })
    .toFile(out)

  const meta = await sharp(out).metadata()
  // statSync, not meta.size: sharp only fills that in when it read from a
  // buffer, so it came out NaN here and reported nothing.
  const bytes = (await import('node:fs')).statSync(out).size
  console.log(`  ${filename.padEnd(24)} ${meta.width}x${meta.height}  ${(bytes / 1024).toFixed(0)} KB`)
}

// The bands, found by profiling bright pixels per row: the car sits well above
// the wordmark with a dark gap in between.
const CAR_BAND = [330, 610]

console.log(`Extracting from brand/ambria-logo.png (${W}x${H})`)

const car = boundsWithin(...CAR_BAND)
const all = boundsWithin(0, H)

// 3x the largest place each is displayed: the mark at 72px wide, the lockup at
// 168px. Anything more is bytes no screen can resolve.
await emit({ box: car, pad: 10, outWidth: 220, filename: 'logo-mark.png' })
await emit({ box: all, pad: 12, outWidth: 520, filename: 'logo-lockup.png' })

// Full resolution, for generate-icons.mjs only. In brand/ and not public/,
// because nothing at runtime requests it and public/ is deployed verbatim.
await emit({
  box: car,
  pad: 10,
  outWidth: 1024,
  filename: 'logo-mark-full.png',
  dir: path.join(root, 'brand'),
})

// The full lockup at full resolution, for the home-screen icons. The wordmark
// is legible at 192px and up, which is where an app icon actually lives; only
// the 32px tab favicon still gets the car alone.
await emit({
  box: all,
  pad: 12,
  outWidth: 1024,
  filename: 'logo-lockup-full.png',
  dir: path.join(root, 'brand'),
})

console.log('Done. Now run `npm run icons` — those render from brand/logo-mark-full.png.')
