import { useEffect, useState } from 'react'

import { Icon } from '../ui/Icon'

/**
 * The strip above the composer.
 *
 * It reports two different things and must not blur them. A queued message is
 * reassurance: Mesh holds it and will retry on its own. A failed message is the
 * opposite, and it is the highest-cost failure a chat product has, because
 * believing something was delivered when it was not is worse than knowing it
 * failed. Failure used to have no persistent surface here at all: the only
 * signals were a chip on the row itself, an assertive screen-reader region, and
 * a sound. Someone with sound off who had scrolled up, or who was reading
 * another room, got nothing.
 *
 * Failure wins when both are present, because it is the state that needs a
 * person to act.
 */
export function OfflineQueueSummary({
  count,
  failedCount = 0,
  onReview,
  onReviewFailed,
}: {
  count: number
  failedCount?: number
  onReview: () => void
  onReviewFailed?: () => void
}) {
  const [announcedCount, setAnnouncedCount] = useState(0)
  const [announcedFailed, setAnnouncedFailed] = useState(0)

  useEffect(() => {
    const timeout = window.setTimeout(() => setAnnouncedCount(count), 400)
    return () => window.clearTimeout(timeout)
  }, [count])

  useEffect(() => {
    const timeout = window.setTimeout(() => setAnnouncedFailed(failedCount), 400)
    return () => window.clearTimeout(timeout)
  }, [failedCount])

  if (failedCount > 0) {
    const visibleCopy = `${failedCount} ${failedCount === 1 ? 'message' : 'messages'} could not be sent`
    const announcement = announcedFailed > 0
      ? `${announcedFailed} ${announcedFailed === 1 ? 'message could' : 'messages could'} not be sent.`
      : ''
    return (
      <div className="flex min-h-10 items-center gap-2 border-t border-error-container-line bg-error-container px-4 text-label-sm text-on-error-container">
        <Icon name="triangleAlert" size="xs" className="flex-shrink-0 text-error" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold text-on-surface">{visibleCopy}.</span>
        </span>
        <button
          type="button"
          onClick={onReviewFailed ?? onReview}
          className="min-h-8 flex-shrink-0 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
        >
          Review
        </button>
        {/*
          Assertive, unlike the queued case: this is a state the person has to
          know about now, not a background reassurance.
        */}
        <span className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
          {announcement}
        </span>
      </div>
    )
  }

  if (count <= 0) return null

  const visibleCopy = `${count} ${count === 1 ? 'message' : 'messages'} saved for later`
  const announcement = announcedCount > 0
    ? `${announcedCount} ${announcedCount === 1 ? 'message is' : 'messages are'} saved for later.`
    : ''

  return (
    <div className="flex min-h-10 items-center gap-2 border-t border-outline-variant bg-surface-container-lowest px-4 text-label-sm text-on-surface-variant">
      <Icon name="activity" size="xs" className="flex-shrink-0 text-marker" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold text-on-surface">{visibleCopy}.</span>
      </span>
      <button
        type="button"
        onClick={onReview}
        className="min-h-8 flex-shrink-0 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
      >
        Review
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  )
}
