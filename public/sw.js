/* eslint-env serviceworker */
/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: public/sw.js — the Service Worker                             │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The background script that makes this app installable and lets it  │
 * │   open without a network. It sits between the app and the network    │
 * │   and decides, per request, whether to serve from cache.             │
 * │                                                                     │
 * │   It lives in public/ (not src/) on purpose: Vite copies public/     │
 * │   verbatim to the site root, and a service worker can only control   │
 * │   pages at or below its own path. From /sw.js it controls the whole  │
 * │   origin. Bundled into /assets/sw-a1b2c3.js it would control         │
 * │   nothing.                                                          │
 * │                                                                     │
 * │ WHY IT IS HAND-WRITTEN INSTEAD OF vite-plugin-pwa                     │
 * │   That plugin pulls in workbox-build, which currently carries 8      │
 * │   high-severity advisories through its ejs dependency chain. They    │
 * │   are build-time only, but more importantly the caching policy this  │
 * │   app needs is unusually strict and easier to state directly than to │
 * │   configure. ~120 lines, zero dependencies, full control.            │
 * │                                                                     │
 * │ ══ THE CRITICAL RULE ══                                              │
 * │   SUPABASE REQUESTS ARE NEVER CACHED. NOT EVEN FOR A SECOND.         │
 * │                                                                     │
 * │   In a normal PWA you would cache API responses so the app works     │
 * │   offline. Here that would be actively dangerous. A cached response  │
 * │   could tell an operator a car is still parked when another operator │
 * │   is already fetching it, or show a token as free when it was        │
 * │   allocated 30 seconds ago. Two operators would hand over the same   │
 * │   car. Wrong data is worse than no data in this app, so live data    │
 * │   is network-only and failures surface as errors the operator sees.  │
 * │                                                                     │
 * │ THE THREE STRATEGIES                                                 │
 * │   1. /assets/*  -> CACHE FIRST.  Safe because Vite content-hashes    │
 * │      these filenames: if the file changes, its name changes, so a    │
 * │      cached copy can never be stale.                                 │
 * │   2. navigation -> NETWORK FIRST, cache fallback. Online you always  │
 * │      get the newest HTML; offline you get the last shell, so the app │
 * │      opens and can explain that it is offline instead of showing     │
 * │      the browser's dinosaur.                                        │
 * │   3. everything else (Supabase, Meta, any cross-origin) -> the SW    │
 * │      does not intervene at all.                                     │
 * │                                                                     │
 * │ THE PUSH TEXT IS TRANSLATED HERE TOO                                 │
 * │   A push arrives with the app CLOSED, so nothing React knows is       │
 * │   reachable from in here — no localStorage, no i18n provider. The     │
 * │   language is read from the Cache API, which the page writes to on    │
 * │   every change (see src/i18n/index.jsx), and the phrases below are a  │
 * │   HAND-COPIED subset of SERVER_PHRASES in src/i18n/autoTranslate.js.  │
 * │   Change one, change the other.                                       │
 * │                                                                     │
 * │ RELATED FILES                                                        │
 * │   src/pwa.js               — registers this file, handles updates    │
 * │   src/components/PwaStatus.jsx — the offline / update-ready banners  │
 * │   src/i18n/autoTranslate.js — the full table this one is a subset of │
 * │   public/manifest.json     — name, icons, install metadata           │
 * └─────────────────────────────────────────────────────────────────────┘
 */

// Bump this to force every client to discard its old caches. Any change to
// this file changes the SW bytes, which is what triggers an update check.
// Bump on every change to this file. The browser only replaces the worker when
// its BYTES change, and the caches below are keyed on this — so shipping a new
// sw.js without bumping leaves operators on the old one with the old cache.
// v2: added push + notificationclick handlers.
// v3: push text is translated to Hindi when that is the chosen language.
// v4: + "Car delivered" (migration 0023).
// v5: + "by <operator>" on the parked/delivered bodies (migration 0024).
// v6: + "Car re-parked" (migration 0025).
const VERSION = 'v6'

const SHELL_CACHE = `valet-shell-${VERSION}`
const ASSET_CACHE = `valet-assets-${VERSION}`

// ═══════════════════════════════════════════════════════════════════
// PUSH TEXT IN HINDI
//
// Kept deliberately small. This is the exact wording enqueue_task_push()
// writes — migrations 0014, 0019, 0023 and 0025 — and nothing else. A service
// worker is the wrong place for a general translator, and anything
// unrecognised is shown as it arrived rather than guessed at.
//
// scripts/check-autotranslate.mjs RUNS this file's toHindi() alongside the
// app's autoTranslate() and fails the build if they disagree, so the two
// copies cannot quietly drift apart.
// ═══════════════════════════════════════════════════════════════════

/** Written by the page whenever the language changes. Both names must match
 *  the constants in src/i18n/index.jsx. */
const PREFS_CACHE = 'valet-prefs'
const LANG_URL = '/__lang'

/** KEEP IN SYNC with SERVER_PHRASES in src/i18n/autoTranslate.js. */
const PUSH_HI = {
  'Car requested': 'गाड़ी माँगी गई',
  'Fetch a car': 'गाड़ी लानी है',
  'Guest did not arrive': 'गेस्ट नहीं आए',
  'Car parked': 'गाड़ी पार्क हो गई',
  'Car delivered': 'गाड़ी गेस्ट को दे दी',
  'Car re-parked': 'गाड़ी दोबारा पार्क हो गई',
  car: 'गाड़ी',
  'park it again and confirm the spot': 'दोबारा पार्क करके जगह बताइए',
  'Ambria Valet': 'एंब्रिया वैले',
  'You have a new task.': 'आपके लिए नया काम है।',
}

async function currentLang() {
  try {
    const cache = await caches.open(PREFS_CACHE)
    const hit = await cache.match(LANG_URL)
    return hit ? await hit.text() : 'en'
  } catch {
    // No cache, or storage evicted. English is the safe answer.
    return 'en'
  }
}

/**
 * The body is 'Token 47 · 4821 · Basement 2' — ours, then the car's, then a
 * place name an admin typed. Splitting on ' · ' and looking up each piece on
 * its own is what stops the last two from being rewritten.
 */
function toHindi(text) {
  if (!text) return text

  const one = (segment) => {
    const trimmed = segment.trim()
    if (PUSH_HI[trimmed]) return PUSH_HI[trimmed]

    const token = trimmed.match(/^Token (\d+|\?)$/)
    if (token) return `टोकन ${token[1]}`

    // 'by Rajesh' — who parked or delivered it. Same rule as SERVER_PATTERNS
    // in src/i18n/autoTranslate.js; the drift check runs both.
    const by = trimmed.match(/^by (.+)$/)
    if (by) return `${by[1]} ने`

    return segment
  }

  return text.includes(' · ') ? text.split(' · ').map(one).join(' · ') : one(text)
}

/**
 * Files fetched up front so a cold start with no network still renders.
 * Deliberately tiny — only what is needed to show the app frame. The hashed
 * JS/CSS bundles are not listed because their names are not known until build
 * time; strategy 1 picks them up on first visit instead.
 */
const SHELL_FILES = ['/', '/index.html', '/manifest.json', '/favicon.svg', '/icon-192.png']

/** Hosts whose responses must always come from the network. */
function isLiveData(url) {
  return (
    url.hostname.endsWith('.supabase.co') ||
    url.hostname.endsWith('.supabase.in') ||
    url.hostname.includes('graph.facebook.com')
  )
}

// ═══════════════════════════════════════════════════════════════════
// INSTALL — pre-cache the shell
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // addAll is atomic: one 404 fails the whole install. Add individually so
      // a single missing icon cannot stop the app being installable.
      await Promise.allSettled(SHELL_FILES.map((file) => cache.add(new Request(file, { cache: 'reload' }))))
      // Do not wait for existing tabs to close before this SW takes over.
      // Paired with clients.claim() below, an update applies on next load.
      await self.skipWaiting()
    })(),
  )
})

// ═══════════════════════════════════════════════════════════════════
// ACTIVATE — delete caches from older versions
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith('valet-') &&
              key !== SHELL_CACHE &&
              key !== ASSET_CACHE &&
              // NOT a versioned cache. This one holds the chosen language and
              // must survive an update — wiping it would silently drop every
              // operator's push notifications back to English on the next
              // deploy, which is the hardest kind of bug to notice.
              key !== PREFS_CACHE,
          )
          .map((key) => caches.delete(key)),
      )

      // navigationPreload lets the browser start fetching the page in parallel
      // with the SW booting, removing the SW startup cost from first paint.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {})
      }

      await self.clients.claim()
    })(),
  )
})

// ═══════════════════════════════════════════════════════════════════
// FETCH
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('fetch', (event) => {
  const { request } = event

  // Only GET can be cached. A POST that inserts a vehicle must never be
  // replayed from a cache — that would create duplicate cars.
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // ── RULE 1: live data — do not intervene ──────────────────────────
  // Returning without calling respondWith() hands the request straight to the
  // browser, exactly as if no service worker existed.
  if (isLiveData(url)) return

  // Ignore other origins (fonts, CDNs). Nothing here to gain, and caching
  // opaque cross-origin responses wastes quota.
  if (url.origin !== self.location.origin) return

  // ── RULE 2: navigations — network first, shell fallback ────────────
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // Use the preloaded response if the browser started one.
          const preloaded = await event.preloadResponse
          if (preloaded) return preloaded

          const fresh = await fetch(request)
          // Keep the latest shell for the next offline start.
          const cache = await caches.open(SHELL_CACHE)
          cache.put('/index.html', fresh.clone())
          return fresh
        } catch {
          // Offline. Serve the last good shell. This is a SPA, so index.html
          // can render any route once JS boots.
          const cache = await caches.open(SHELL_CACHE)
          const cached = (await cache.match('/index.html')) || (await cache.match('/'))
          if (cached) return cached
          return new Response('Offline and no cached copy available.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          })
        }
      })(),
    )
    return
  }

  // ── RULE 3: hashed build assets — cache first ─────────────────────
  const isBuildAsset =
    url.pathname.startsWith('/assets/') ||
    /\.(?:js|css|woff2?|png|svg|jpg|jpeg|webp|ico)$/.test(url.pathname)

  if (isBuildAsset) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE)
        const cached = await cache.match(request)
        if (cached) return cached

        try {
          const fresh = await fetch(request)
          // Only cache real successes. Caching an opaque or error response
          // means the app serves a broken file forever.
          if (fresh.ok && fresh.type === 'basic') cache.put(request, fresh.clone())
          return fresh
        } catch {
          // A missing font or image should degrade, not blank the page.
          return new Response('', { status: 504 })
        }
      })(),
    )
  }
})

// ═══════════════════════════════════════════════════════════════════
// PUSH — the only channel that reaches a closed app
//
// Everything else in this system needs the page to be running: realtime is a
// websocket the page owns, and a notification raised from page JavaScript dies
// with the tab. An operator puts the phone in their pocket, the admin assigns
// them a car, and without this they find out whenever they next look.
//
// A push event wakes the service worker even when the PWA is not open, which
// is the entire point.
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('push', (event) => {
  // Tolerate a malformed or empty payload rather than throwing. Chrome shows
  // its own generic "This site has been updated in the background" notice if a
  // push handler finishes without showing anything, which is worse than a
  // plain fallback of our own.
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }

  const rawTitle = payload.title || 'Ambria Valet'
  const rawBody = payload.body || 'You have a new task.'
  // ══ KEPT MINIMAL ON PURPOSE — DO NOT ADD OPTIONS BACK WITHOUT TESTING ══
  //
  // This used to also set renotify, requireInteraction and vibrate. They were
  // reasonable — keep the alert on screen, buzz for a waiting guest — and they
  // were the ONLY difference left between this handler and the Ambria Admin
  // app's, which delivers reliably on iPhone and Android with the app closed.
  // Everything else had been checked and matched: the encryption (tested),
  // the VAPID signature, TTL and Urgency, the subscribe flow, the deployed
  // worker.
  //
  // Platforms are supposed to IGNORE options they do not support. In practice
  // an unsupported option can make showNotification() reject, and a rejection
  // inside waitUntil means the push is lost with nothing shown and nothing
  // logged — exactly the symptom being chased. So the options are now the ones
  // known to work everywhere.
  //
  // If you want the buzz back, add ONE option, ship it, and test with the app
  // fully closed on a real iPhone AND a real Android before adding another. An
  // alert that never appears is worse than one that does not vibrate.
  const options = {
    body: rawBody,
    icon: payload.icon || '/icon-192.png',
    badge: '/icon-192.png',
    // A tag replaces an earlier notification instead of stacking, so five
    // events about one car do not become five notifications on the lock screen.
    tag: payload.tag || 'valet',
    // Survives into notificationclick, which is where the routing happens.
    data: { url: payload.url || '/', taskId: payload.taskId || null },
  }

  // waitUntil is not optional: without it the worker can be killed before the
  // notification is shown, and the push is simply lost.
  //
  // Reading the language is async, so it happens INSIDE waitUntil rather than
  // before it — and it is wrapped so that a failed cache read still shows the
  // notification in English instead of showing nothing at all. A lost push is
  // far worse than an untranslated one.
  event.waitUntil(
    (async () => {
      let title = rawTitle
      let body = rawBody
      try {
        if ((await currentLang()) === 'hi') {
          title = toHindi(rawTitle)
          body = toHindi(rawBody)
        }
      } catch {
        // Fall through with the English the server sent.
      }
      try {
        await self.registration.showNotification(title, { ...options, body })
      } catch (err) {
        // LAST RESORT, and the reason it exists: if showNotification rejects —
        // an option this platform dislikes, a badge it cannot load — the push is
        // gone. Nothing appears, nothing is written down, and the operator is
        // never told about a car with a guest standing next to it.
        //
        // So try again with the two fields no platform can refuse. An ugly
        // notification beats a silent one.
        console.error('[sw] showNotification failed, retrying bare:', err)
        await self.registration.showNotification(title, { body })
      }
    })(),
  )
})

// ═══════════════════════════════════════════════════════════════════
// NOTIFICATION CLICK — focus the open app, do not open a second copy
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || '/'

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        // Required, or an already-open PWA window is not found and the tap
        // launches a second instance with its own websocket.
        includeUncontrolled: true,
      })

      for (const client of clients) {
        if ('focus' in client) {
          // Navigate the existing window rather than opening another. The
          // operator taps the notification to get to the task, not to get a
          // fresh copy of the app.
          if ('navigate' in client) {
            try {
              await client.navigate(target)
            } catch {
              /* cross-origin or unsupported — focusing is still better */
            }
          }
          return client.focus()
        }
      }

      return self.clients.openWindow(target)
    })(),
  )
})

// ═══════════════════════════════════════════════════════════════════
// MESSAGES from the page (see src/pwa.js)
// ═══════════════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
  // Sent when the operator taps "Update" on the update banner.
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()

  // Lets the page display which SW version is actually running.
  if (event.data?.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'VERSION', version: VERSION })
  }
})
