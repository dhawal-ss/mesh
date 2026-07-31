import type { ReactNode } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { Modal } from './Modal'

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
  return (
    <ErrorBoundary
      scope="feature"
      resetKey={resetKey}
      fallback={(resetError) => (
        <div
          className={`flex min-w-0 flex-col items-start gap-2 rounded-control border border-border-subtle bg-surface-sunken px-4 py-3 ${className}`}
          role="alert"
          aria-live="assertive"
        >
          <p className="text-xs font-medium text-secondary">{name} is unavailable</p>
          <p className="text-xs text-muted">{description}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                onRetry?.()
                resetError()
              }}
              className="inline-flex min-h-8 items-center rounded-control px-2 text-xs font-medium text-text-link transition-colors hover:bg-surface-hover hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Try again
            </button>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="inline-flex min-h-8 items-center rounded-control px-2 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {dismissLabel}
              </button>
            )}
          </div>
        </div>
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
            <p className="text-xs leading-5 text-muted">
              Your other conversations and controls are still available.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={resetError}
                className="rounded-control bg-accent px-3 py-1.5 text-xs font-medium text-content-on-accent hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={onClose}
                className="min-h-8 rounded-control bg-surface-hover px-3 text-xs font-medium text-primary hover:bg-surface-active focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
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
