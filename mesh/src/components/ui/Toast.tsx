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
      className="fixed bottom-4 right-4 z-toast flex flex-col gap-2"
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
            className={`rounded-lg border px-4 py-3 text-sm font-medium shadow-floating ${
              toast.tone === 'danger'
                ? 'border-status-danger/30 bg-status-danger text-content-on-status'
                : toast.tone === 'success'
                  ? 'border-status-success/30 bg-status-success text-content-on-status'
                  : toast.tone === 'warning'
                    ? 'border-status-warning/30 bg-status-warning text-surface-sunken'
                    : 'border-border bg-surface-overlay text-content'
            }`}
          >
            {toast.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
