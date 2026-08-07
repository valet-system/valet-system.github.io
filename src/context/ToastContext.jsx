/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/context/ToastContext.jsx                                  │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The app-wide notification strip. Provides a hook:                  │
 * │     const toast = useToast()                                        │
 * │     toast.success('Car parked')                                     │
 * │     toast.error(describeDbError(error))                             │
 * │     toast.warning('Guest did not arrive')                           │
 * │     toast.info('Token range extended')                              │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Spec rule 19: every error is a toast, never a console.log. A       │
 * │   console.log is invisible to the operator holding the phone — the   │
 * │   tap appears to do nothing, so they tap again, and now you have a   │
 * │   double submit on top of the original failure.                      │
 * │                                                                     │
 * │ FOUR DECISIONS                                                       │
 * │   1. Errors DO NOT auto-dismiss. A success message vanishing is      │
 * │      fine; an error message vanishing before it is read means the    │
 * │      operator never learns why the car did not save.                 │
 * │   2. Maximum 3 on screen. Ten stacked toasts hide the very UI the    │
 * │      operator needs to fix the problem. Oldest is dropped.           │
 * │   3. Pinned top-centre, not bottom. Bottom is where the primary      │
 * │      action button lives on a phone; a toast there covers the thing  │
 * │      the user is about to tap.                                       │
 * │   4. role="alert" + aria-live so a screen reader announces it.       │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   Every page. Mounted once in App.jsx, above the router.             │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   ui/Icon, utils/cn                                                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import Icon from '@/components/ui/Icon'
import { useT } from '@/i18n'
import { cn } from '@/utils/cn'

const ToastContext = createContext(null)

const MAX_VISIBLE = 3

const VARIANTS = {
  success: {
    icon: 'check-circle',
    // Auto-dismiss: the operator already saw the card disappear, this is
    // just confirmation.
    duration: 3000,
    className: 'bg-success text-white',
  },
  error: {
    icon: 'alert',
    // 0 = stays until dismissed. Deliberate — see decision 1 in the header.
    duration: 0,
    className: 'bg-danger text-white',
  },
  warning: {
    icon: 'alert',
    duration: 6000,
    className: 'bg-warning text-white',
  },
  info: {
    icon: 'info',
    duration: 4000,
    className: 'bg-brand text-ink-inverse',
  },
}

export function ToastProvider({ children }) {
  // Named `translate`, not `t`: in the render below `t` is already the toast
  // being mapped over, and shadowing it there is how a silent bug gets in.
  const translate = useT()
  const [toasts, setToasts] = useState([])
  // Monotonic counter for keys. Date.now() collides when two toasts are
  // pushed in the same millisecond, which produces duplicate React keys.
  const nextId = useRef(1)
  // Track timers so dismissing early can cancel them and not leak.
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const push = useCallback(
    (variant, message, options = {}) => {
      if (!message) return null

      const id = nextId.current++
      const config = VARIANTS[variant] ?? VARIANTS.info
      const duration = options.duration ?? config.duration

      setToasts((current) => {
        const next = [...current, { id, variant, message, title: options.title }]
        // Keep only the newest MAX_VISIBLE.
        return next.slice(-MAX_VISIBLE)
      })

      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        )
      }

      return id
    },
    [dismiss],
  )

  // useMemo so the context value is referentially stable. Without it, every
  // provider render re-renders every consumer — and this provider wraps the
  // entire app.
  const api = useMemo(
    () => ({
      success: (message, options) => push('success', message, options),
      error: (message, options) => push('error', message, options),
      warning: (message, options) => push('warning', message, options),
      info: (message, options) => push('info', message, options),
      dismiss,
    }),
    [push, dismiss],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}

      {/* pointer-events-none on the container, auto on each toast: the strip
          spans the width of the screen, so without this it would swallow taps
          aimed at whatever is underneath it. */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 px-3 pt-3 sm:pt-4"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((t) => {
          const config = VARIANTS[t.variant] ?? VARIANTS.info
          return (
            <div
              key={t.id}
              role="alert"
              className={cn(
                'pointer-events-auto flex w-full max-w-md animate-toast-in items-start gap-3',
                'rounded-xl px-4 py-3 shadow-pop',
                config.className,
              )}
            >
              <Icon name={config.icon} size={20} className="mt-0.5" strokeWidth={2} />

              <div className="min-w-0 flex-1">
                {t.title && <p className="text-sm font-semibold">{t.title}</p>}
                <p className={cn('text-sm leading-snug', t.title && 'opacity-90')}>{t.message}</p>
              </div>

              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label={translate('common.dismiss')}
                // -m-1 p-1 gives a 32px tap target without changing layout.
                className="-m-1 shrink-0 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100"
              >
                <Icon name="close" size={17} strokeWidth={2} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    // Fail loudly. A silently no-op toast is how "the error just doesn't show"
    // bugs are born.
    throw new Error('useToast must be used inside <ToastProvider>. Check App.jsx.')
  }
  return context
}
