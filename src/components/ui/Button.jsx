/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/Button.jsx                                  │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The only button in the app. Six visual variants, three sizes,     │
 * │   plus icon-only sizes. Default size is 56px tall.                  │
 * │                                                                     │
 * │ WHY IT EXISTS — the important part                                   │
 * │   If `onClick` returns a Promise, this component manages the        │
 * │   loading + disabled state ITSELF until that promise settles.        │
 * │                                                                     │
 * │   Spec rule 16 requires every async button to show loading and be   │
 * │   disabled while in flight. Leaving that to each page — remember    │
 * │   useState, remember try/finally — is exactly how double-submits     │
 * │   reach production: an operator taps "Car Parked" twice on a slow    │
 * │   connection, two WhatsApp templates go out, the guest is billed     │
 * │   twice and gets two tokens. Making the primitive safe by default    │
 * │   deletes the whole class of bug instead of policing it in review.   │
 * │                                                                     │
 * │   A `loading` prop is still accepted and always wins, for the rare  │
 * │   case where the page owns the state.                               │
 * │                                                                     │
 * │     <Button onClick={async () => { await save() }}>Save</Button>     │
 * │     <Button loading={saving}>Save</Button>                           │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   Every page.                                                       │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   ui/Icon, ui/Spinner, utils/cn                                     │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { forwardRef, useCallback, useRef, useState } from 'react'
import Icon from './Icon'
import Spinner from './Spinner'
import { cn } from '@/utils/cn'

const VARIANTS = {
  // Primary — one per screen. Near-black reads as premium, and unlike a
  // saturated blue it never competes with the status colours on the cards.
  primary:
    'bg-brand text-ink-inverse shadow-sm hover:bg-brand-hover active:bg-brand ' +
    'disabled:bg-ink-subtle disabled:shadow-none',
  // Success — the confirm actions an operator taps all shift: Car Parked,
  // Guest Arrived. Green is the "this went right" channel throughout.
  success:
    'bg-success text-white shadow-sm hover:bg-success-hover active:bg-success ' +
    'disabled:bg-success/40 disabled:shadow-none',
  // Warning — overriding something the app advised against, never a plain
  // confirm. Right now that is one button: "yes, the car really is in that
  // full space". Amber rather than green because the operator should read it
  // before tapping, and rather than red because nothing is being destroyed.
  warning:
    'bg-warning text-white shadow-sm hover:brightness-95 active:brightness-100 ' +
    'disabled:bg-warning/40 disabled:shadow-none',
  // Danger — Guest Not Here, deactivate user, delete.
  danger:
    'bg-danger text-white shadow-sm hover:bg-danger-hover active:bg-danger ' +
    'disabled:bg-danger/40 disabled:shadow-none',
  // Secondary — the default for anything that is not the main action.
  secondary:
    'bg-surface text-ink border border-line-strong shadow-sm ' +
    'hover:bg-surface-sunken active:bg-line/50 disabled:text-ink-subtle',
  // Ghost — toolbar and icon-only actions.
  ghost:
    'bg-transparent text-ink-muted hover:bg-line/50 hover:text-ink active:bg-line ' +
    'disabled:text-ink-subtle',
  // Subtle — informational actions inside cards.
  subtle:
    'bg-brand-soft text-ink border border-transparent hover:bg-line/60 ' +
    'disabled:text-ink-subtle',
}

const SIZES = {
  // 56px — spec rule 20's minimum touch target. This is the DEFAULT because
  // the operator app is the one used under pressure, one-handed, outdoors.
  lg: 'h-touch min-h-touch px-6 text-base gap-2.5 rounded-xl font-semibold',
  md: 'h-11 min-h-11 px-4 text-[0.9375rem] gap-2 rounded-lg font-medium',
  sm: 'h-9 min-h-9 px-3 text-sm gap-1.5 rounded-lg font-medium',
  // Square icon-only variants keep the same tap area as their text siblings.
  'icon-lg': 'h-touch w-touch rounded-xl',
  'icon-md': 'h-11 w-11 rounded-lg',
  'icon-sm': 'h-9 w-9 rounded-lg',
}

const Button = forwardRef(function Button(
  {
    children,
    variant = 'primary',
    size = 'lg',
    icon,
    iconRight,
    loading,
    loadingText,
    disabled,
    fullWidth = false,
    className = '',
    onClick,
    type = 'button',
    ...rest
  },
  ref,
) {
  const [busy, setBusy] = useState(false)
  // Guards against a second tap landing in the same tick, before React has
  // re-rendered with the disabled attribute. Touch devices genuinely do this.
  const inFlight = useRef(false)

  const handleClick = useCallback(
    (event) => {
      if (!onClick || inFlight.current) return

      const result = onClick(event)

      // Not a promise -> synchronous handler, nothing to manage.
      if (!result || typeof result.then !== 'function') return result

      inFlight.current = true
      setBusy(true)
      return result.finally(() => {
        inFlight.current = false
        // If the click unmounted this button (very common: "task completed"
        // removes the card), setBusy on an unmounted component is a no-op in
        // React 18+, so no guard or warning to worry about.
        setBusy(false)
      })
    },
    [onClick],
  )

  // An explicit `loading` prop always wins over the automatic one.
  const isLoading = loading ?? busy
  const isDisabled = disabled || isLoading
  const iconOnly = size.startsWith('icon-')

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      onClick={handleClick}
      aria-busy={isLoading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap',
        'transition-colors duration-150',
        'disabled:cursor-not-allowed',
        // Presses feel physical without the layout shifting.
        'active:scale-[0.985] disabled:active:scale-100',
        VARIANTS[variant] ?? VARIANTS.primary,
        SIZES[size] ?? SIZES.lg,
        iconOnly && 'inline-flex items-center justify-center p-0',
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {isLoading ? (
        <>
          <Spinner size={iconOnly ? 20 : 18} />
          {!iconOnly && <span>{loadingText ?? children}</span>}
        </>
      ) : (
        <>
          {icon && <Icon name={icon} size={iconOnly ? 20 : 18} />}
          {!iconOnly && children}
          {iconRight && <Icon name={iconRight} size={18} />}
        </>
      )}
    </button>
  )
})

export default Button
