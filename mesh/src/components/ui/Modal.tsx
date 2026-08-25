import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { motion } from '../../lib/lazy-motion'
import clsx from 'clsx'
import { variants } from '../../lib/motion'
import { Icon } from './Icon'

export interface ModalProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  title?: string
  description?: string
  size?: ModalSize
  className?: string
  closeLabel?: string
}

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

export const modalSizeClasses: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
} as const

let nextRestoreFocusTarget: HTMLElement | null = null

function isPersistentFocusTarget(target: HTMLElement | null): target is HTMLElement {
  return Boolean(
    target
    && target !== document.body
    && target.isConnected,
  )
}

/**
 * Registers a persistent focus target for the next Modal that opens.
 *
 * Use this when one overlay opens a dialog while unmounting itself. The active
 * element inside the outgoing overlay is not a safe restoration target.
 */
export function setNextModalRestoreFocusTarget(target: HTMLElement | null) {
  nextRestoreFocusTarget = isPersistentFocusTarget(target) ? target : null
}

function takeNextModalRestoreFocusTarget() {
  const target = nextRestoreFocusTarget
  nextRestoreFocusTarget = null
  return isPersistentFocusTarget(target) ? target : null
}

function focusPersistentTarget(target: HTMLElement | null) {
  if (!isPersistentFocusTarget(target)) return
  target.focus()
}

/**
 * Product dialog abstraction. Radix owns focus trapping, Escape handling,
 * background inertness, announcements, and focus restoration.
 */
export function Modal({
  open,
  onClose,
  children,
  title,
  description,
  size = 'md',
  className,
  closeLabel = 'Close dialog',
}: ModalProps) {
  const openerRef = useRef<HTMLElement | null>(null)
  const openingFocusTarget = useMemo(
    () => open && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
    [open],
  )
  useLayoutEffect(() => {
    if (open && !openerRef.current) {
      openerRef.current = takeNextModalRestoreFocusTarget()
        ?? (isPersistentFocusTarget(openingFocusTarget) ? openingFocusTarget : null)
    }
  }, [open, openingFocusTarget])

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) return
        const restoreTarget = openerRef.current
        onClose()
        window.setTimeout(() => {
          focusPersistentTarget(restoreTarget)
          if (openerRef.current === restoreTarget) openerRef.current = null
        }, 0)
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay asChild>
          <motion.div
            className="fixed inset-0 z-overlay bg-surface-scrim backdrop-blur-sm"
            variants={variants.overlay}
            initial="initial"
            animate="animate"
            exit="exit"
          />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          aria-modal="true"
          className={clsx(
            'fixed left-1/2 top-1/2 z-modal max-h-modal w-11/12 -translate-x-1/2 -translate-y-1/2 overflow-auto focus:outline-none',
            modalSizeClasses[size],
            className,
          )}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            focusPersistentTarget(openerRef.current)
            openerRef.current = null
          }}
        >
          {/*
            * Geometry, padding, and the shell surface belong to
            * `.mesh-modal-surface` in globals.css. The JSX used to also declare
            * `p-5`, `right-4 top-4` and `mt-4`, none of which survived the
            * cascade, so reading this component described a dialog that never
            * shipped. Structure stays here, appearance stays there.
            */}
          <motion.div
            className="mesh-modal-surface mesh-overlay-surface relative text-content"
            variants={variants.modal}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <DialogPrimitive.Title
              className={title ? 'mesh-modal-title text-title font-semibold text-content' : 'sr-only'}
            >
              {title ?? 'Dialog'}
            </DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className="mesh-modal-description mt-1.5 max-w-2xl text-sm text-content-secondary">
                {description}
              </DialogPrimitive.Description>
            )}
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label={closeLabel}
                className="mesh-modal-close absolute inline-flex h-control-md w-control-md items-center justify-center rounded-panel border border-transparent text-content-muted hover:border-border-subtle hover:bg-surface-hover hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                <Icon name="x" size="sm" />
              </button>
            </DialogPrimitive.Close>
            <div className="mesh-modal-body">{children}</div>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export const Dialog = Modal
