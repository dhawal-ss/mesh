import clsx from 'clsx'
import { modalSizeClasses, type ModalSize } from './Modal'
import { Skeleton } from './Skeleton'

export function ModalLoadingFallback({
  title,
  label,
  size = 'md',
}: {
  title: string
  label: string
  size?: ModalSize
}) {
  return (
    <>
      <div className="fixed inset-0 z-overlay bg-surface-scrim" aria-hidden />
      <div
        role="status"
        aria-label={label}
        aria-live="polite"
        className={clsx(
          'mesh-modal-loading fixed left-1/2 top-1/2 z-modal min-h-32 w-11/12 -translate-x-1/2 -translate-y-1/2 rounded-panel border border-border-subtle bg-surface-raised text-sm text-content-muted shadow-overlay',
          modalSizeClasses[size],
        )}
      >
        {/* This stands in for a dialog title, so it is sized like one. */}
        <span className="mesh-loading-title text-title font-semibold text-content">{title}</span>
        <span className="mt-1 block">{label}…</span>
        <div className="mesh-loading-lines space-y-2" aria-hidden="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-4/5" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      </div>
    </>
  )
}
