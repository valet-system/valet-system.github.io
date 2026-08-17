/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/NavDrawer.jsx                                  │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The phone navigation. A hamburger in the top bar opens this from   │
 * │   the left: every destination with its FULL name, the language       │
 * │   switch, and who you are signed in as.                              │
 * │                                                                     │
 * │ ── WHY THIS REPLACED THE BOTTOM TAB BAR ─────────────────────────────│
 * │   A valet_admin has seven destinations. Seven tabs across a 390px    │
 * │   phone is 46px each: the labels truncate, the icons crowd, and the  │
 * │   row competes with the OS gesture bar for the same strip of glass.  │
 * │   Worse, the bar had to live in the top bar's leftovers — language    │
 * │   toggle, bell and avatar all fighting the property name for room,    │
 * │   which is what pushed the header past the screen edge.               │
 * │                                                                     │
 * │   A drawer costs one tap and buys all of it back: full labels, no    │
 * │   cap on how many destinations a role can have, and a top bar with   │
 * │   four things in it instead of seven.                                │
 * │                                                                     │
 * │ ── THE LANGUAGE SWITCH LIVES HERE NOW ───────────────────────────────│
 * │   Still one tap from anywhere, and no longer squeezing the property   │
 * │   name — which is the label a valet admin covering two sites cannot   │
 * │   afford to have truncated. It sits directly above the user block,    │
 * │   both written in their own script, for the same reason as ever:      │
 * │   somebody who cannot read the app has to be able to find it.         │
 * │                                                                     │
 * │ ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────│
 * │   No Sign out, no Change PIN. Those live in the avatar menu, and one  │
 * │   destructive action reachable from two places is how somebody signs  │
 * │   out while reaching for the nav. The user block here is IDENTITY —   │
 * │   name, role, property — so you can check which site you are acting   │
 * │   on before you tap anything.                                        │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   components/AppShell, below md only. The sidebar handles md and up. │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   context/AuthContext, ui/Icon, src/i18n, utils/format, utils/cn      │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import Icon from '@/components/ui/Icon'
import { useAuth } from '@/context/AuthContext'
import { useI18n } from '@/i18n'
import { initials, personName } from '@/utils/format'
import { cn } from '@/utils/cn'

export default function NavDrawer({ open, onClose, items }) {
  const { t, setLang, isHindi } = useI18n()
  const location = useLocation()
  const { role, displayName, displayNameHi, propertyName } = useAuth()
  const panelRef = useRef(null)

  // Close on navigation. Without this, tapping a destination leaves the drawer
  // sitting over the page you just asked for.
  useEffect(() => {
    if (open) onClose()
    // location is the trigger; onClose and open must NOT re-run this or it
    // would close itself the moment it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  // Escape, the same as every other overlay in the app.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Stop the page behind from scrolling under the drawer — on a phone that
  // reads as the drawer itself being broken.
  useEffect(() => {
    if (!open) return undefined
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // Move focus in, so a keyboard or screen-reader user is actually inside the
  // thing that just opened rather than still behind it.
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!open) return null

  return (
    // h-app, not inset-0: see the utility in src/index.css. inset-0 on a fixed
    // element measures the LAYOUT viewport, so on a phone with the address bar
    // showing the panel runs under the browser chrome and the footer below is
    // simply unreachable.
    <div className="fixed inset-x-0 top-0 z-50 h-app md:hidden">
      {/* aria-hidden: the backdrop is a tap target, not something to announce. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 animate-fade-in bg-black/40"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('common.mainNav')}
        tabIndex={-1}
        className={cn(
          // overflow-hidden is the guarantee: the panel is exactly the height
          // of the visible viewport, and anything that does not fit is the
          // nav's problem to scroll — never the panel's to grow. Without it a
          // long enough nav pushed the footer below the fold, and the footer is
          // where the language switch lives.
          'absolute left-0 top-0 flex h-full w-[17rem] max-w-[85vw] flex-col overflow-hidden',
          'animate-slide-in-left bg-surface shadow-pop outline-none',
          // The notch and the home indicator both sit over this panel.
          'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
        )}
      >
        {/* ── brand ─────────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-center gap-3 px-4 py-5">
          <span className="flex h-10 w-[4.5rem] shrink-0 items-center justify-center rounded-xl bg-logo-plate px-2">
            {/* The size public/logo-mark.png is actually emitted at, per
                `npm run logo`. Update both when the artwork changes. */}
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
            <p className="truncate font-semibold leading-tight text-ink">{t('login.brand')}</p>
            {propertyName && (
              <p className="truncate text-xs leading-tight text-ink-subtle">{propertyName}</p>
            )}
          </div>
        </div>

        {/* ── destinations ──────────────────────────────────────────── */}
        <nav className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  // min-h-12 is the tap target. A nav row read in a hurry on a
                  // porch is not a place to save vertical space.
                  'mb-1 flex min-h-12 items-center gap-3 rounded-xl border-l-2 px-3 text-[0.9375rem]',
                  'font-medium transition-colors',
                  isActive
                    ? 'border-accent bg-brand-soft font-semibold text-brand'
                    : 'border-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon name={item.icon} size={19} strokeWidth={isActive ? 2.1 : 1.75} />
                  {/* The FULL label, which is the whole point of a drawer —
                      "Car status", not "Cars". */}
                  <span className="min-w-0 truncate">{t(`nav.${item.key}`)}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* ── language, then who you are ──────────────────────────────
            shrink-0: this block is the reason the drawer exists at this size.
            It must never be the thing that gets squeezed off the bottom. */}
        <div className="shrink-0 border-t border-line">
          {/* ONE ROW, ONE TAP, and the label is written in the language it
              switches TO — somebody who cannot read English has to be able to
              find the Hindi option, which means seeing Devanagari. This replaced
              an EN/हिं pair of buttons: two targets and a heading, to express a
              binary, in the narrowest column in the app. */}
          <button
            type="button"
            onClick={() => setLang(isHindi ? 'en' : 'hi')}
            className="flex min-h-12 w-full items-center gap-3 px-4 text-[0.9375rem] font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
          >
            <Icon name="globe" size={19} />
            <span className="min-w-0 truncate">
              {isHindi ? t('lang.toEnglish') : t('lang.toHindi')}
            </span>
          </button>

          <div className="flex items-center gap-3 border-t border-line px-4 py-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand">
              {initials(personName(displayName, displayNameHi))}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight text-ink">
                {personName(displayName, displayNameHi)}
              </p>
              <p className="truncate text-xs leading-tight text-ink-subtle">
                {role ? t(`role.${role}`) : ''}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
