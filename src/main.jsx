/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/main.jsx                                                  │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The entry point. index.html loads this, and this mounts App into   │
 * │   <div id="root">. It also registers the service worker and installs │
 * │   two global error handlers.                                         │
 * │                                                                     │
 * │ WHY StrictMode IS ON                                                  │
 * │   In development React deliberately mounts every component twice and │
 * │   runs each effect's cleanup in between. That is not a bug — it is   │
 * │   the cheapest possible test that our cleanups are correct.           │
 * │                                                                     │
 * │   It matters enormously in this app: we subscribe to Supabase        │
 * │   Realtime channels and run setInterval countdowns. A missing        │
 * │   cleanup means duplicate channels and duplicate timers, which in    │
 * │   production shows up as an alert sounding twice, or a countdown     │
 * │   running at double speed after a few navigations. StrictMode surfaces│
 * │   that on the first render instead of after an hour of use.          │
 * │                                                                     │
 * │   It has no effect on the production build.                          │
 * │                                                                     │
 * │ WHY THE GLOBAL ERROR HANDLERS                                         │
 * │   An unhandled promise rejection prints to a console nobody is        │
 * │   looking at on a phone. These handlers at least record it. Once a    │
 * │   real error reporter is added, this is where it plugs in — one file, │
 * │   two listeners.                                                     │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   src/App, src/index.css, src/pwa                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { registerServiceWorker } from '@/pwa'
import { trackAppHeight } from '@/utils/appHeight'
import { watchForOverflow } from '@/utils/overflowGuard'
import './index.css'

const container = document.getElementById('root')

if (!container) {
  // Only possible if index.html was edited. Fail with a readable message
  // rather than a null-reference deep inside React.
  throw new Error('#root not found in index.html — cannot mount the app.')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Registers /sw.js — the PWA install + offline layer.
// Automatically skipped in dev, where a caching service worker would fight
// Vite's hot reload. See src/pwa.js.
registerServiceWorker()

// Keeps --app-h equal to the height actually on screen, so full-height panels
// work on browsers without dvh support too. Ships — this is not a dev tool.
trackAppHeight()

// Development only, and dropped from the production bundle. The root now clips
// horizontal overflow so an operator never gets a page that slides sideways —
// this is what keeps the CAUSE visible to whoever is building.
watchForOverflow()

// ── last-resort logging ──────────────────────────────────────────────────
// Neither handler tries to recover. Their job is to make a silent failure
// visible; swallowing errors here would hide real bugs.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[app] unhandled promise rejection:', event.reason)
})

window.addEventListener('error', (event) => {
  console.error('[app] uncaught error:', event.error ?? event.message)
})
