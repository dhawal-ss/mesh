import { type ReactNode, useEffect, useId, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { variants } from '../../lib/motion'

interface ModalProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  title?: string
}

export function Modal({ open, onClose, children, title }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ))
      if (focusable.length === 0) {
        e.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    if (open) {
      document.addEventListener('keydown', handleEscape)
      window.requestAnimationFrame(() => {
        const first = dialogRef.current?.querySelector<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        )
        ;(first ?? dialogRef.current)?.focus()
      })
      return () => {
        document.removeEventListener('keydown', handleEscape)
        previouslyFocused?.focus()
      }
    }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={overlayRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6"
          variants={variants.overlay}
          initial="initial"
          animate="animate"
          exit="exit"
          onClick={(e) => {
            if (e.target === overlayRef.current) onClose()
          }}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-label={title ? undefined : 'Dialog'}
            tabIndex={-1}
            className="w-full max-w-md rounded-md bg-bg-secondary p-4 shadow-floating"
            variants={variants.modal}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {title && (
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 id={titleId} className="text-base font-semibold text-primary">{title}</h2>
                <button
                  type="button"
                  aria-label="Close dialog"
                  className="rounded px-2 py-1 text-lg leading-none text-muted hover:bg-bg-modifier-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue"
                  onClick={onClose}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
