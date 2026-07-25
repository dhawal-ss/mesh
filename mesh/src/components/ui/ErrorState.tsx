import { useId, useState } from 'react'
import clsx from 'clsx'
import { describeError, errorDetail, type ErrorContext } from '../../lib/errors'
import { Button } from './Button'

interface ErrorStateProps {
  error: unknown
  context?: ErrorContext
  onAction?: () => void
  actionLabel?: string
  className?: string
  compact?: boolean
}

export function ErrorState({
  error,
  context,
  onAction,
  actionLabel,
  className,
  compact = false,
}: ErrorStateProps) {
  const titleId = useId()
  const [copyStatus, setCopyStatus] = useState('')
  const description = describeError(error, context)
  const details = errorDetail(error)
  const primaryAction = actionLabel ?? description.action

  const copyDetails = async () => {
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
        'rounded-md border border-red/40 bg-red/10 text-left',
        compact ? 'px-3 py-2' : 'p-4',
        className,
      )}
    >
      <h3 id={titleId} className={clsx('font-semibold text-red', compact ? 'text-xs' : 'text-sm')}>
        {description.title}
      </h3>
      <p className={clsx('leading-5 text-secondary', compact ? 'mt-0.5 text-xs' : 'mt-1 text-sm')}>
        {description.body}
      </p>
      {onAction && primaryAction && (
        <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={onAction}>
          {primaryAction}
        </Button>
      )}
      <details className="mt-2 text-xs text-muted">
        <summary className="w-fit cursor-pointer select-none rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue">
          Details
        </summary>
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-primary p-2 font-mono text-meta text-secondary">
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
      </details>
    </section>
  )
}
