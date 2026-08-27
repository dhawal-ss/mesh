import { useId, useState } from 'react'
import clsx from 'clsx'
import { describeError, errorDetail, type ErrorContext } from '../../lib/errors'
import { Button } from './Button'
import { Icon } from './Icon'
import { useSettingsStore } from '../../store/settings'

interface ErrorStateProps {
  error: unknown
  context?: ErrorContext
  userMessage?: string
  onAction?: () => void
  actionLabel?: string
  className?: string
  compact?: boolean
}

export function ErrorState({
  error,
  context,
  userMessage,
  onAction,
  actionLabel,
  className,
  compact = false,
}: ErrorStateProps) {
  const titleId = useId()
  const [copyStatus, setCopyStatus] = useState('')
  const signalCheckEnabled = useSettingsStore((state) => state.signalCheckEnabled)
  const description = describeError(error, context)
  const details = signalCheckEnabled ? errorDetail(error) : null
  const primaryAction = actionLabel ?? description.action

  const copyDetails = async () => {
    if (!details) return
    try {
      await navigator.clipboard.writeText(details)
      setCopyStatus('Copied')
    } catch {
      setCopyStatus('Copy failed')
    }
  }

  return (
    <section
      role="alert"
      aria-labelledby={titleId}
      className={clsx(
        'mesh-error-state border-y border-error-container-line text-left',
        compact ? 'px-3 py-2' : 'p-4',
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="mesh-error-icon mt-0.5 flex h-7 w-7 flex-none items-center justify-center text-on-error-container" aria-hidden="true">
          <Icon name="triangleAlert" size="sm" />
        </span>
        <div className="min-w-0">
          <h3 id={titleId} className={clsx('font-semibold text-error', compact ? 'text-body-sm' : 'text-body-md')}>
            {description.title}
          </h3>
          <p className={clsx('text-on-surface-variant', compact ? 'mt-0.5 text-body-sm' : 'mt-1 text-body-md')}>
            {userMessage ?? description.body}
          </p>
        </div>
      </div>
      {onAction && primaryAction && (
        <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={onAction}>
          {primaryAction}
        </Button>
      )}
      {details && <details className="mt-2 text-body-sm text-on-surface-variant">
        <summary className="flex min-h-8 w-fit cursor-pointer select-none items-center rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
          Details
        </summary>
        <pre className="mesh-error-details mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all py-2 text-body-sm text-on-surface-variant">
          {details}
        </pre>
        <div className="mt-2 flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={copyDetails}>
            Copy details
          </Button>
          <span role="status" aria-live="polite">
            {copyStatus}
          </span>
        </div>
      </details>}
    </section>
  )
}
