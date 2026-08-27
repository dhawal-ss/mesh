import type { ReactNode } from 'react'

export function AsyncStatus({
  title,
  detail,
  actions,
  compact = false,
  assertive = false,
}: {
  title: string
  /** Only when a reader would act differently for having read it. */
  detail?: string
  actions?: ReactNode
  compact?: boolean
  assertive?: boolean
}) {
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      className={compact ? 'border-y border-outline-variant px-3 py-3' : 'w-full max-w-lg border-y border-outline-variant px-6 py-8 text-center'}
    >
      {/*
        * The amber rule is the activity indicator, not a decorative mark: a
        * segment sweeps it while work is in flight, and reduced motion turns
        * the sweep into a bounded three-step tick. Both live in globals.css
        * under `.mesh-async-rule`.
        */}
      <span
        className={compact ? 'mesh-async-rule block h-px w-12' : 'mesh-async-rule mx-auto block h-px w-16'}
        aria-hidden="true"
      />
      <p className={compact ? 'mt-3 text-body-md font-semibold text-on-surface' : 'mt-4 text-body-lg font-semibold text-on-surface'}>
        {title}
      </p>
      {detail && <p className="mt-1 text-body-md text-on-surface-variant">{detail}</p>}
      {actions ? <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  )
}
