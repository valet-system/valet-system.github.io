/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/Dropdown.jsx                                  │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   A dropdown whose OPEN list can be styled — glass, like every       │
 * │   other panel in the app.                                            │
 * │                                                                     │
 * │   NAMED Dropdown, not Select, because ui/Field already exports a     │
 * │   `Select` — that one wraps a native <select> for FORMS, where the    │
 * │   OS picker is still the right control. Two components called Select  │
 * │   in one file is how the wrong one gets imported.                     │
 * │                                                                     │
 * │ ── WHY NOT JUST STYLE THE <select> ─────────────────────────────────│
 * │   Because you cannot. A native select's popup is drawn by the        │
 * │   operating system, not by the page: the white list and the blue     │
 * │   highlight come from Windows, and no CSS reaches them. The CLOSED   │
 * │   control is styleable and always was — it is the open state that    │
 * │   forced this.                                                       │
 * │                                                                     │
 * │   That is a real cost, so it is worth being clear about what is      │
 * │   given up. A native select on a phone opens the OS picker: a big    │
 * │   thumb-friendly wheel that every user already knows and that no     │
 * │   custom widget matches. This replaces it. The options here are      │
 * │   therefore 44px tall — the minimum comfortable touch target — and   │
 * │   this component is used on ADMIN filters, not on anything an        │
 * │   operator taps one-handed at a porch.                               │
 * │                                                                     │
 * │ ── WHAT A NATIVE SELECT GIVES YOU FREE, AND IS REBUILT HERE ────────│
 * │   Every one of these is a thing people actually use, and a custom    │
 * │   dropdown that skips them is worse than the native control it       │
 * │   replaced, however it looks:                                        │
 * │                                                                     │
 * │     - Enter / Space / ArrowDown opens it                             │
 * │     - Arrow keys move, Home and End jump to the ends                 │
 * │     - Enter picks, Escape closes without picking                     │
 * │     - Typing letters jumps to a matching option                      │
 * │     - Tab or a click elsewhere closes it                             │
 * │     - Focus returns to the button on close, so Tab order survives    │
 * │     - role=listbox / role=option / aria-selected, so a screen        │
 * │       reader announces it as the same kind of thing                  │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   pages/StaffManager (the role and property filters)                 │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   ui/Icon, utils/cn                                                  │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useId, useRef, useState } from 'react'
import Icon from './Icon'
import { cn } from '@/utils/cn'

/**
 * @param value     the selected option's value
 * @param onChange  called with the new value
 * @param options   [{ value, label }]
 * @param icon      optional Icon name, drawn inside the closed control
 * @param label     accessible name — this control has no visible <label>
 */
export default function Dropdown({ value, onChange, options, icon, label, className = '' }) {
  const [open, setOpen] = useState(false)
  /** Which option the keyboard is on. Separate from `value`: moving through
   *  the list must not change the filter until Enter, or every arrow press
   *  would refetch the screen behind the dropdown. */
  const [active, setActive] = useState(0)
  const rootRef = useRef(null)
  const listRef = useRef(null)
  const buttonRef = useRef(null)
  const typed = useRef({ text: '', at: 0 })
  const listId = useId()

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  )
  const selected = options[selectedIndex]

  // Open on the CURRENT value, not at the top. Arrowing from wherever you
  // already are is what a native select does, and it is what stops a long
  // property list being a scroll every time.
  useEffect(() => {
    if (open) setActive(selectedIndex)
  }, [open, selectedIndex])

  // Keep the active option in view when the keyboard walks past the fold.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  // Close on an outside pointer or on Escape. Both, because a dropdown that
  // only closes one way feels broken on whichever input you happen to use.
  useEffect(() => {
    if (!open) return undefined

    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function choose(index) {
    const option = options[index]
    if (option) onChange(option.value)
    setOpen(false)
    // Focus goes back to the button, or Tab would restart from the top of the
    // document — the classic custom-dropdown trap.
    buttonRef.current?.focus()
  }

  function onKeyDown(event) {
    const { key } = event

    if (!open) {
      if (key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault()
        setOpen(true)
      }
      return
    }

    if (key === 'Escape' || key === 'Tab') {
      // Escape closes without choosing; Tab closes and lets the browser move
      // on, so it must NOT be prevented.
      if (key === 'Escape') event.preventDefault()
      setOpen(false)
      if (key === 'Escape') buttonRef.current?.focus()
      return
    }

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => {
        const next = key === 'ArrowDown' ? i + 1 : i - 1
        return Math.min(options.length - 1, Math.max(0, next))
      })
      return
    }

    if (key === 'Home' || key === 'End') {
      event.preventDefault()
      setActive(key === 'Home' ? 0 : options.length - 1)
      return
    }

    if (key === 'Enter' || key === ' ') {
      event.preventDefault()
      choose(active)
      return
    }

    // TYPEAHEAD. Successive letters within a second build a string, so "va"
    // reaches "Valet vendors" rather than bouncing between the two V entries.
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now()
      typed.current.text = now - typed.current.at > 1000 ? key : typed.current.text + key
      typed.current.at = now
      const needle = typed.current.text.toLowerCase()
      const found = options.findIndex((o) => String(o.label).toLowerCase().startsWith(needle))
      if (found >= 0) setActive(found)
    }
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className={cn(
          'flex h-11 w-full items-center gap-2 rounded-xl border border-line-strong bg-surface pl-3 pr-3 text-sm font-medium text-ink',
          'outline-none transition-colors focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20',
          open && 'border-brand ring-2 ring-brand/20',
        )}
      >
        {icon && <Icon name={icon} size={15} className="shrink-0 text-ink-subtle" />}
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label}</span>
        <Icon
          name="chevron-down"
          size={14}
          className={cn('shrink-0 text-ink-subtle transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          // `glass`, like the notification panel and the account menu — this is
          // the whole reason the native select was replaced.
          // max-h + overflow so a long property list cannot run off the screen.
          className="absolute left-0 top-[calc(100%+0.375rem)] z-50 max-h-72 w-full min-w-[12rem] animate-slide-up overflow-y-auto overflow-x-hidden rounded-xl border p-1 glass scrollbar-slim"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value
            const isActive = index === active
            return (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-active={isActive}
                  // onMouseEnter, so the pointer and the keyboard agree on
                  // which row is "next" — otherwise Enter picks whatever the
                  // arrows last touched while your cursor sits on something
                  // else entirely.
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(index)}
                  onKeyDown={onKeyDown}
                  className={cn(
                    // min-h-11 = 44px: this replaced a native control whose
                    // phone picker had comfortable targets, so the replacement
                    // has to earn that back.
                    'flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm transition-colors',
                    // font-medium on every row: these sit on glass over a
                    // photograph, and 14px grey at regular weight is the
                    // first thing to go soft there.
                    'font-medium',
                    isActive ? 'bg-brand/15 text-ink' : 'text-ink-muted',
                    isSelected && 'font-semibold text-ink',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {/* A tick, not just bold: which one is CHOSEN and which one
                      the pointer happens to be over are different facts, and
                      on a filter they are worth telling apart at a glance. */}
                  {isSelected && <Icon name="check" size={15} className="shrink-0 text-brand" />}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
