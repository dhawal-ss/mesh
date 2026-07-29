import { useState, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { variants } from '../../lib/motion'

export type ToastTone = 'success' | 'danger' | 'info' | 'warning'

interface ToastState {
  id: number
  message: string
  tone: ToastTone
}

let toastId = 0
let addToastFn: ((message: string, tone: ToastTone) => void) | null = null

export function showToast(message: string, tone: ToastTone | 'error' = 'info') {
  addToastFn?.(message, tone === 'error' ? 'danger' : tone)
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastState[]>([])

  const addToast = useCallback((message: string, tone: ToastTone) => {
    const id = ++toastId
    setToasts((prev) => [...prev, { id, message, tone }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4000)
  }, [])

  useEffect(() => {
    addToastFn = addToast
    return () => { addToastFn = null }
  }, [addToast])

  if (toasts.length === 0) return null

  return (
    <div
      className="fixed bottom-4 left-4 right-4 z-toast flex flex-col items-end gap-2 sm:left-auto"
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Notifications"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            variants={variants.toast}
            initial="initial"
            animate="animate"
            exit="exit"
            className={`w-fit max-w-full rounded-panel border border-border-subtle bg-surface-overlay px-3 py-2 text-sm font-medium shadow-overlay ${
              toast.tone === 'danger'
                ? 'border-l-2 border-l-status-danger text-status-danger'
                : toast.tone === 'success'
                  ? 'border-l-2 border-l-status-success text-status-success'
                  : toast.tone === 'warning'
                    ? 'border-l-2 border-l-status-warning text-status-warning'
                    : 'border-l-2 border-l-status-info text-content'
            }`}
          >
            {toast.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
