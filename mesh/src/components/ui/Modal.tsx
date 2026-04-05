import { type ReactNode, useEffect, useRef } from 'react'
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

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (open) {
      document.addEventListener('keydown', handleEscape)
      return () => document.removeEventListener('keydown', handleEscape)
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
            className="w-full max-w-md rounded-md bg-bg-secondary p-4 shadow-floating"
            variants={variants.modal}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {title && (
              <h2 className="text-base font-semibold text-primary mb-4">{title}</h2>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
