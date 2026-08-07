import { useState, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from '../../lib/lazy-motion'
import { variants } from '../../lib/motion'
import { Icon, type IconName } from './Icon'

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
   * in the same tick, which screen readers generally do not announce: every
   * moderation result, copy confirmation and error was silent.
   */
  return (
    <div
      className="mesh-toast-container pointer-events-none fixed left-4 right-4 z-toast flex flex-col items-end gap-2 sm:left-auto"
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
  const icon: IconName = toast.tone === 'danger'
    ? 'circleX'
    : toast.tone === 'success'
      ? 'check'
      : toast.tone === 'warning'
        ? 'triangleAlert'
        : 'messageCircle'
  const iconTone = toast.tone === 'danger'
    ? 'bg-status-danger/10 text-status-danger'
    : toast.tone === 'success'
      ? 'bg-status-success/10 text-status-success'
      : toast.tone === 'warning'
        ? 'bg-status-warning/10 text-status-warning'
        : 'bg-status-info/10 text-status-info'

  return (
    <motion.div
      variants={variants.toast}
      initial="initial"
      animate="animate"
      exit="exit"
      className={`pointer-events-auto flex w-fit max-w-full items-center gap-2 rounded-panel border border-border-subtle bg-surface-overlay p-2 text-sm font-medium text-content shadow-overlay ${
        toast.tone === 'danger'
          ? 'border-l-2 border-l-status-danger'
          : toast.tone === 'success'
            ? 'border-l-2 border-l-status-success'
            : toast.tone === 'warning'
              ? 'border-l-2 border-l-status-warning'
              : 'border-l-2 border-l-status-info'
      }`}
    >
      <span className={`flex h-8 w-8 flex-none items-center justify-center rounded-control ${iconTone}`}>
        <Icon name={icon} size="sm" />
      </span>
      <span className="min-w-0 flex-1 px-1">{toast.message}</span>
      <button
        type="button"
        className="flex h-8 w-8 flex-none items-center justify-center rounded-control text-content-muted hover:bg-surface-hover hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={`Dismiss notification: ${toast.message}`}
        onClick={() => onDismiss(toast.id)}
      >
        <Icon name="x" size="sm" />
      </button>
    </motion.div>
  )
}
