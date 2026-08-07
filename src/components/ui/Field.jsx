/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/Field.jsx                                   │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   Every form control in the app:                                    │
 * │     Field       — the label + error/hint wrapper                    │
 * │     Input       — text, tel, number, password                       │
 * │     Select      — native <select> with our own chevron              │
 * │     Textarea    — notes fields                                      │
 * │     SearchInput — search box with a clear button                    │
 * │                                                                     │
 * │ WHY IT EXISTS — four decisions that are not cosmetic                 │
 * │   1. Controls are 56px tall (h-touch), matching Button. A 40px       │
 * │      input above a 56px button looks broken AND is hard to hit       │
 * │      one-handed on a phone.                                         │
 * │   2. font-size never drops below 16px. Below 16px, iOS Safari zooms  │
 * │      the whole page when a field is focused and does not zoom back   │
 * │      out. On a check-in form filled 200 times a shift, unusable.     │
 * │   3. Errors are wired through aria-describedby / aria-invalid, and   │
 * │      never render alongside the hint — the error replaces it. Two    │
 * │      lines appearing at once shifts the submit button down under     │
 * │      the operator's thumb mid-tap.                                   │
 * │   4. `inputMode` is passed through and used deliberately: it is what │
 * │      makes a phone show the numeric keypad for a 10-digit number,    │
 * │      roughly halving check-in typing time.                          │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   Login, operator/CheckIn, admin/TokenMgmt, system/Users, and every  │
 * │   filter/search bar.                                                │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   ui/Icon, utils/cn                                                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { forwardRef, useId } from 'react'
import Icon from './Icon'
import { useT } from '@/i18n'
import { cn } from '@/utils/cn'

export function Field({ label, htmlFor, error, hint, required, children, className = '' }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="flex items-center gap-1 text-sm font-medium text-ink-muted"
        >
          {label}
          {required && (
            <span className="text-danger" aria-label="required">
              *
            </span>
          )}
        </label>
      )}

      {children}

      {/* Error takes priority over hint — never show both, it's noise. */}
      {error ? (
        <p
          id={htmlFor ? `${htmlFor}-error` : undefined}
          role="alert"
          className="flex items-start gap-1.5 text-sm font-medium text-danger"
        >
          <Icon name="alert" size={15} className="mt-0.5" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={htmlFor ? `${htmlFor}-hint` : undefined} className="text-sm text-ink-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

const CONTROL_BASE =
  'w-full rounded-xl border bg-surface text-base text-ink placeholder:text-ink-subtle ' +
  'transition-colors duration-150 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle'

const CONTROL_OK = 'border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20'
const CONTROL_ERR = 'border-danger focus:border-danger focus:ring-2 focus:ring-danger/20'

export const Input = forwardRef(function Input(
  { label, error, hint, required, icon, className = '', id, containerClassName, ...rest },
  ref,
) {
  const autoId = useId()
  const inputId = id ?? autoId

  return (
    <Field
      label={label}
      htmlFor={inputId}
      error={error}
      hint={hint}
      required={required}
      className={containerClassName}
    >
      <div className="relative">
        {icon && (
          <Icon
            name={icon}
            size={19}
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-subtle"
          />
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          className={cn(
            CONTROL_BASE,
            'h-touch outline-none',
            icon ? 'pl-11 pr-4' : 'px-4',
            error ? CONTROL_ERR : CONTROL_OK,
            className,
          )}
          {...rest}
        />
      </div>
    </Field>
  )
})

export const Select = forwardRef(function Select(
  { label, error, hint, required, options = [], placeholder, className = '', id, children, ...rest },
  ref,
) {
  const autoId = useId()
  const selectId = id ?? autoId

  return (
    <Field label={label} htmlFor={selectId} error={error} hint={hint} required={required}>
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
          className={cn(
            CONTROL_BASE,
            // appearance-none + our own chevron: the native arrow looks
            // different on every OS and cannot be styled.
            'h-touch cursor-pointer appearance-none pl-4 pr-11 outline-none',
            error ? CONTROL_ERR : CONTROL_OK,
            className,
          )}
          {...rest}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => {
            const value = typeof opt === 'string' ? opt : opt.value
            const optLabel = typeof opt === 'string' ? opt : opt.label
            return (
              <option key={value} value={value} disabled={opt.disabled}>
                {optLabel}
              </option>
            )
          })}
          {children}
        </select>
        <Icon
          name="chevron-down"
          size={18}
          className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-subtle"
        />
      </div>
    </Field>
  )
})

export const Textarea = forwardRef(function Textarea(
  { label, error, hint, required, rows = 3, className = '', id, ...rest },
  ref,
) {
  const autoId = useId()
  const areaId = id ?? autoId

  return (
    <Field label={label} htmlFor={areaId} error={error} hint={hint} required={required}>
      <textarea
        ref={ref}
        id={areaId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${areaId}-error` : hint ? `${areaId}-hint` : undefined}
        className={cn(
          CONTROL_BASE,
          'resize-y px-4 py-3 leading-relaxed outline-none',
          error ? CONTROL_ERR : CONTROL_OK,
          className,
        )}
        {...rest}
      />
    </Field>
  )
})

/**
 * SearchInput — used by TodaysCars / Reviews / Users.
 * Includes a clear button because clearing a search field by backspacing 12
 * characters on a phone is miserable.
 */
export const SearchInput = forwardRef(function SearchInput(
  { value, onChange, onClear, placeholder, className = '', ...rest },
  ref,
) {
  const t = useT()

  return (
    <div className={cn('relative', className)}>
      <Icon
        name="search"
        size={19}
        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-subtle"
      />
      <input
        ref={ref}
        type="search"
        role="searchbox"
        value={value}
        onChange={onChange}
        placeholder={placeholder ?? t('common.search')}
        className={cn(
          CONTROL_BASE,
          CONTROL_OK,
          'h-12 pl-11 pr-11 outline-none',
          // Hide WebKit's own clear button — we render our own so it looks
          // the same on Android, where WebKit's does not exist.
          '[&::-webkit-search-cancel-button]:hidden',
        )}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={t('common.clearSearch')}
          className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-line/60 hover:text-ink"
        >
          <Icon name="x" size={17} />
        </button>
      ) : null}
    </div>
  )
})
