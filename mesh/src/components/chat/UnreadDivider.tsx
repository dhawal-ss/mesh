interface UnreadDividerProps {
  /**
   * Clears the unread boundary for this conversation. Optional so the divider
   * still renders on surfaces that have no read-marker owner yet; when it is
   * omitted the divider stays purely informational.
   */
  onMarkRead?: () => void
}

/**
 * The "you stopped reading here" boundary.
 *
 * The rule and label use the accent, not the danger token: not having read
 * something yet is not a failure, and in high contrast the two tokens collapse
 * onto the same colour. The "New messages" label stays as the non-colour cue.
 *
 * The rule is the 3px Bauhaus bar rather than a hairline, so "new" reads as
 * structure and not only as accent colour. That also separates it from the
 * DayDivider, which is a hairline because a date merely separates related
 * content while an unread boundary marks the one live edge in the timeline.
 *
 * Deliberately role-less. ARIA permits only `article` children inside a
 * `role="feed"`, and the timeline is a feed, so a `separator` here fails the
 * `aria-required-children` rule that the accessibility suite asserts on.
 * `role="separator"` also made its own children presentational, which hid the
 * visible "New messages" text; without the role that text is the label, and
 * "Mark as read" stays a sibling so it is always reachable.
 */
export function UnreadDivider({ onMarkRead }: UnreadDividerProps) {
  return (
    <div data-unread-divider="true" className="flex h-10 items-center gap-3 px-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span aria-hidden="true" className="flex-1 border-t-bar border-primary-container-line" />
        <span className="rounded-xl bg-surface px-2 py-0.5 text-label-sm font-semibold lowercase tracking-label-md text-primary">
          New messages
        </span>
        <span aria-hidden="true" className="flex-1 border-t-bar border-primary-container-line" />
      </div>
      {onMarkRead && (
        <button
          type="button"
          onClick={onMarkRead}
          className="min-h-control-sm flex-shrink-0 rounded-full px-2 text-body-sm font-medium text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        >
          Mark as read
        </button>
      )}
    </div>
  )
}
