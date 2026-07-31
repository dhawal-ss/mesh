import { useState, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from '../../lib/lazy-motion'
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
  }, [])
  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  useEffect(() => {
    addToastFn = addToast
    return () => { addToastFn = null }
  }, [addToast])

  /*
   * The live region must exist in the DOM *before* the message lands in it.
   * Returning null while empty meant the region and its content were inserted
   * in the same tick, which screen readers generally do not announce — every
   * moderation result, copy confirmation and error was silent.
   */
  return (
    <div
      className="pointer-events-none fixed bottom-4 left-4 right-4 z-toast flex flex-col items-end gap-2 sm:left-auto"
      role="region"
      aria-label="Notifications"
    >
      <div role="status" aria-live="polite" aria-atomic="false" className="contents">
        <AnimatePresence initial={false}>
          {toasts.filter((toast) => toast.tone !== 'danger').map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
          ))}
        </AnimatePresence>
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="false" className="contents">
        <AnimatePresence initial={false}>
          {toasts.filter((toast) => toast.tone === 'danger').map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastState
  onDismiss: (id: number) => void
}) {
  return (
    <motion.div
      variants={variants.toast}
      initial="initial"
      animate="animate"
      exit="exit"
      className={`pointer-events-auto flex w-fit max-w-full items-start gap-2 rounded-panel border border-border-subtle bg-surface-overlay px-3 py-2 text-sm font-medium shadow-overlay ${
        toast.tone === 'danger'
          ? 'border-l-2 border-l-status-danger text-status-danger'
          : toast.tone === 'success'
            ? 'border-l-2 border-l-status-success text-status-success'
            : toast.tone === 'warning'
              ? 'border-l-2 border-l-status-warning text-status-warning'
              : 'border-l-2 border-l-status-info text-content'
      }`}
    >
      <span className="min-w-0 flex-1">{toast.message}</span>
      <button
        type="button"
        className="min-h-8 flex-none rounded-control px-2 text-xs text-content-secondary hover:bg-surface-hover hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={`Dismiss notification: ${toast.message}`}
        onClick={() => onDismiss(toast.id)}
      >
        Dismiss
      </button>
    </motion.div>
  )
}
