/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/components/ui/Modal.jsx                                   │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   The dialog used for add/edit forms and destructive confirmations.  │
 * │     Modal        — the dialog itself                                │
 * │     ConfirmModal — a preset for "are you sure" prompts              │
 * │                                                                     │
 * │ WHY IT EXISTS                                                       │
 * │   Built on the native <dialog> element rather than a div + portal,   │
 * │   because the browser then gives us for free the three things        │
 * │   hand-rolled modals almost always get wrong: focus is trapped       │
 * │   inside, Escape closes it, and content behind it is hidden from     │
 * │   screen readers.                                                    │
 * │                                                                     │
 * │   Two behaviours we add on top:                                      │
 * │   1. Body scroll is locked while open. Without this, scrolling on a  │
 * │      phone scrolls the page behind the sheet, which feels broken.    │
 * │   2. On phones it renders as a bottom sheet, on desktop as a         │
 * │      centred dialog. A centred box on a phone puts its buttons in    │
 * │      the middle of the screen, out of thumb reach.                   │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   system/Users (add user), system/Properties (add/edit property),    │
 * │   admin/TokenMgmt (create / extend range), any confirm prompt.       │
 * │                                                                     │
 * │ DEPENDS ON                                                          │
 * │   ui/Icon, ui/Button, utils/cn                                      │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useRef } from 'react'
import Icon from './Icon'
import Button from './Button'
import { useT } from '@/i18n'
import { cn } from '@/utils/cn'

export default function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  /** Set false for a form with unsaved input, so a stray tap cannot discard it. */
  closeOnBackdrop = true,
}) {
  const t = useT()

  const ref = useRef(null)

  // Drive the native dialog imperatively — showModal() is what activates the
  // browser's focus trap and inert-background behaviour.
  useEffect(() => {
    const el = ref.current
    if (!el) return

    if (open && !el.open) el.showModal()
    else if (!open && el.open) el.close()
  }, [open])

  // The dialog's own Escape handling closes the element but does not tell
  // React, so our `open` prop would go stale. Forward it.
  useEffect(() => {
    const el = ref.current
    if (!el) return

    const handleCancel = (event) => {
      event.preventDefault() // stop the browser closing it behind React's back
      onClose?.()
    }
    el.addEventListener('cancel', handleCancel)
    return () => el.removeEventListener('cancel', handleCancel)
  }, [onClose])

  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  const widths = {
    sm: 'sm:max-w-sm',
    md: 'sm:max-w-md',
    lg: 'sm:max-w-lg',
    xl: 'sm:max-w-2xl',
  }

  return (
    <dialog
      ref={ref}
      // ::backdrop cannot be targeted by a Tailwind utility, so it is styled
      // through the backdrop: modifier here.
      className={cn(
        'w-full max-w-none bg-transparent p-0 backdrop:bg-ink/45 backdrop:backdrop-blur-sm',
        // Phone: pinned to the bottom as a sheet.
        'fixed bottom-0 left-0 top-auto m-0 translate-x-0',
        // Desktop: centred dialog.
        'sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:p-0',
        widths[size] ?? widths.md,
      )}
      onClick={(event) => {
        // A click that lands on the <dialog> itself (not its content box) is a
        // backdrop click.
        if (closeOnBackdrop && event.target === ref.current) onClose?.()
      }}
    >
      <div
        className={cn(
          'flex max-h-[88vh] flex-col overflow-hidden bg-surface shadow-pop',
          'animate-slide-up rounded-t-2xl sm:rounded-2xl',
        )}
      >
        {(title || onClose) && (
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              {title && <h2 className="text-lg font-semibold text-ink">{title}</h2>}
              {description && <p className="mt-1 text-sm text-ink-subtle">{description}</p>}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label={t('common.close')}
              className="-mr-1 -mt-1"
            >
              <Icon name="close" size={19} />
            </Button>
          </div>
        )}

        <div className="scrollbar-slim flex-1 overflow-y-auto px-5 py-5">{children}</div>

        {footer && (
          <div className="flex flex-col-reverse gap-2 border-t border-line bg-surface-sunken px-5 py-4 sm:flex-row sm:justify-end">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  )
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  // Defaults are null, not English: they are resolved through t() below, so
  // a literal here would be an untranslatable fallback nobody would notice.
  title = null,
  description,
  confirmLabel = null,
  cancelLabel = null,
  tone = 'danger',
}) {
  const t = useT()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? t('common.areYouSure')}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          {/* onConfirm may be async — Button handles its own loading state. */}
          <Button variant={tone} size="md" onClick={onConfirm}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-muted">
        {t('common.cannotUndo')}
      </p>
    </Modal>
  )
}
