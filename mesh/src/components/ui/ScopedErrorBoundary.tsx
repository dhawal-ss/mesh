import type { ReactNode } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { Modal } from './Modal'
import { Notice } from './Primitives'

interface ScopedErrorBoundaryProps {
  children: ReactNode
  name: string
  description?: string
  className?: string
  resetKey?: string | number | null
  onRetry?: () => void
  onDismiss?: () => void
  dismissLabel?: string
}

export function ScopedErrorBoundary({
  children,
  name,
  description = 'You can retry this section without reloading Mesh.',
  className = '',
  resetKey,
  onRetry,
  onDismiss,
  dismissLabel = 'Close',
}: ScopedErrorBoundaryProps) {
  /*
   * The fallback is intensity 1, an inline advisory: a leading rule in the
   * danger tone and no fill. The section around it stays usable and the retry
   * is the one obvious action. See "Notice intensities" in globals.css.
   */
  return (
    <ErrorBoundary
      scope="feature"
      resetKey={resetKey}
      fallback={(resetError) => (
        <Notice
          intensity="advisory"
          tone="danger"
          title={`${name} is unavailable`}
          className={`min-w-0 ${className}`}
          role="alert"
          aria-live="assertive"
        >
          <p className="text-xs text-muted">{description}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                onRetry?.()
                resetError()
              }}
              className="inline-flex min-h-8 items-center rounded-panel px-2 text-xs font-medium text-text-link transition-colors hover:bg-surface-hover hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              Try again
            </button>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="inline-flex min-h-8 items-center rounded-panel px-2 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                {dismissLabel}
              </button>
            )}
          </div>
        </Notice>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}

interface DialogErrorBoundaryProps {
  children: ReactNode
  open: boolean
  onClose: () => void
  title: string
}

export function DialogErrorBoundary({
  children,
  open,
  onClose,
  title,
}: DialogErrorBoundaryProps) {
  return (
    <ErrorBoundary
      key={`${title}:${open ? 'open' : 'closed'}`}
      scope="feature"
      fallback={(resetError) => (
        <Modal open={open} onClose={onClose} title={title}>
          <div role="alert" aria-live="assertive" className="space-y-3">
            <p className="text-sm font-medium text-secondary">
              This settings panel could not be displayed.
            </p>
            <p className="text-xs text-muted">
              Your other conversations and controls are still available.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={resetError}
                className="rounded-panel bg-accent px-3 py-1.5 text-xs font-medium text-content-on-accent hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={onClose}
                className="min-h-8 rounded-panel bg-surface-hover px-3 text-xs font-medium text-primary hover:bg-surface-active focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
