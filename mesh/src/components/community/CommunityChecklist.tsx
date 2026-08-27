import { useEffect, useRef, useState } from 'react'

import type { OnboardingChecklistStep, OnboardingStepId } from '../../lib/onboarding-checklist'
import { completedStepCount } from '../../lib/onboarding-checklist'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'

/**
 * How long the finished list stays on screen before it leaves.
 *
 * Matches the design language's one-shot highlight role. The list does not
 * simply disappear the instant the last step completes: a person who just did
 * something deserves to see that it counted. Nothing is hidden behind this
 * delay, and reduced motion keeps it, because it is a message rather than
 * movement.
 */
export const CHECKLIST_FAREWELL_MS = 2_000

export interface CommunityChecklistProps {
  steps: readonly OnboardingChecklistStep[]
  collapsed: boolean
  onToggleCollapsed: (collapsed: boolean) => void
  onDismiss: () => void
  onStepAction: (stepId: OnboardingStepId) => void
}

/**
 * The newcomer checklist, as it appears above a community's room list.
 *
 * Presentation only: every step's state arrives already derived, so this
 * component never reads a store and never decides what counts as done. It sits
 * outside the room list's scroll container on purpose. That list is virtualized
 * and measures its own rows, so a section inserted inside it would be measured
 * as a room.
 */
export function CommunityChecklist({
  steps,
  collapsed,
  onToggleCollapsed,
  onDismiss,
  onStepAction,
}: CommunityChecklistProps) {
  const total = steps.length
  const done = completedStepCount(steps)
  const finished = done === total && total > 0
  /*
   * Held only for a list that was on screen when its last step completed. An
   * account that arrives with everything already done never renders this
   * component at all, so it cannot flash a congratulation at somebody who did
   * nothing.
   */
  const [farewell, setFarewell] = useState(false)
  const wasUnfinished = useRef(!finished)

  useEffect(() => {
    if (!finished) {
      wasUnfinished.current = true
      return
    }
    if (!wasUnfinished.current) return
    wasUnfinished.current = false
    setFarewell(true)
    const timer = window.setTimeout(() => setFarewell(false), CHECKLIST_FAREWELL_MS)
    return () => window.clearTimeout(timer)
  }, [finished])

  if (finished) {
    if (!farewell) return null
    return (
      <section
        className="mesh-community-checklist flex min-h-10 items-center gap-2 border-b border-outline-variant px-3 py-2"
        aria-label="Getting started"
      >
        <span
          className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-primary-container text-on-primary-container"
          aria-hidden="true"
        >
          <Icon name="check" size="xs" />
        </span>
        <p role="status" className="min-w-0 flex-1 text-body-sm font-medium text-on-surface">
          All set.
        </p>
      </section>
    )
  }

  return (
    <section
      className="mesh-community-checklist border-b border-outline-variant px-3 py-2"
      aria-labelledby="community-checklist-heading"
    >
      <div className="flex min-h-8 items-center gap-1">
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls="community-checklist-steps"
            onClick={() => onToggleCollapsed(!collapsed)}
            className="flex min-h-8 w-full items-center gap-1.5 rounded-full px-1 text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant transition-[color] duration-fast hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span
              aria-hidden="true"
              className="mesh-disclosure-mark"
              data-collapsed={collapsed ? 'true' : 'false'}
            />
            <span id="community-checklist-heading" className="min-w-0 truncate">
              Settling in
            </span>
            {/*
              A sidebar this narrow truncated the heading itself when the count
              spelled out "3 of 5". The compact form is for the eye only: a
              reader that says "three slash five" gets the spoken version below.
            */}
            <span
              aria-hidden="true"
              className="ml-auto flex-none text-body-sm font-normal normal-case tracking-normal text-on-surface-variant"
            >
              {done}/{total}
            </span>
            <span className="sr-only">{done} of {total} done</span>
          </button>
        </h3>
        <IconButton
          size="sm"
          aria-label="Hide the settling in list"
          onClick={onDismiss}
        >
          <Icon name="x" size="xs" />
        </IconButton>
      </div>

      {!collapsed && (
        <ol id="community-checklist-steps" className="mt-1 space-y-0.5">
          {steps.map((step) => (
            <li
              key={step.id}
              className={`flex items-start gap-2 rounded-full py-1 pr-1 ${
                step.next
                  ? 'border-l-2 border-l-primary bg-surface-container-high pl-1.5'
                  : 'border-l-2 border-l-transparent pl-1.5'
              }`}
            >
              <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center" aria-hidden="true">
                {step.complete ? (
                  /*
                    A bare glyph rather than a filled chip. Three filled marks
                    outweighed the one suggested step, and the suggested step is
                    the thing this section exists to point at. The check carries
                    the state without colour on its own, so the colour here is
                    reinforcement rather than the message.
                  */
                  <span className="flex h-4 w-4 items-center justify-center text-primary motion-safe:transition-opacity motion-safe:duration-instant">
                    <Icon name="check" size="xs" />
                  </span>
                ) : (
                  <span
                    className={`h-3 w-3 rounded-full border ${
                      /*
                        The row already carries an accent rule and a raised
                        tint. Tinting the box as well made one suggested step
                        into three amber marks.
                      */
                      'border-outline'
                    }`}
                  />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-body-sm ${
                    step.complete ? 'text-on-surface-variant' : 'font-medium text-on-surface'
                  }`}
                >
                  {step.label}
                </span>
                <span className="sr-only">
                  {step.complete ? 'Done' : step.next ? 'Next step' : 'Not done yet'}
                </span>
                {step.hint && (
                  <span className="mt-0.5 block text-body-sm text-on-surface-variant">{step.hint}</span>
                )}
                {step.action && (
                  <button
                    type="button"
                    onClick={() => onStepAction(step.id)}
                    className="mt-1 inline-flex min-h-8 items-center gap-1 rounded-full px-1 text-body-sm font-semibold text-primary transition-[background-color] duration-fast hover:bg-primary-container-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    {step.action}
                    <Icon name="arrowRight" size="xs" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
