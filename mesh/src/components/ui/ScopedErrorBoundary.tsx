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
          <p className="text-body-sm text-on-surface-variant">{description}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                onRetry?.()
                resetError()
              }}
              className="inline-flex min-h-8 items-center rounded-xl px-2 text-body-sm font-medium text-primary transition-colors hover:bg-surface-container-high hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              Try again
            </button>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="inline-flex min-h-8 items-center rounded-xl px-2 text-body-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
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
            <p className="text-body-md font-medium text-on-surface-variant">
              This settings panel could not be displayed.
            </p>
            <p className="text-body-sm text-on-surface-variant">
              Your other conversations and controls are still available.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={resetError}
                className="rounded-xl bg-primary px-3 py-1.5 text-body-sm font-medium text-on-primary hover:bg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={onClose}
                className="min-h-8 rounded-xl bg-surface-container-high px-3 text-body-sm font-medium text-on-surface hover:bg-surface-container-highest focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
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
