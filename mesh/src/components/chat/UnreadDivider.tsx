export function UnreadDivider() {
  return (
    <div
      data-unread-divider="true"
      className="flex h-10 items-center gap-3 px-4"
      role="separator"
      aria-label="New messages"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-status-danger/60" />
      <span className="rounded-control bg-surface-base px-2 py-0.5 text-caption font-semibold uppercase tracking-caption text-status-danger">
        New messages
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-status-danger/60" />
    </div>
  )
}
