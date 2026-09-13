/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/theme/background.js                                       │
 * │                                                                     │
 * │ WHAT THIS IS                                                        │
 * │   The one place the app looks for its background photograph.         │
 * │                                                                     │
 * │       src/theme/app-bg.<ext>     ← paste the file here, done         │
 * │                                                                     │
 * │   Nothing else in the codebase names the image. Both the app shell   │
 * │   and the login screen render <AppBackdrop/>, and AppBackdrop asks   │
 * │   this module — so replacing the photo everywhere is replacing one   │
 * │   file, and removing it everywhere is deleting one file.             │
 * │                                                                     │
 * │ ── WHY A GLOB AND NOT `import img from './app-bg.webp'` ─────────────│
 * │   Because the extension is the user's choice, not ours. The previous │
 * │   attempt hard-coded `app-bg.webp`; a .png was pasted in, the        │
 * │   filename never matched, and the page simply rendered no background │
 * │   with no error anywhere to say why. That cost a round trip.         │
 * │                                                                     │
 * │   The glob accepts webp, png, jpg, jpeg and avif. Whichever one is   │
 * │   actually there wins, so the paste cannot silently miss.            │
 * │                                                                     │
 * │ ── WHY src/theme AND NOT public/ ───────────────────────────────────│
 * │   An import from src/ goes through Vite, so the emitted file carries │
 * │   a CONTENT HASH: app-bg-a1b2c3d4.webp. Change the photo and the URL │
 * │   changes with it.                                                   │
 * │                                                                     │
 * │   That matters here specifically. Files in public/ keep their name   │
 * │   for ever, and sw.js caches images cache-first — so a replaced      │
 * │   public/ image keeps serving the OLD one out of the service worker  │
 * │   until its VERSION is bumped. A hashed URL has never been cached,   │
 * │   so it is fetched the first time it is asked for. One less way for  │
 * │   a change to land in the bundle and not on the screen.              │
 * │                                                                     │
 * │   Vite also inlines anything under ~4 KB as a data: URI and leaves   │
 * │   larger files as their own request, which is the right behaviour    │
 * │   either way.                                                        │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   src/theme/AppBackdrop.jsx — the only consumer.                     │
 * └─────────────────────────────────────────────────────────────────────┘
 */

/**
 * Every candidate filename, resolved to a URL at build time.
 *
 * `eager` because there is exactly one small module-level value to produce and
 * a lazy import would make the background arrive a frame after the page.
 * `query: '?url'` + `import: 'default'` asks Vite for the emitted URL rather
 * than the file's contents.
 *
 * The pattern MUST be a literal — Vite rewrites this call at build time and
 * cannot follow a variable. So the extension list lives here, in the pattern.
 */
// jfif and jpe are in the list because WINDOWS SAVES JPEGs AS .jfif. A photo
// dragged out of Chrome or Paint on Windows routinely lands as app-bg.jfif —
// it happened the first time this folder was used — and without the extension
// here the glob matches nothing, no asset is emitted, and the page renders with
// no background and no error. Exactly the silent miss this glob exists to stop.
// vite.config.js carries the matching assetsInclude entry.
const candidates = import.meta.glob('./app-bg.{webp,png,jpg,jpeg,jpe,jfif,avif,gif}', {
  eager: true,
  query: '?url',
  import: 'default',
})

/**
 * The background image URL, or null when no file has been pasted in yet.
 *
 * NULL IS A SUPPORTED STATE, not an error. AppBackdrop renders the veil over
 * the page's own surface colour and the app looks exactly as it did before the
 * photograph existed — so this ships whether or not anyone has supplied one,
 * and nothing has to be edited to turn it off.
 *
 * Sorted so that two files pasted in by accident resolve to the same one on
 * every machine and every build, rather than to whatever the filesystem
 * happened to list first.
 */
const paths = Object.keys(candidates).sort()

export const BACKGROUND_URL = paths.length > 0 ? candidates[paths[0]] : null

/** True when a photograph is present. Kept as its own export so callers read
 *  as intent (`hasBackground`) rather than as a null check. */
export const hasBackground = BACKGROUND_URL !== null

// A build-time note in the terminal, once, when the folder is empty. Not a
// warning — an empty folder is a valid configuration — but the difference
// between "no photo supplied" and "photo supplied and something is broken" is
// worth five seconds of somebody's time.
if (import.meta.env.DEV && paths.length === 0) {
  console.info(
    '[theme] no background image found. Paste one as src/theme/app-bg.webp ' +
      '(or .png / .jpg / .jpeg / .avif) — see src/theme/README.md',
  )
}
