import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { motion } from 'framer-motion'
import clsx from 'clsx'
import { variants } from '../../lib/motion'
import { Icon } from './Icon'

export interface ModalProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  title?: string
  description?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
} as const

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
}: ModalProps) {
  const openerRef = useRef<HTMLElement | null>(null)
  const openingFocusTarget = useMemo(
    () => open && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
    [open],
  )
  useLayoutEffect(() => {
    if (open && openingFocusTarget) {
      openerRef.current = openingFocusTarget
    }
  }, [open, openingFocusTarget])

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) return
        onClose()
        window.setTimeout(() => {
          openerRef.current?.focus()
          openerRef.current = null
        }, 0)
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay asChild>
          <motion.div
            className="fixed inset-0 z-overlay bg-surface-scrim"
            variants={variants.overlay}
            initial="initial"
            animate="animate"
            exit="exit"
          />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          aria-modal="true"
          className={clsx(
            'fixed left-1/2 top-1/2 z-modal max-h-screen w-11/12 -translate-x-1/2 -translate-y-1/2 overflow-auto focus:outline-none',
            sizeClasses[size],
            className,
          )}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            openerRef.current?.focus()
          }}
        >
          <motion.div
            className="relative rounded-lg bg-surface-raised p-4 text-content shadow-floating"
            variants={variants.modal}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <DialogPrimitive.Title
              className={title ? 'pr-10 text-base font-semibold text-content' : 'sr-only'}
            >
              {title ?? 'Dialog'}
            </DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className="mt-1 pr-10 text-sm text-content-secondary">
                {description}
              </DialogPrimitive.Description>
            )}
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="Close dialog"
                className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-content-muted hover:bg-surface-hover hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <Icon name="x" size="sm" />
              </button>
            </DialogPrimitive.Close>
            <div className={clsx(title || description ? 'mt-4' : undefined)}>{children}</div>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export const Dialog = Modal
