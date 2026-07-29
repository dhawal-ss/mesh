import { Spinner } from './Spinner'

export function ModalLoadingFallback({
  title,
  label,
}: {
  title: string
  label: string
}) {
  return (
    <>
      <div className="fixed inset-0 z-overlay bg-surface-scrim" aria-hidden />
      <div
        role="status"
        aria-label={label}
        aria-live="polite"
        className="fixed left-1/2 top-1/2 z-modal flex min-h-32 w-11/12 max-w-md -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-3 rounded-panel border border-border-subtle bg-surface-raised p-4 text-sm text-content-muted shadow-overlay"
      >
        <Spinner />
        <span className="font-medium text-content">{title}</span>
        <span>{label}…</span>
      </div>
    </>
  )
}
