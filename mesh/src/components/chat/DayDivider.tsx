import { formatDayLabel, isoTimestamp } from '../../lib/message-time'

/**
 * Date separator for the message timeline.
 *
 * The timeline previously had no date affordance at all: a reader scrolled back
 * through history with no way to tell what day anything happened, because the
 * only absolute date lived in the ungrouped message header and grouped rows
 * showed a hover-only clock. This is the single highest-value scanning aid in
 * the surface, so it is rendered as a real separator rather than hover state.
 *
 * Rendered as a `<li>`-free plain row with `role="separator"` so it does not
 * pollute the message count, and with an aria-label carrying the resolved date.
 */
export function DayDivider({ timestamp }: { timestamp: unknown }) {
  const label = formatDayLabel(timestamp)
  const iso = isoTimestamp(timestamp)

  return (
    <div
      className="pointer-events-none sticky top-0 z-sticky flex w-full items-center gap-3 bg-surface-base px-4 py-2"
      role="separator"
      aria-label={label}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
      <time
        dateTime={iso}
        className="rounded-control bg-surface-base px-2 py-0.5 text-caption font-medium uppercase tracking-caption text-content-muted"
      >
        {label}
      </time>
      <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
    </div>
  )
}
