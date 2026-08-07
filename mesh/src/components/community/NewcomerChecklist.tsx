import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  deriveNewcomerChecklistSteps,
  NEWCOMER_CHECKLIST_EVENT,
  readNewcomerChecklist,
  setNewcomerChecklistDismissed,
  type NewcomerChecklistEntry,
} from '../../lib/onboarding-checklist'
import { Icon } from '../ui/Icon'

export function NewcomerChecklist({
  accountId,
  communityId,
  communityName,
  accountSignedIn,
  communityJoined,
  channelOpened,
}: {
  accountId: string
  communityId: string
  communityName: string
  accountSignedIn: boolean
  communityJoined: boolean
  channelOpened: boolean
}) {
  const headingId = useId()
  const hideButtonRef = useRef<HTMLButtonElement>(null)
  const showButtonRef = useRef<HTMLButtonElement>(null)
  const [focusAfterToggle, setFocusAfterToggle] = useState<'hide' | 'show' | null>(null)
  const [entry, setEntry] = useState<NewcomerChecklistEntry | null>(() => (
    readNewcomerChecklist(accountId, communityId)
  ))

  useEffect(() => {
    const refresh = () => setEntry(readNewcomerChecklist(accountId, communityId))
    refresh()
    window.addEventListener(NEWCOMER_CHECKLIST_EVENT, refresh)
    return () => window.removeEventListener(NEWCOMER_CHECKLIST_EVENT, refresh)
  }, [accountId, communityId])

  const steps = useMemo(() => deriveNewcomerChecklistSteps({
    accountSignedIn,
    invitationResolved: entry !== null,
    communityJoined,
    channelOpened,
    draftOpened: entry?.draftOpenedAt !== null && entry?.draftOpenedAt !== undefined,
  }), [accountSignedIn, channelOpened, communityJoined, entry])

  useEffect(() => {
    if (focusAfterToggle === 'hide') hideButtonRef.current?.focus()
    if (focusAfterToggle === 'show') showButtonRef.current?.focus()
  }, [entry?.dismissed, focusAfterToggle])

  if (!entry) return null

  const completed = steps.filter((step) => step.complete).length
  const updateDismissed = (dismissed: boolean) => {
    const updated = setNewcomerChecklistDismissed({
      accountId,
      communityId,
      dismissed,
    })
    if (updated) {
      setFocusAfterToggle(dismissed ? 'show' : 'hide')
      setEntry(updated)
    }
  }

  if (entry.dismissed) {
    return (
      <div className="border-b border-border-subtle px-2 py-2">
        <button
          ref={showButtonRef}
          type="button"
          className="flex min-h-9 w-full items-center justify-between gap-2 rounded-control px-2 text-left text-xs font-semibold text-secondary hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => updateDismissed(false)}
        >
          <span>Show getting started</span>
          <span className="tnum text-muted">{completed}/{steps.length}</span>
        </button>
      </div>
    )
  }

  return (
    <section
      className="border-b border-border-subtle bg-surface-sunken px-3 py-3"
      aria-labelledby={headingId}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-meta font-semibold uppercase tracking-caption text-muted">
            Getting started
          </p>
          <h3 id={headingId} className="truncate text-sm font-semibold text-primary">
            Welcome to {communityName}
          </h3>
        </div>
        <button
          ref={hideButtonRef}
          type="button"
          className="flex min-h-9 min-w-9 flex-shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          aria-label="Hide getting started"
          onClick={() => updateDismissed(true)}
        >
          <Icon name="x" size="xs" />
        </button>
      </div>

      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-active"
        role="progressbar"
        aria-label="Getting started progress"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={completed}
        aria-valuetext={`${completed} of ${steps.length} steps complete`}
      >
        <span
          className="block h-full rounded-full bg-accent transition-[width] duration-fast motion-reduce:transition-none"
          data-design-token-exception="bounded-checklist-progress-width"
          style={{ width: `${(completed / steps.length) * 100}%` }}
        />
      </div>

      <ol className="mt-2 space-y-1" aria-live="polite">
        {steps.map((step) => (
          <li
            key={step.id}
            className={`flex min-h-6 items-center gap-2 text-xs ${
              step.complete ? 'text-secondary' : 'text-muted'
            }`}
          >
            <span
              className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border ${
                step.complete
                  ? 'border-accent bg-accent text-accent-content'
                  : 'border-border-emphasis bg-surface-base'
              }`}
              aria-hidden="true"
            >
              {step.complete ? <Icon name="check" size="xs" /> : null}
            </span>
            <span className={step.complete ? 'line-through decoration-border-emphasis' : undefined}>
              {step.label}
            </span>
            <span className="sr-only">{step.complete ? ' complete' : ' not complete'}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
