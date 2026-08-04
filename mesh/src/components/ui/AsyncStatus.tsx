import type { ReactNode } from 'react'

export function AsyncStatus({
  title,
  detail,
  actions,
  compact = false,
  assertive = false,
}: {
  title: string
  detail: string
  actions?: ReactNode
  compact?: boolean
  assertive?: boolean
}) {
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      className={compact ? 'border-y border-border-subtle px-3 py-3' : 'w-full max-w-lg border-y border-border-subtle px-6 py-8 text-center'}
    >
      <span className={compact ? 'block h-px w-12 bg-accent' : 'mx-auto block h-px w-16 bg-accent'} aria-hidden="true" />
      <p className={compact ? 'mt-3 text-sm font-semibold text-primary' : 'mt-4 text-base font-semibold text-primary'}>
        {title}
      </p>
      <p className="mt-1 text-sm leading-6 text-secondary">{detail}</p>
      {actions ? <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  )
}
