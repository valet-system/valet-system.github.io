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
import { ROLES } from '@/types'
import { cn } from '@/utils/cn'
import { subscribeToPush } from '@/lib/pushApi'
import { isStandalone, onInstallable, promptInstall } from '@/pwa'
import { primeAudio } from '@/utils/sounds'
import { useT } from '@/i18n'
import LanguageToggle from '@/components/LanguageToggle'

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
    { to: '/admin/reviews', key: 'reviews', icon: 'star' },
    { to: '/admin/analytics', key: 'analytics', icon: 'chart' },
  ],
  [ROLES.SYSTEM_ADMIN]: [
    { to: '/system/properties', key: 'properties', icon: 'building' },
    { to: '/system/users', key: 'users', icon: 'users' },
    { to: '/system/records', key: 'records', icon: 'list' },
    { to: '/system/analytics', key: 'analytics', icon: 'chart' },
  ],
}

export default function AppShell() {
  const { role, displayName, displayNameHi, phone, propertyName, signOut, operatorId } = useAuth()
  const t = useT()
  const items = NAV_ITEMS[role] ?? []
  const [drawerOpen, setDrawerOpen] = useState(false)

  useAudioPriming()
  // Every open, not only at login — see the hook for why that mattered.
  usePushRefresh(operatorId)

  return (
    <div className="min-h-app bg-surface-sunken">
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

      {/* Full width, NOT mx-auto max-w-7xl.
          Centring the whole shell in 1280px pushed the sidebar into the
          middle of a 1900px monitor with 300px of dead space to its left,
          which reads as a rendering fault rather than a layout. A sidebar
          belongs against the edge it is anchored to. The content gets its own
          cap below instead — left-aligned, so the nav never moves. */}
      <div className="flex w-full">
        {/* Desktop sidebar. sticky so a long page cannot scroll the nav away.
            The switch to the drawer is at md (768px), NOT lg. At lg an admin
            who puts the browser on half a 1080p screen — roughly 960px, which
            is how these dashboards are actually used next to a booking system
            — lost the sidebar and had to open a drawer for every hop. 768px is
            the real boundary between "a tablet or a window" and "a phone".
            NavDrawer is md:hidden, so the two can never both be on screen. */}
        <aside className="hidden w-56 shrink-0 md:block">
          {/* 4rem is the header row; the inset is the strip added above it for
              the iOS status bar. Left at a bare top-16 this would tuck under
              the header by exactly the inset on an installed iPad PWA. */}
          <nav
            className="sticky top-[calc(4rem+env(safe-area-inset-top))] space-y-1 px-3 py-6"
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

        <main
          className={cn(
            // No max-width. A cap was tried and removed: left-aligned it left
            // a dead half-screen on an ultrawide or a zoomed-out window, and
            // centred it pulled the content off the sidebar — which is the
            // gap this layout was changed to get rid of. Stat tiles, tables
            // and charts all stretch, so filling is the honest option.
            'min-w-0 flex-1 px-4 py-5 sm:px-6 md:py-7',
            // The 88px that used to clear the bottom tab bar is gone with it.
            // What remains is the iPhone home indicator, which still overlaps
            // the last card in a list.
            'pb-[calc(2.5rem+env(safe-area-inset-bottom))] md:pb-10',
          )}
        >
          {/* Suspense lives HERE, not around <Routes> in App.jsx, and that
              placement is the whole point. A lazily-loaded page's chunk can
              take a second on hotel wifi; with the boundary inside the shell,
              the top bar, the property name and the nav all stay on screen and
              stay tappable, so an operator can go somewhere else instead of
              staring at a blank page. Above the shell it would blank all of
              that on every navigation. */}
          <Suspense fallback={<RouteSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
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

function useAudioPriming() {
  useEffect(() => {
    const prime = () => primeAudio()
    const options = { once: true, capture: true, passive: true }

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
    // sticky, not fixed: sticky stays in the normal flow, so it cannot overlap
    // content and <main> needs no compensating top margin.
    // pt-[env(safe-area-inset-top)] so the dark bar still fills the area
    // behind the iOS status bar — which is what makes the white clock legible
    // — while the ROW below it starts under the clock instead of behind it.
    // Without this the hamburger and the property name sat beneath the time
    // and battery on an installed iPhone PWA. Zero on Android and desktop.
    <header className="sticky top-0 z-40 border-b border-black/10 bg-brand pt-[env(safe-area-inset-top)]">
      {/* Full width, matching the shell below. Capping this at 1280px while
          the dark bar itself spanned the screen left the logo floating in the
          middle of its own header, out of line with the sidebar under it. */}
      <div className="flex h-16 w-full items-center justify-between gap-3 px-4 sm:px-6">
        {/* The property name is the most important label in the whole app.
            A valet admin covering two sites in one browser must never be
            uncertain which one they are acting on. */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {/* Phones only — md and up have the sidebar, which is always there. */}
          <button
            type="button"
            onClick={onOpenNav}
            aria-label={t('common.openNav')}
            className="-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-inverse transition-colors hover:bg-white/10 md:hidden"
          >
            <Icon name="menu" size={22} />
          </button>

          {/* The brand car on a 48px plate. The width is measured, not chosen by
              eye, because the mark competes directly with the property name and
              that name is the most important label in the app — an admin
              covering two sites must never be unsure which one they are acting
              on. Every Ambria property starts with "Ambria", so the name only
              does its job if the truncation reaches the DISTINGUISHING word.

              With "Ambria Pushpanjali Banquets", the longest name there is:

                          36px plate      48px plate      64px plate
                 320px    Ambri…          Amb…            A…
                 360px    Ambria Push…    Ambria Pu…      Ambria …
                 390px    Ambria Pushpa…  Ambria Pushpa…  Ambria Push…

              64px is what a 2.7:1 mark really wants, and it fails at 360 —
              "Ambria …" identifies nothing. 36px keeps the most text but leaves
              the car 10px tall, a smudge rather than a logo. 48px still reaches
              the distinguishing letters at 360 and above, and the car reads.

              320px identifies nothing at ANY plate width, including the 36px
              square this replaced — that viewport was already lost, so it is not
              an argument for a smaller plate. Nothing overflows at any of the
              three widths; the name truncates rather than pushing the row. */}
          <span className="flex h-9 w-12 shrink-0 items-center justify-center rounded-lg bg-white/10 px-1">
            <img
              src="/logo-mark.png"
              alt=""
              aria-hidden="true"
              width={220}
              height={81}
              className="h-auto w-full"
            />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[0.9375rem] font-semibold leading-tight text-ink-inverse">
              {propertyName || 'Valet Ops'}
            </p>
            <p className="truncate text-xs leading-tight text-ink-inverse/60">{roleLabel}</p>
          </div>
        </div>

        {/* Bell to the LEFT of the account menu, which is where every app puts
            it — and it must not be inside UserMenu, or reaching an unread
            notification would take two taps. */}
        {/* Four things, not seven. The language toggle moved into the drawer:
            two extra buttons here were what squeezed the property name — the
            one label a valet admin covering two sites must be able to read —
            and pushed the whole header past the right edge of a phone. It is
            still one tap away, and on a desktop there is room for it. */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="hidden md:block">
            <LanguageToggle />
          </div>
          <NotificationBell />
          <UserMenu displayName={displayName} phone={phone} onSignOut={onSignOut} />
        </div>
      </div>
    </header>
  )
}

function UserMenu({ displayName, phone, onSignOut }) {
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
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-10 items-center gap-2 rounded-lg pl-1 pr-2 transition-colors hover:bg-white/10"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-xs font-bold text-ink-inverse">
          {initials(displayName)}
        </span>
        <span className="hidden max-w-[10rem] truncate text-sm font-medium text-ink-inverse sm:block">
          {displayName}
        </span>
        <Icon
          name="chevron-down"
          size={16}
          className={cn('text-ink-inverse/70 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-12 w-64 animate-slide-up overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
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

            <Button
              variant="ghost"
              size="md"
              fullWidth
              icon="lock"
              onClick={() => navigate('/change-pin')}
              className="justify-start"
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
                className="justify-start"
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
              className="justify-start text-danger hover:bg-danger-soft hover:text-danger"
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
          'flex h-11 items-center gap-3 rounded-lg px-3 text-[0.9375rem] font-medium transition-colors',
          isActive
            ? 'bg-surface text-ink shadow-card'
            : 'text-ink-muted hover:bg-surface/70 hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon name={icon} size={19} className={isActive ? 'text-brand' : 'text-ink-subtle'} />
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
export function PageHeader({ title, subtitle, actions, className = '' }) {
  return (
    <div
      className={cn(
        'mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-subtle">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
