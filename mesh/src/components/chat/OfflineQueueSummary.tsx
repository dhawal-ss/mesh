import { useEffect, useState } from 'react'

import { Icon } from '../ui/Icon'

export function OfflineQueueSummary({
  count,
  onReview,
}: {
  count: number
  onReview: () => void
}) {
  const [announcedCount, setAnnouncedCount] = useState(0)

  useEffect(() => {
    const timeout = window.setTimeout(() => setAnnouncedCount(count), 400)
    return () => window.clearTimeout(timeout)
  }, [count])

  if (count <= 0) return null

  const visibleCopy = `${count} ${count === 1 ? 'message' : 'messages'} saved for later`
  const announcement = announcedCount > 0
    ? `${announcedCount} ${announcedCount === 1 ? 'message is' : 'messages are'} saved for later.`
    : ''

  return (
    <div className="flex min-h-10 items-center gap-2 border-t border-border-subtle bg-surface-sunken px-4 text-caption text-secondary">
      <Icon name="activity" size="xs" className="flex-shrink-0 text-status-warning" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold text-primary">{visibleCopy}.</span>{' '}
        Mesh will send {count === 1 ? 'it' : 'them'} when the connection is ready.
      </span>
      <button
        type="button"
        onClick={onReview}
        className="min-h-8 flex-shrink-0 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
      >
        Review
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  )
}
