import { Skeleton } from './Skeleton'

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
        className="fixed left-1/2 top-1/2 z-modal min-h-32 w-11/12 max-w-md -translate-x-1/2 -translate-y-1/2 rounded-panel border border-border-subtle bg-surface-raised p-4 text-sm text-content-muted shadow-overlay"
      >
        <span className="font-medium text-content">{title}</span>
        <span className="mt-1 block">{label}…</span>
        <div className="mt-4 space-y-2" aria-hidden="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-4/5" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      </div>
    </>
  )
}
