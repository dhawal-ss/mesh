import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CommunityChecklist, CHECKLIST_FAREWELL_MS } from './CommunityChecklist'
import { deriveOnboardingSteps, type OnboardingChecklistFacts } from '../../lib/onboarding-checklist'

const nothingDone: OnboardingChecklistFacts = {
  signedIn: false,
  joinedCommunity: false,
  openedRoom: false,
  startedMessage: false,
  hasProfilePicture: false,
}

const readyForARoom: OnboardingChecklistFacts = {
  ...nothingDone,
  signedIn: true,
  joinedCommunity: true,
}

function findButton(label: string) {
  return Array.from(document.body.querySelectorAll('button'))
    .find((button) => (button.textContent ?? '').includes(label))
}

describe('CommunityChecklist', () => {
  let container: HTMLDivElement
  let root: Root
  const onToggleCollapsed = vi.fn()
  const onDismiss = vi.fn()
  const onStepAction = vi.fn()

  function render(facts: OnboardingChecklistFacts, collapsed = false) {
    return act(() => {
      root.render(
        <CommunityChecklist
          steps={deriveOnboardingSteps(facts, [])}
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
          onDismiss={onDismiss}
          onStepAction={onStepAction}
        />,
      )
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('counts progress and names each state in text, not only in color', async () => {
    await render(readyForARoom)

    const heading = container.querySelector('button[aria-controls="community-checklist-steps"]')
    expect(heading?.textContent).toContain('Settling in')
    expect(heading?.textContent).toContain('2/5')
    expect(heading?.textContent).toContain('2 of 5 done')
    expect(heading?.getAttribute('aria-expanded')).toBe('true')

    const states = Array.from(container.querySelectorAll('li .sr-only')).map(
      (node) => node.textContent,
    )
    expect(states).toEqual(['Done', 'Done', 'Next step', 'Not done yet', 'Not done yet'])
  })

  it('offers the suggested action and reports which step it belonged to', async () => {
    await render(readyForARoom)

    const action = findButton('Open a room')
    expect(action).toBeTruthy()
    await act(async () => {
      action?.click()
    })
    expect(onStepAction).toHaveBeenCalledWith('room')
  })

  it('marks the disclosure with a triangle that points at what it does', async () => {
    await render(readyForARoom, false)
    const open = container.querySelector('.mesh-disclosure-mark')
    expect(open).not.toBeNull()
    expect(open?.getAttribute('data-collapsed')).toBe('false')

    await render(readyForARoom, true)
    const shut = container.querySelector('.mesh-disclosure-mark')
    expect(shut?.getAttribute('data-collapsed')).toBe('true')
  })

  it('folds the steps away while keeping the count reachable', async () => {
    await render(readyForARoom, true)

    expect(container.querySelector('#community-checklist-steps')).toBeNull()
    const heading = container.querySelector('button[aria-controls="community-checklist-steps"]')
    expect(heading?.getAttribute('aria-expanded')).toBe('false')
    expect(heading?.textContent).toContain('2/5')
    expect(heading?.textContent).toContain('2 of 5 done')

    await act(async () => {
      ;(heading as HTMLButtonElement | null)?.click()
    })
    expect(onToggleCollapsed).toHaveBeenCalledWith(false)
  })

  it('hides on request through a labelled control', async () => {
    await render(readyForARoom)

    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide the settling in list"]',
    )
    expect(dismiss).toBeTruthy()
    await act(async () => {
      dismiss?.click()
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  /*
   * The finished list is the interesting case. It has to acknowledge the last
   * step for somebody who just completed it, and it has to stay away entirely
   * for an established account whose facts were already complete on arrival.
   */
  it('acknowledges the last step, then leaves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await render({ ...readyForARoom, openedRoom: true, startedMessage: true })
    expect(container.textContent).toContain('Pick your look')

    await render({
      ...readyForARoom,
      openedRoom: true,
      startedMessage: true,
      hasProfilePicture: true,
    })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('All set')

    await act(async () => {
      vi.advanceTimersByTime(CHECKLIST_FAREWELL_MS)
    })
    expect(container.innerHTML).toBe('')
  })

  it('never appears for an account that arrives with every step done', async () => {
    await render({
      signedIn: true,
      joinedCommunity: true,
      openedRoom: true,
      startedMessage: true,
      hasProfilePicture: true,
    })
    expect(container.innerHTML).toBe('')
  })
})
