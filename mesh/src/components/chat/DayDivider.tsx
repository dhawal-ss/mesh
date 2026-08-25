import { formatDayLabel, isoTimestamp } from '../../lib/message-time'

/**
 * Date separator for the message timeline.
 *
 * The timeline previously had no date affordance at all: a reader scrolled back
 * through history with no way to tell what day anything happened, because the
 * only absolute date lived in the ungrouped message header and grouped rows
 * showed a hover-only clock. This is the single highest-value scanning aid in
 * the surface, so it is a permanent row rather than hover state.
 *
 * Deliberately role-less. ARIA permits only `article` children inside a
 * `role="feed"`, and the timeline is a feed, so a `separator` here fails the
 * `aria-required-children` rule that the accessibility suite asserts on. The
 * date is already visible text inside a `<time>`, so the role and its
 * duplicate aria-label carried nothing the reader was not already given.
 */
export function DayDivider({ timestamp }: { timestamp: unknown }) {
  const label = formatDayLabel(timestamp)
  const iso = isoTimestamp(timestamp)

  return (
    <div
      data-day-divider="true"
      className="pointer-events-none sticky top-0 z-sticky flex w-full items-center gap-3 bg-surface-base px-4 py-2"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
      <time
        dateTime={iso}
        className="rounded-panel bg-surface-base px-2 py-0.5 text-caption font-medium lowercase tracking-eyebrow text-content-muted"
      >
        {label}
      </time>
      <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
    </div>
  )
}
