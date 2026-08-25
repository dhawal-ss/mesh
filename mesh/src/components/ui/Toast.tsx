import { useState, useEffect, useCallback, useRef, type CSSProperties } from 'react'
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
const pendingToasts: Array<{ message: string; tone: ToastTone }> = []
const MAX_PENDING_TOASTS = 5
const MAX_VISIBLE_TOASTS = 3

/*
 * Dwell mirrors --toast-dwell-default and --toast-dwell-warning in globals.css.
 * A warning is read, not glanced at, so it gets the longer deadline. Danger has
 * no deadline at all: an error is acknowledged by a person.
 */
const TOAST_DWELL_MS: Record<ToastTone, number | null> = {
  success: 5_000,
  info: 5_000,
  warning: 8_000,
  danger: null,
}

export function showToast(message: string, tone: ToastTone | 'error' = 'info') {
  const normalizedTone = tone === 'error' ? 'danger' : tone
  if (addToastFn) {
    addToastFn(message, normalizedTone)
    return
  }
  pendingToasts.push({ message, tone: normalizedTone })
  if (pendingToasts.length > MAX_PENDING_TOASTS) pendingToasts.shift()
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
    for (const pending of pendingToasts.splice(0)) {
      // Replay belongs to external notification subscription setup. Keeping it
      // synchronous prevents a startup failure from being lost between mounts.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      addToast(pending.message, pending.tone)
    }
    return () => { addToastFn = null }
  }, [addToast])

  /*
   * The visible stack is capped so a run of copy confirmations cannot bury the
   * composer. Only self-dismissing tones are collapsed: a danger toast has no
   * dwell, so collapsing one would hide an unacknowledged failure behind a
   * number with nothing left to reveal it. Collapsed toasts stay mounted and
   * keep their own timers, so the stack drains on its own schedule.
   */
  const dismissible = toasts.filter((toast) => toast.tone !== 'danger')
  const persistent = toasts.filter((toast) => toast.tone === 'danger')
  const dismissibleSlots = Math.max(0, MAX_VISIBLE_TOASTS - persistent.length)
  const collapsedCount = Math.max(0, dismissible.length - dismissibleSlots)
  const collapsedIds = new Set(dismissible.slice(0, collapsedCount).map((toast) => toast.id))

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
      {collapsedCount > 0 && (
        // Deliberately outside both live regions: these were announced on
        // arrival, and a changing count must not re-interrupt the reader.
        <p className="mesh-toast rounded-panel border border-border-subtle bg-surface-overlay px-2 py-1 text-meta text-content-secondary shadow-overlay">
          {collapsedCount === 1 ? '1 earlier notification' : `${collapsedCount} earlier notifications`}
        </p>
      )}
      <div role="status" aria-live="polite" aria-atomic="false" className="contents">
        <AnimatePresence initial={false}>
          {dismissible.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              collapsed={collapsedIds.has(toast.id)}
              onDismiss={dismissToast}
            />
          ))}
        </AnimatePresence>
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="false" className="contents">
        <AnimatePresence initial={false}>
          {persistent.map((toast) => (
            <ToastItem key={toast.id} toast={toast} collapsed={false} onDismiss={dismissToast} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

function ToastItem({
  toast,
  collapsed,
  onDismiss,
}: {
  toast: ToastState
  collapsed: boolean
  onDismiss: (id: number) => void
}) {
  const dwellMs = TOAST_DWELL_MS[toast.tone]
  const [paused, setPaused] = useState(false)
  const remainingRef = useRef(dwellMs ?? 0)

  useEffect(() => {
    if (dwellMs === null || paused) return
    const startedAt = Date.now()
    const timer = window.setTimeout(() => onDismiss(toast.id), remainingRef.current)
    return () => {
      window.clearTimeout(timer)
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt))
    }
  }, [dwellMs, paused, onDismiss, toast.id])

  const icon: IconName = toast.tone === 'danger'
    ? 'circleX'
    : toast.tone === 'success'
      ? 'check'
      : toast.tone === 'warning'
        ? 'triangleAlert'
        : 'messageCircle'
  const iconTone = toast.tone === 'danger'
    ? 'bg-container-danger text-on-container-danger'
    : toast.tone === 'success'
      ? 'bg-container-success text-on-container-success'
      : toast.tone === 'warning'
        ? 'bg-container-warning text-on-container-warning'
        : 'bg-container-info text-on-container-info'
  const dwellStyle = dwellMs === null
    ? undefined
    : ({ '--mesh-toast-dwell': `${dwellMs}ms` } as CSSProperties)

  return (
    <motion.div
      variants={variants.toast}
      initial="initial"
      animate="animate"
      exit="exit"
      style={dwellStyle}
      data-dwell-paused={dwellMs !== null && paused ? 'true' : undefined}
      // Hover and keyboard focus both hold the deadline open. onFocus and onBlur
      // bubble in React, so this is focus-within for the action and the dismiss.
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={`mesh-toast pointer-events-auto relative w-fit max-w-full items-center gap-2 rounded-panel border border-border-subtle bg-surface-overlay p-2 text-sm font-medium text-content shadow-overlay ${
        collapsed ? 'hidden' : 'flex'
      } ${
        toast.tone === 'danger'
          ? 'border-l-bar border-l-status-danger'
          : toast.tone === 'success'
            ? 'border-l-bar border-l-status-success'
            : toast.tone === 'warning'
              ? 'border-l-bar border-l-status-warning'
              : 'border-l-bar border-l-status-info'
      }`}
    >
      <span className={`mesh-toast-icon flex h-8 w-8 flex-none items-center justify-center rounded-panel ${iconTone}`}>
        <Icon name={icon} size="sm" />
      </span>
      <span className="min-w-0 flex-1 px-1">{toast.message}</span>
      <button
        type="button"
        className="flex h-8 w-8 flex-none items-center justify-center rounded-panel text-content-muted hover:bg-surface-hover hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        aria-label={`Dismiss notification: ${toast.message}`}
        onClick={() => onDismiss(toast.id)}
      >
        <Icon name="x" size="sm" />
      </button>
      {dwellMs !== null && (
        <span aria-hidden="true" className="mesh-toast-progress absolute inset-x-0 bottom-0 h-px bg-accent" />
      )}
    </motion.div>
  )
}
