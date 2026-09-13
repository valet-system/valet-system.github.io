/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/AppShell.jsx                                   │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The frame every logged-in page renders inside: the top bar         │
 * │   (property name, user menu, sign out) and the navigation. Also      │
 * │   exports PageHeader — the title block a page puts above its own     │
 * │   content.                                                          │
 * │                                                                     │
 * │ WHY THE NAVIGATION HAS TWO COMPLETELY DIFFERENT LAYOUTS               │
 * │   Operators work one-handed, standing, holding car keys. On a phone  │
 * │   the top of the screen is out of comfortable thumb reach, so the    │
 * │   nav is BOTTOM TABS — the same pattern as every native app, for     │
 * │   the same reason.                                                   │
 * │                                                                     │
 * │   Admins work at a desk. There, bottom tabs waste vertical space and │
 * │   look like a phone app, so the nav becomes a LEFT SIDEBAR at lg+.   │
 * │                                                                     │
 * │   One component, two layouts, chosen by BREAKPOINT — not by sniffing │
 * │   the user agent. A tablet then gets whichever fits its current      │
 * │   width, which stays correct when someone rotates it.                │
 * │                                                                     │
 * │ WHY NAV_ITEMS IS DRIVEN BY ROLE                                       │
 * │   Each role sees only its own destinations. Like ProtectedRoute this │
 * │   is cosmetic, not security — RLS is the real boundary. It exists so │
 * │   nobody is shown a door that would only open onto an error page.    │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   App.jsx — wraps every authenticated route via <Outlet/>.            │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   context/AuthContext, ui/Icon, ui/Button, utils/format, src/types,   │
 * │   src/pwa (install button in the user menu)                          │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { Suspense, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import Icon from '@/components/ui/Icon'
import Button from '@/components/ui/Button'
import RouteSkeleton from '@/components/ui/PageSkeleton'
import NotificationBell from '@/components/NotificationBell'
import NavDrawer from '@/components/NavDrawer'
import PushToggle from '@/components/PushToggle'
import { formatPhone, initials, personName } from '@/utils/format'
import AppBackdrop from '@/theme/AppBackdrop'
import { ROLES } from '@/types'
import { cn } from '@/utils/cn'
import { subscribeToPush } from '@/lib/pushApi'
import { isStandalone, onInstallable, promptInstall } from '@/pwa'
import { isAudioRunning, primeAudio } from '@/utils/sounds'
import { useUnacceptedAlarm } from '@/hooks/useUnacceptedAlarm'
import useMediaQuery from '@/hooks/useMediaQuery'
import { useT } from '@/i18n'
import LanguageToggle from '@/components/LanguageToggle'
import ThemeToggle, { ThemeRow } from '@/components/ThemeToggle'

/**
 * Navigation per role.
 *
 * Entries carry a translation KEY, not text: this is a module-level constant
 * and cannot call a hook, so the words are looked up at render. `nav.<key>` is
 * the sidebar label and `nav.<key>Short` the phone tab label — short because
 * the full one wraps to two lines and breaks the tab row height.
 */
const NAV_ITEMS = {
  [ROLES.OPERATOR]: [
    { to: '/operator/checkin', key: 'checkin', icon: 'plus' },
    { to: '/operator/tasks', key: 'tasks', icon: 'list' },
    { to: '/operator/cars', key: 'cars', icon: 'car' },
  ],
  [ROLES.VALET_ADMIN]: [
    { to: '/admin/dashboard', key: 'dashboard', icon: 'grid' },
    { to: '/admin/car-status', key: 'carStatus', icon: 'car' },
    { to: '/admin/staff', key: 'staff', icon: 'users' },
    { to: '/admin/tokens', key: 'tokens', icon: 'ticket' },
    { to: '/admin/spaces', key: 'spaces', icon: 'parking' },
    // Reviews and Analytics stay OFF this nav, on request. Their routes exist
    // and still guard on the role, so a bookmarked URL keeps working — this
    // hides them, it does not revoke them.
    //
    // VALET BOOKINGS IS NOT IN THAT CATEGORY. It was removed from this role
    // outright, on request: the nav entry AND the /admin/bookings route are
    // gone, so a bookmark returns a valet admin to their dashboard rather than
    // to a screen they are no longer meant to have. The calendar lives on for
    // the system admin (/system/bookings) and the vendor (/vendor/bookings).
    //
    // The valet admin does see a rating: it is a badge on the Car Status card,
    // beside the status. That screen is scoped to ist_today(), so it shows the
    // shift in progress and nothing older — which is the intent. The history
    // lives on the system admin's Records screen, where the range picker is.
  ],
  // ONE ENTRY. A vendor's whole account is the bookings calendar, and every
  // other route refuses them at ProtectedRoute — so a second nav item would be
  // a link to a redirect.
  [ROLES.VALET_VENDOR]: [{ to: '/vendor/bookings', key: 'bookings', icon: 'calendar' }],
  [ROLES.SYSTEM_ADMIN]: [
    { to: '/system/properties', key: 'properties', icon: 'building' },
    { to: '/system/users', key: 'users', icon: 'users' },
    // Same screen as the valet admin's, with a property picker on it.
    { to: '/system/spaces', key: 'spaces', icon: 'parking' },
    { to: '/system/records', key: 'records', icon: 'list' },
    { to: '/system/bookings', key: 'bookings', icon: 'calendar' },
    { to: '/system/analytics', key: 'analytics', icon: 'chart' },
  ],
}

export default function AppShell() {
  const { role, displayName, displayNameHi, phone, propertyName, signOut, operatorId } = useAuth()
  const t = useT()
  const items = NAV_ITEMS[role] ?? []
  const [drawerOpen, setDrawerOpen] = useState(false)

  // md = 768px, the same breakpoint the rail and the drawer switch on.
  //
  // This decides what MOUNTS, not what is visible — the two account-control
  // blocks (the phone top bar and the rail's) each contain a
  // <NotificationBell>, and two of those open the same realtime channel by
  // name and crash the app. See hooks/useMediaQuery.
  const isDesktop = useMediaQuery('(min-width: 768px)')

  useAudioPriming()
  // Every open, not only at login — see the hook for why that mattered.
  usePushRefresh(operatorId)
  useNotificationRouting()
  // Here rather than in operator/MyTasks, so a dispatched car starts sounding
  // the moment it is assigned — not whenever the operator next opens the task
  // list, which is after they needed telling. See the hook.
  useUnacceptedAlarm(operatorId, role)

  return (
    // relative + a z-10 content wrapper, because AppBackdrop's layers are
    // `fixed` and a fixed element paints above ordinary in-flow content
    // whatever the DOM order. Without the explicit layers the veil sits over
    // the whole UI and the navigation is untouchable.
    <div className="relative min-h-app bg-surface-sunken">
      {/* FULL BLEED again — no leftInset. The rail is a floating glass panel
          now, so the photograph is SUPPOSED to be behind it; stopping the
          backdrop at the rail's edge would leave the one panel on screen with
          nothing to frost.

          That re-exposes the stacking question this app got wrong twice: these
          layers are `fixed`, and a fixed element paints above in-flow content
          whatever the DOM order. The z-0 / z-10 pair below is what holds it,
          and it is measured — the rail renders at its own colour, not the
          veil's. */}
      {/* NO veilInset. The veil covers the whole viewport again, the rail
          included, so the ground behind the rail is the same ground as the
          rest of the page. Insetting it left raw, unveiled photograph in
          the rail's column and the join between the two was visible as a
          bright seam down the left of the window. */}
      <AppBackdrop />

      {/* Full width, NOT mx-auto max-w-7xl. Centring the whole shell in
          1280px pushed the sidebar into the middle of a 1900px monitor with
          300px of dead space to its left, which reads as a rendering fault
          rather than a layout. A sidebar belongs against the edge it is
          anchored to.

          min-h-APP, not min-h-shell: the header is INSIDE this row now, so
          subtracting its height again would leave the rail stopping 4rem
          above the bottom of the window. */}
      {/* h-app, NOT min-h-app, and overflow-hidden with it.

          The document used to be what scrolled: the row grew with the
          page and the whole window moved, so the rail and the top bar only
          stayed put because they were `sticky`. Now the SHELL is exactly
          one viewport tall and nothing about it can move — the scrolling
          happens inside <main>, and inside a page, one region at a time.

          overflow-hidden is what guarantees it. Without it a tall page
          would still push the document taller and produce a second,
          outer scrollbar next to the inner one. */}
      <div className="relative z-10 flex h-app w-full overflow-hidden">
        {/* THE RAIL. Near-black in BOTH themes, from --c-rail: the rail is
            chrome, not page, so it does not follow the light/dark toggle and
            the app keeps one silhouette either way.

            The switch to the drawer is at md (768px), NOT lg. At lg an admin
            who puts the browser on half a 1080p screen — roughly 960px, which
            is how these dashboards are actually used next to a booking system
            — lost the sidebar and had to open a drawer for every hop. 768px is
            the real boundary between "a tablet or a window" and "a phone".
            NavDrawer is md:hidden, so the two can never both be on screen.

            flex-col so the footer block can be pushed to the floor with
            mt-auto rather than positioned. */}
        {/* ── STICKY, AND EXACTLY ONE VIEWPORT TALL ─────────────────────
            sticky top-0 + h-app, not a plain flex child.

            Without these the aside simply stretches to the ROW's height, and
            the row is as tall as the page — so on Records or the bookings
            calendar the rail ran hundreds of pixels below the fold and its
            footer block sat at the bottom of the DOCUMENT. You only saw
            "VALET MANAGEMENT SYSTEM" after scrolling to the end of the page,
            which reads as the footer being loose rather than anchored.

            h-app is the visible viewport height (100dvh, with the --app-h
            fallback), so the rail is exactly one screen and its mt-auto
            footer lands on the bottom edge of the WINDOW. sticky keeps it
            there while the content column scrolls past. */}
        {/* h-full, and no `sticky` any more. Sticky was how the rail kept
            its place while the document scrolled underneath; the document
            does not scroll now, so it is simply as tall as the row. */}
        {/* w-72 (288px), widened on request from w-60 (240px).

            IF THIS CHANGES, AppBackdrop's md:left-72 MUST CHANGE WITH IT.
            The backdrop starts where the rail ends so that nothing is
            painted behind it; the two numbers are one decision written in
            two files, and a mismatch shows up as a strip of photograph
            down the edge of the rail or a band of dead page beside it. */}
        {/* A FULL-HEIGHT FLOATING GLASS PANEL.
            Inset by my-3/ml-3 and rounded, so it reads as a panel ON the page
            with the photograph running past its corners, rather than a wall
            fixed to the window edge.

            It runs the whole height deliberately. A shorter panel that hugged
            its destinations was tried twice and reverted both times — the rail
            is the app's spine and it belongs the full height of the frame,
            empty space at its foot included.

            Matching the cards on the page beside it.
            It was a flat, hard-edged slab running the full height of the
            window — the last element in the app still shaped like the old
            theme.

            my-3/ml-3 with a calc'd height rather than h-full: the inset is
            what makes it read as a panel ON the page instead of a wall
            beside it, and the photograph running past its corners is what
            sells that.

            overflow-hidden is safe again now — the bell and the account menu
            moved to the page header, so nothing opens out of the rail any
            more. It is what keeps the nav's scroll inside the rounded corner. */}
        <aside className="my-3 ml-3 hidden h-[calc(100%-1.5rem)] w-72 shrink-0 flex-col overflow-hidden rounded-2xl glass-thin md:flex">
          {/* WHO YOU ARE, AT THE TOP OF THE RAIL.
              The property name lives here on md and up, and in the top bar
              below md — one set of values, two placements, never both at once
              (the bar's copy is md:hidden). It is the most important label in
              the app: an admin covering two sites must never be uncertain
              which one they are acting on, and a phone has no rail to put it
              in.

              The safe-area inset stays on the WRAPPER, not on the row:
              Tailwind sets box-sizing: border-box, so padding on the row would
              eat into its height instead of pushing the block clear of the iOS
              status bar on an installed iPad. */}
          <div className="relative shrink-0 pt-[env(safe-area-inset-top)]">
            {/* h-20 and a larger mark, on request. It was h-16 to mirror the
                top bar's height so a divider between them lined up — both the
                divider and the desktop top bar are gone, so nothing depends
                on 64px any more and the block can be sized for what it is:
                the label that says which site you are acting on. */}
            <div className="mx-2 flex h-20 items-center gap-3 rounded-xl px-3.5">
              {/* A DARK CHIP IN LIGHT, NOTHING IN DARK.
                  The mark is gold with its black keyed out to transparency,
                  so whatever sits behind it BECOMES its background — on a
                  pale rail the thin gold strokes had nothing to sit on and
                  all but vanished. --c-logo-plate is the exact ground the
                  artwork was drawn on, sampled from the source file.
                  In dark the rail is already near-black, so the chip would
                  be a black box on black — hence dark:bg-transparent. */}
              <span className="flex h-11 w-14 shrink-0 items-center justify-center rounded-lg bg-logo-plate px-1.5 dark:bg-transparent dark:px-0">
                <img
                  src={`${import.meta.env.BASE_URL}logo-mark.png`}
                  alt=""
                  aria-hidden="true"
                  width={220}
                  height={81}
                  className="h-auto w-full"
                  // Eager and high priority: it is the first thing on screen on
                  // every page, and lazy-loading the one image above the fold
                  // is how a logo arrives after the nav it sits above.
                  loading="eager"
                  fetchPriority="high"
                />
              </span>
              <div className="min-w-0">
                {/* Gold, not white — the accent is what makes the site name
                    read before the row of controls beside it. t(), not a
                    literal: a system admin has no property, so this fallback
                    is what they see all day, and a hard-coded English string
                    would stay English with the app in Hindi. */}
                <p className="truncate text-base font-semibold leading-tight text-rail-gold">
                  {propertyName || t('login.brand')}
                </p>
                <p className="mt-0.5 truncate text-xs leading-tight text-rail-muted">
                  {role ? t(`role.${role}`) : ''}
                </p>
              </div>
            </div>
          </div>

          <nav
            // min-h-0 is what makes the scroll work. A flex child's default
            // min-height is auto, so `flex-1` alone refuses to shrink below
            // its content — the nav would push the footer off a short window
            // instead of scrolling, which is the bug this whole block fixes.
            // overflow-y-auto then keeps the destinations reachable and the
            // footer pinned, whatever the window height or the role's count.
            // No border-t. It ruled a hard line across the panel, and on a pane
            // meant to blend into the page a divider is the one thing that
            // insists it is a separate object. The gap does the same job.
            className="scrollbar-slim relative min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pt-4"
            aria-label={t('common.mainNav')}
          >
            {/* Props passed one by one, NOT spread. Every NAV_ITEMS entry has a
                `key` field — the translation key — and spreading it hands React
                its own reserved `key` prop, which React warns about and which
                silently overrides the key={item.to} beside it. */}
            {items.map((item) => (
              <SidebarLink
                key={item.to}
                to={item.to}
                icon={item.icon}
                label={t(`nav.${item.key}`)}
              />
            ))}
          </nav>

        </aside>

        {/* The content column. The header lives INSIDE it, which is the whole
            difference from the old layout: it starts where the rail ends
            instead of running across the top of it, so the rail reaches the
            top of the window. */}
        {/* min-h-0: a flex child will not shrink below its content without
            it, so main could never be shorter than the page inside it and
            the overflow-y-auto below would never engage. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Phones only, and NOT MOUNTED at all above md — `md:hidden` alone
              left it mounted, so its NotificationBell opened the same realtime
              channel as the rail's and threw. */}
          {!isDesktop && (
          <TopBar
            displayName={personName(displayName, displayNameHi)}
            phone={phone}
            propertyName={propertyName}
            // Resolved here, not read off the context: the auth object is a
            // useMemo keyed on the profile, so a label formatted in there would
            // keep whichever language was active when the profile loaded.
            roleLabel={role ? t(`role.${role}`) : ''}
            onSignOut={signOut}
            onOpenNav={() => setDrawerOpen(true)}
          />
          )}

          <main
            className={cn(
              // No max-width. A cap was tried and removed: left-aligned it left
              // a dead half-screen on an ultrawide or a zoomed-out window, and
              // centred it pulled the content off the sidebar — which is the
              // gap this layout was changed to get rid of. Stat tiles, tables
              // and charts all stretch, so filling is the honest option.
              // lg:px-10, because the gutter is what lets the photograph read.
              // At sm:px-6 the cards ran to within 24px of the window edge on a
              // wide monitor, which pushed the Sort by control out over the
              // uncovered part of the backdrop and left the image showing only
              // as a sliver. The reference holds roughly 60px there.
              // THE SCROLL CONTAINER. min-h-0 for the same reason as the
              // column above; overflow-y-auto so a long page scrolls HERE
              // rather than moving the window. A page that wants only one
              // of its regions to scroll gives its own root `h-full` and
              // puts overflow-y-auto on that region — then this element
              // has nothing to scroll and quietly does nothing.
              'min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 md:py-7 lg:px-10',
              // The 88px that used to clear the bottom tab bar is gone with it.
              // What remains is the iPhone home indicator, which still overlaps
              // the last card in a list.
              'pb-[calc(2.5rem+env(safe-area-inset-bottom))] md:pb-10',
            )}
          >
            {/* Suspense lives HERE, not around <Routes> in App.jsx, and that
                placement is the whole point. A lazily-loaded page's chunk can
                take a second on hotel wifi; with the boundary inside the shell,
                the top bar, the property name and the nav all stay on screen
                and stay tappable, so an operator can go somewhere else instead
                of staring at a blank page. Above the shell it would blank all
                of that on every navigation. */}
            <Suspense fallback={<RouteSkeleton />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>

      <NavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} items={items} />
    </div>
  )
}

/**
 * Unlocks the AudioContext on the first tap anywhere inside the app.
 *
 * Login.jsx already primes it when someone signs in, and that covers the
 * first session — but the session persists for weeks, so the common case is
 * an operator opening the installed app straight onto their task list with
 * no login and therefore no gesture. Browsers keep audio blocked until a
 * real user interaction, and a realtime event is not one. Miss this and
 * every retrieval alert for the whole shift is SILENT, with nothing on
 * screen to suggest anything is wrong.
 *
 * `once: true` and a capture-phase listener: it costs one call on the first
 * tap the user makes and then removes itself. Both pointerdown and keydown,
 * because a desktop admin may never touch the screen.
 */
/**
 * Re-registers this device for push whenever the app opens.
 *
 * ── WHY THIS WAS MISSING AND WHY IT MATTERS ──
 *   subscribeToPush() was called from ONE place: the login screen. Operators
 *   do not log in — the session persists, so they open the app for weeks
 *   without ever passing through it. The subscription written on the day they
 *   first signed in was never checked again.
 *
 *   That is a SILENT failure. A push subscription can be rotated by the
 *   browser, and push-send deletes one outright on a 404/410 from the push
 *   service. Either way the row is gone, every later push is recorded
 *   'no_device', and the operator simply stops being told about cars. Nothing
 *   on their screen says so, and the only cure was signing out and back in.
 *
 * ── WHY CALLING IT ON EVERY OPEN IS SAFE ──
 *   subscribeToPush() is idempotent by design: it reuses an existing
 *   subscription rather than replacing it, and it returns early WITHOUT
 *   prompting when permission has not been granted — so this cannot burn the
 *   one chance Chrome gives to ask. Re-saving refreshes last_seen_at.
 */
function usePushRefresh(operatorId) {
  const done = useRef(null)

  useEffect(() => {
    if (!operatorId || done.current === operatorId) return
    // Recorded before awaiting, so a re-render mid-flight cannot fire a second.
    done.current = operatorId

    subscribeToPush().then((result) => {
      // Never surfaced to the operator. There is nothing they can do about it
      // from here, and the admin can see who has no device registered.
      if (!result?.ok) console.info('[push] not registered on this device:', result?.state)
    })
  }, [operatorId])
}

/**
 * Sends the app where a tapped notification pointed.
 *
 * The service worker used to do this itself with client.navigate(). That only
 * works on a window it CONTROLS, and notificationclick has to match with
 * includeUncontrolled — otherwise an open PWA window is not found at all — so
 * it could reject on the very window it had just matched. The failure was
 * silent: the window came to the front showing whatever screen it was already
 * on, which for a "Car requested" tap is the one place the admin does not need
 * to be.
 *
 * It also reloaded the whole app when it did work. This routes in one frame and
 * keeps the session, the realtime subscription and the alarm alive.
 *
 * ── WHY THE URL IS CHECKED ──────────────────────────────────────────────
 * The message comes from our own worker, so this is not a real threat — but a
 * postMessage handler is an entry point, and one that passes whatever it is
 * given straight to the router is the kind of thing that becomes a threat later
 * when something else starts posting. Only a same-origin path is accepted.
 */
function useNotificationRouting() {
  const navigate = useNavigate()

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined

    const onMessage = (event) => {
      if (event.data?.type !== 'NAVIGATE') return

      const url = String(event.data.url ?? '')
      // A path on this site and nothing else. '//evil.com' is a protocol-
      // relative URL, not a path, which is why the second character matters.
      if (!url.startsWith('/') || url.startsWith('//')) return

      navigate(url)
    }

    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [navigate])
}

function useAudioPriming() {
  useEffect(() => {
    // NOT `once: true`, and that is the fix for a silent alarm.
    //
    // `once` gave the unlock exactly ONE attempt per mount. resume() can fail —
    // it is a promise, the browser can reject it, and primeAudio swallows the
    // rejection because there is nothing useful to do with it. One failed
    // attempt and the listener had already removed itself, so audio stayed
    // locked for the rest of the shift with nothing on screen to say so.
    //
    // ── WHY THIS SURFACED WHEN IT DID ──────────────────────────────────
    // A page that never reloads keeps the context it unlocked at login, so the
    // single attempt was enough. Then applyUpdate() was fixed — before that,
    // auto-apply posted SKIP_WAITING to a worker that was already the
    // controller, controllerchange never fired, and the reload silently never
    // happened. Now it does. So the app genuinely reloads mid-shift, the
    // AudioContext comes back SUSPENDED, and the one unlock attempt lands on
    // whatever tap comes next — or on none at all, because the phone is in a
    // pocket and the next thing to happen is a car being assigned.
    //
    // Retrying on every gesture until the context is actually running costs a
    // state check per tap and closes the hole for good.
    const prime = () => {
      primeAudio()
      // Stop listening only once it has genuinely worked, not merely once it
      // has been tried.
      if (isAudioRunning()) {
        window.removeEventListener('pointerdown', prime, options)
        window.removeEventListener('keydown', prime, options)
      }
    }
    const options = { capture: true, passive: true }

    // One attempt immediately: a session restored into an already-running
    // context needs no gesture, and this removes the listeners straight away.
    prime()

    window.addEventListener('pointerdown', prime, options)
    window.addEventListener('keydown', prime, options)

    return () => {
      window.removeEventListener('pointerdown', prime, options)
      window.removeEventListener('keydown', prime, options)
    }
  }, [])
}

// ═══════════════════════════════════════════════════════════════════
// TOP BAR
// ═══════════════════════════════════════════════════════════════════

function TopBar({ displayName, phone, propertyName, roleLabel, onSignOut, onOpenNav }) {
  const t = useT()

  return (
    // ── FROSTED, NOT A BLACK SLAB ────────────────────────────────────────
    // The reference has no top bar at all: its controls float directly on the
    // photograph. Floating them for real does not survive a scroll — the page
    // content runs up underneath and the controls end up over a table.
    //
    // Frosted glass is the version that works. The photograph reads through
    // it, so the bar does not divide the screen the way the old near-black one
    // did, and content passing behind it is blurred rather than legible. The
    // tint is the page's own sunken colour, so it follows the theme.
    //
    // sticky, not fixed: sticky stays in the normal flow, so it cannot overlap
    // content and <main> needs no compensating top margin.
    //
    // pt-[env(safe-area-inset-top)] so the bar still fills the strip behind
    // the iOS status bar, while the ROW below it starts under the clock rather
    // than behind it. Without this the hamburger and the property name sat
    // beneath the time and battery on an installed iPhone PWA. Zero on
    // Android and desktop.
    //
    // ── THE SAME GLASS AS THE CARDS ─────────────────────────────────
    // This had its own bg-surface-sunken/60 + backdrop-blur-xl, which was a
    // fourth hand-rolled copy of the frosted-pane recipe — a different tint, a
    // different blur radius and no lit rim, so the bar read as a separate
    // material sitting above the panes rather than the same one. It is `glass`
    // now, like Card, StatTile and the chips.
    //
    // glass-FADE, not glass. The plain pane has a border, a lit rim and a
    // drop shadow, and across a full-width bar those become a 1px near-white
    // line ruled over the photograph — the bar reads as a strip laid on top
    // rather than as the top of the page. The fading variant drops all three
    // and ramps the tint AND the blur out together over its bottom third, so
    // there is no edge anywhere to catch the eye.
    <header className="sticky top-0 z-40 pt-[env(safe-area-inset-top)] md:hidden">
      {/* The glass, as a layer behind the controls rather than on the
          <header> itself — a mask fades an element's children too, and
          fading the avatar out along with the pane is not the effect. */}
      {/* NO tint and NO gradient of its own — only blur. There is exactly one
          veil in this app, on the backdrop, and this layer frosts whatever it
          finds behind it, veil included. So the bar is the same colour as the
          page at every x because it IS the page, just blurred. Painting a
          second gradient here was tried and is wrong: a 115deg gradient across
          a 64px-tall bar lands at a different point than the same gradient
          down a 900px backdrop, so the two drifted apart toward the right. */}
      <div aria-hidden className="glass-fade pointer-events-none absolute inset-0" />
      {/* relative, so the row paints above that layer. */}
      <div className="relative flex h-16 w-full items-center justify-between gap-3 px-4 sm:px-6">
        {/* ── WHO YOU ARE — PHONES ONLY ──────────────────────────────────
            md:hidden, because from md up the RAIL carries this block and two
            copies of the most important label in the app is how they end up
            disagreeing. Below md there is no rail, so this is the only place
            it can live. */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3 md:hidden">
          <button
            type="button"
            onClick={onOpenNav}
            aria-label={t('common.openNav')}
            className="-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-ink/5 hover:text-ink"
          >
            <Icon name="menu" size={22} />
          </button>

          {/* The brand car on a 48px plate, and the plate is still needed here
              even though the rail no longer uses one: this bar is LIGHT, and
              the mark is gold with its black keyed out to transparency, so
              without a dark ground behind it a gold car sits on cream and
              stops matching the letterhead. See --c-logo-plate.

              The width is measured, not chosen by eye, because the mark
              competes directly with the property name — and every Ambria
              property starts with "Ambria", so the name only does its job if
              the truncation reaches the DISTINGUISHING word. With "Ambria
              Pushpanjali Banquets", the longest there is:

                          36px plate      48px plate      64px plate
                 320px    Ambri...        Amb...          A...
                 360px    Ambria Push...  Ambria Pu...    Ambria ...
                 390px    Ambria Pushpa.. Ambria Pushpa.. Ambria Push...

              64px is what a 2.7:1 mark really wants and it fails at 360.
              36px keeps the most text but leaves the car 10px tall, a smudge.
              48px still reaches the distinguishing letters at 360 and above. */}
          <span className="flex h-9 w-12 shrink-0 items-center justify-center rounded-lg bg-logo-plate px-1">
            <img
              src={`${import.meta.env.BASE_URL}logo-mark.png`}
              alt=""
              aria-hidden="true"
              width={220}
              height={81}
              className="h-auto w-full"
            />
          </span>
          <div className="min-w-0">
            {/* NEAR-BLACK HERE, GOLD IN THE RAIL, and that is deliberate
                rather than an inconsistency. The rail is near-black, where
                gold measures 8:1 and reads first. This bar is a light frost,
                where the same gold is 3.4:1 — under WCAG AA for a 15px
                semibold label. This file calls the property name the most
                important label in the app, so on this ground it takes the
                colour that is actually legible. */}
            <p className="truncate text-[0.9375rem] font-semibold leading-tight text-ink">
              {/* t(), not a literal: a system admin has no property, so this
                  fallback is what they see all day — and hard-coded English
                  meant it stayed English with the app in Hindi. */}
              {propertyName || t('login.brand')}
            </p>
            <p className="truncate text-xs leading-tight text-ink-subtle">{roleLabel}</p>
          </div>
        </div>

        {/* md and up: nothing on the left, so the controls sit hard right the
            way the reference has them. A spacer rather than justify-end,
            because the phone layout above still needs space-between. */}
        <div className="hidden md:block" aria-hidden="true" />

        {/* Bell to the LEFT of the account menu, which is where every app puts
            it — and it must not be inside UserMenu, or reaching an unread
            notification would take two taps.

            tone="light" on both toggles: they default to the dark-bar styling
            this bar used to have, and their light tone is near-black ink on a
            faint hover wash, which is what a frosted bar needs. */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="hidden md:block">
            {/* The two-option toggle, not the single "EN v" pill the reference
                shows. That pill was tried and removed: a chevron promises a
                menu that opens, and this one only ever switched — so the
                control lied about what tapping it would do.
                It also puts both scripts back on screen, which is what this
                app has always needed. See LanguageToggle's header. */}
            <LanguageToggle tone="light" />
          </div>
          {/* Desktop only, beside the language switch — both are "how this app
              is presented to me" rather than anything to do with cars. On a
              phone this bar already carries the menu button, the logo, the
              property name, the bell and the avatar, so the phone gets it
              inside the account menu instead. */}
          <div className="hidden md:block">
            <ThemeToggle tone="light" />
          </div>
          <NotificationBell />
          <UserMenu displayName={displayName} phone={phone} onSignOut={onSignOut} />
        </div>
      </div>
    </header>
  )
}

/**
 * @param placement 'bar' on a phone's top bar, 'rail' in the desktop sidebar.
 *                  Decides the button's colours and which way the menu opens —
 *                  neither is derivable from CSS alone, because the rail is
 *                  near-black and sits at the bottom of the window while the
 *                  bar is a light frost at the top.
 */
function UserMenu({ displayName, phone, onSignOut, placement = 'bar' }) {
  const inRail = placement === 'rail'
  const t = useT()
  const [open, setOpen] = useState(false)
  const [canInstall, setCanInstall] = useState(false)
  const ref = useRef(null)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => onInstallable(setCanInstall), [])

  // Close on outside click AND on Escape. Both, because a dropdown that only
  // closes one way feels broken on whichever input the user happens to use.
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Close on navigation, or the menu hangs open over the new page.
  useEffect(() => setOpen(false), [location.pathname])

  return (
    <div className={cn(inRail ? 'relative' : 'relative shrink-0')} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        // Two grounds, two sets of colours. The bar is a light frost, where
        // the old white-on-white/15 built for a near-black header was simply
        // invisible; the rail IS near-black, where it is right again.
        //
        // In the rail this is full width and the name always shows — the rail
        // has 18rem to spend and hiding the name would leave a lone avatar
        // floating in it.
        className={cn(
          'flex h-10 items-center gap-2 rounded-lg transition-colors',
          // px-0.5 in the rail, matching the p-0.5 of the segmented control
          // above it. At px-1.5 the avatar started 7px right of the EN pill
          // and the two rows visibly failed to line up on their left edge —
          // the group's padding and this button's padding are the same
          // measurement and have to carry the same value.
          inRail ? 'w-full px-0.5 hover:bg-rail-ink/[0.07]' : 'pl-1 pr-2 hover:bg-ink/5',
        )}
      >
        {/* A FILLED disc either way: the initials get their own opaque ground
            whatever the photograph is doing behind the glass. On the rail it
            inverts, or a near-black disc on a near-black rail is nothing. */}
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold',
            inRail ? 'bg-rail-gold text-rail' : 'bg-rail text-rail-ink',
          )}
        >
          {initials(displayName)}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-left text-sm font-medium',
            inRail ? 'text-rail-ink' : 'hidden max-w-[10rem] text-ink sm:block',
          )}
        >
          {displayName}
        </span>
        <Icon
          name="chevron-down"
          size={16}
          className={cn(
            'shrink-0 transition-transform',
            inRail ? 'text-rail-muted' : 'text-ink-subtle',
            // In the rail the menu opens UPWARD, so the chevron has to point
            // that way when open or it contradicts the movement.
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          role="menu"
          // `glass`, matching the notification panel it sits beside. Two
          // dropdowns a few pixels apart, one frosted and one opaque white,
          // is the kind of inconsistency that reads as a half-finished theme.
          // glass brings its own shadow, so shadow-pop is gone.
          className={cn(
            'absolute z-50 w-64 animate-slide-up overflow-hidden rounded-xl border glass',
            // Upward out of the rail, because the trigger sits on the floor of
            // the window and a menu dropping down would open off-screen.
            inRail ? 'bottom-[calc(100%+0.5rem)] left-2' : 'right-0 top-12',
          )}
        >
          <div className="border-b border-line px-4 py-3">
            <p className="truncate text-sm font-semibold text-ink">{displayName}</p>
            {/* The PHONE, not session.user.email. That holds the derived
                internal address (9876543210@phone.invalid) which would make an
                operator think they have an email account. See AuthContext. */}
            <p className="tnum truncate text-xs text-ink-subtle">
              {phone ? `+91 ${formatPhone(phone)}` : ''}
            </p>
          </div>

          <div className="space-y-1 p-2">
            {/* First item, above Change PIN. An operator who cannot be reached
                when a guest is waiting is a bigger problem than one who wants a
                different PIN — and until this existed, an operator who had said
                no to the prompt once had no way to ever say yes. */}
            <PushToggle />

            {/* md:hidden — the desktop bar already has this. Two ways to reach
                one setting is how somebody changes it by accident while
                reaching for Sign out. */}
            <div className="md:hidden">
              <ThemeRow />
            </div>

            <Button
              variant="ghost"
              size="md"
              fullWidth
              icon="lock"
              onClick={() => navigate('/change-pin')}
            >
              {t('common.changePin')}
            </Button>

            {/* Only rendered when the browser says an install is possible, and
                never once already installed. A dead "Install" item that does
                nothing is worse than no item. */}
            {canInstall && !isStandalone() && (
              <Button
                variant="ghost"
                size="md"
                fullWidth
                icon="download"
                onClick={promptInstall}
              >
                {t('pwa.install')}
              </Button>
            )}

            <Button
              variant="ghost"
              size="md"
              fullWidth
              icon="logout"
              onClick={onSignOut}
              className="text-danger hover:bg-danger-soft hover:text-danger"
            >
              {t('common.signOut')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════

function SidebarLink({ to, label, icon }) {
  return (
    <NavLink
      to={to}
      // NavLink supplies `isActive` from the router, so the highlight can never
      // disagree with the URL — which is what happens when you compare path
      // strings by hand and forget a trailing slash.
      className={({ isActive }) =>
        cn(
          // border-l-2 on BOTH states, transparent when inactive. Adding the
          // border only when active would shift every label 2px sideways as the
          // highlight moves, which reads as the nav twitching.
          'flex h-11 items-center gap-3 rounded-lg border-l-2 px-3 text-[0.9375rem] font-medium',
          // ── THE HOVER MOVES, IT DOES NOT JUST TINT ──────────────────
          // transition-ALL, not transition-colors, because the transform below
          // has to animate too — with transition-colors the slide happened in
          // one frame and read as a jump.
          //
          // A nav item slides toward its destination: 3px right, which is the
          // direction the page it opens will arrive from. Small on purpose —
          // the rail is only 240px wide and the labels are left-aligned
          // against a gold edge, so anything more and the text visibly breaks
          // its alignment with the item above it.
          //
          // No scale here, unlike the cards. Scaling a 44px row inside a
          // 240px rail makes the text resample and go momentarily fuzzy,
          // which on a list of six items reads as a rendering glitch.
          'transition-all duration-150 ease-out hover:translate-x-[3px]',
          // Scaling and sliding under the pointer is the movement that makes
          // vestibular disorders unpleasant. The colour change stays and does
          // the actual work of saying "this is the one you are on".
          'motion-reduce:transition-none motion-reduce:hover:translate-x-0',
          // index.css gives everything `ring-offset-surface`, which is the
          // page's near-WHITE ground. On this rail that drew the focus ring
          // inside a white halo, reading as a selection artefact rather than
          // as focus. Gold on rail-black, offset in the rail's own colour.
          'focus-visible:ring-rail-gold/70 focus-visible:ring-offset-rail',
          // RAIL COLOURS, not page colours. These were surface/ink tokens,
          // which was right when the rail took the page's background — it has
          // its own near-black one in both themes now, and ink-muted on
          // near-black is unreadable.
          //
          // ── WHY THE ACTIVE STATE CARRIES FOUR SIGNALS ─────────────────
          // Gold text, gold icon, a gold tint, and a gold edge. An earlier
          // version had only `bg-rail-ink/[0.08]` behind the edge and was
          // reported as not showing at all — which was arithmetic, not taste:
          // 7% white over rgb(20,18,16) computes to rgb(36,35,33), sixteen
          // values on a near-black ground and under the noise floor of a
          // laptop panel at an angle in daylight. Gold on near-black is
          // 8:1 and reads from across the room.
          // ── THE ACTIVE ITEM IS AN OPAQUE PILL, AND THAT IS A LEGIBILITY
          //    DECISION, NOT A STYLE ONE ──────────────────────────────────
          // The rail is see-through now, so whatever is behind a label is the
          // blurred photograph — and it moves. Measured against the darkest
          // ground under the nav, gold came out at 1.76:1 and mid-grey at
          // 1.90:1, against a 4.5:1 minimum. No tint of the PANEL fixes that:
          // at 65% opacity, by which point the photograph is barely visible at
          // all, grey was still only 3.49:1.
          //
          // So the item supplies its own ground. bg-rail at 90% is a stable
          // near-opaque chip, and the gold on it measures 5.19:1 whatever the
          // photograph is doing. The rail stays glass BETWEEN the items, which
          // is where the effect is actually visible.
          isActive
            ? 'border-rail-gold bg-rail/90 font-semibold text-rail-gold shadow-sm'
            : // Three things move on hover, because one alone is not felt: the
              // panel lifts, the label goes muted -> full ink, and the left
              // edge picks up a dim gold that PREVIEWS the active state.
              // text-rail-INK, not rail-muted. Muted is a quieter grey and it
              // measured 1.90:1 on the blurred photograph; ink is 5.86:1 at the
              // same spot. The hierarchy between active and inactive is carried
              // by the gold, the pill and the weight — it does not need the
              // label to be faint as well, and cannot afford it here.
              // Hover fills the chip in, previewing the active shape.
              'border-transparent text-rail-ink hover:border-rail-gold/40 hover:bg-rail/70 hover:text-rail-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* NO colour class. Icon draws in currentColor, so it inherits the
              link's own colour and follows both the hover and the active
              state for free. Pinned to text-ink-subtle it could not: the
              label brightened on hover and the icon beside it stayed dull,
              which is what made the hover feel broken rather than subtle. */}
          <Icon name={icon} size={19} strokeWidth={isActive ? 2.1 : 1.75} />
          {label}
        </>
      )}
    </NavLink>
  )
}


// ═══════════════════════════════════════════════════════════════════
// PAGE HEADER
// ═══════════════════════════════════════════════════════════════════

/**
 * `actions` sits BELOW the title on a phone (full width, thumb-reachable) and
 * BESIDE it on desktop. A right-aligned button next to a long title on a
 * narrow screen gets squeezed to an unreadably small width.
 */
export function PageHeader({ eyebrow, title, subtitle, actions, className = '' }) {
  // The bell rides in the header's action cluster rather than in a row of its
  // own, so it costs no vertical space — it sits beside "Add property" instead
  // of pushing it down.
  //
  // HERE, and not in AppShell, because this is the only element on a page that
  // is reliably at the top right and already has a cluster to join. An
  // absolutely-positioned bell in the shell lands on top of whatever button
  // the page puts there.
  //
  // isDesktop gates the MOUNT, not the visibility: below md the phone top bar
  // renders its own bell, and two mounted bells open the same realtime channel
  // by name and crash the app. See hooks/useMediaQuery.
  //
  // Safe because every page renders exactly one PageHeader — checked across
  // all 15 of them. A second one on a page would mean a second bell.
  const isDesktop = useMediaQuery('(min-width: 768px)')
  // Read here rather than passed down: PageHeader is called by fifteen pages,
  // and threading four account props through every one of them to reach a
  // control none of them care about is how a prop list rots.
  const { displayName, displayNameHi, phone, signOut } = useAuth()
  return (
    <div
      className={cn(
        'mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        {/* ── THE EYEBROW ────────────────────────────────────────────────
            Optional, and pages that pass nothing render exactly as before.
            Wide letter-spacing at 11px is what makes a label read as a
            section marker rather than as small text that got lost.

            aria-hidden is deliberate. It is a decorative locator for the eye;
            a screen reader already gets the section from the <h1> and the
            landmark, and announcing "OVERVIEW, heading Properties" is noise. */}
        {eyebrow && (
          <p
            aria-hidden="true"
            className="mb-1.5 text-[0.6875rem] font-semibold uppercase leading-none tracking-[0.2em] text-ink-subtle"
          >
            {eyebrow}
          </p>
        )}
        {/* Display size, and the negative tracking is not decoration: Inter
            at 40px with default spacing looks loose and unset, because its
            metrics are tuned for text sizes. Tightening it is what makes a
            large heading read as typeset. text-wrap: balance keeps a long
            title from dropping one orphaned word onto a second line. */}
        <h1 className="text-[1.75rem] font-bold leading-[1.1] tracking-[-0.02em] text-ink [text-wrap:balance] sm:text-[2.5rem]">
          {title}
        </h1>
        {subtitle && <p className="mt-1.5 text-sm text-ink-subtle">{subtitle}</p>}
      </div>
      {/* A COLUMN, not a row: the bell sits at the very top right of the page
          and the page's own action drops beneath it, on request.

          items-end on sm+ keeps both flush to the right edge whatever their
          widths — the bell is 40px square and the button is as wide as its
          label, and left to stretch they would centre against each other.
          Below sm the parent stacks anyway and a full-width button is the
          right shape for a thumb, so alignment stays stretched there.

          No sm:mt-2 any more. That existed to drop a lone button into line
          with the title block; the bell is the top item now and belongs level
          with the eyebrow.

          Rendered whenever there is a bell OR page actions — a page with no
          actions of its own still needs somewhere to put the bell. */}
      {(isDesktop || actions) && (
        <div className="flex shrink-0 flex-col gap-3 sm:items-end">
          {/* Level with the TITLE, on request — the bell and the account menu
              are about the person using the app, not about this screen, so
              they sit on the masthead line and the screen's own action drops
              below them.

              They moved out of the rail to get here. Only one of each may
              exist: a second NotificationBell opens the same realtime channel
              by name and crashes the app, which is why this is gated on
              isDesktop rather than merely hidden below md. */}
          {isDesktop && (
            <div className="flex items-center gap-2">
              {/* Language and theme, beside the account menu — on request, and
                  out of the rail, which is now navigation and nothing else.

                  They belong together: all three answer "how is this app set up
                  for ME", as against the bell, which is about what happened.
                  `glass` and a border rather than the rail's bg-white/10, since
                  this now sits on the page over the photograph, where a white
                  wash has nothing to lift off. */}
              <div className="flex w-fit shrink-0 items-center gap-0.5 rounded-xl border glass p-0.5">
                <LanguageToggle tone="light" bare />
                <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-line" />
                <ThemeToggle tone="light" dense />
              </div>
              <NotificationBell />
              <UserMenu
                displayName={personName(displayName, displayNameHi)}
                phone={phone}
                onSignOut={signOut}
              />
            </div>
          )}
          {actions}
        </div>
      )}
    </div>
  )
}
