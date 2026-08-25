import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingFlow } from './OnboardingFlow'
import type { PendingInvitationMetadata } from '../../types/ipc'

vi.mock('./MatrixAccountScreen', () => ({
  MatrixAccountScreen: ({ onNext }: { onNext: (outcome: 'registered' | 'signed-in') => void }) => (
    <div>
      <button type="button" onClick={() => onNext('registered')}>
        Registered
      </button>
      <button type="button" onClick={() => onNext('signed-in')}>
        Signed in
      </button>
    </div>
  ),
}))

vi.mock('./ReadyScreen', () => ({
  ReadyScreen: () => <p>Ready step</p>,
}))

describe('OnboardingFlow account outcomes', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('hands the whole screen to the account question and drops the setup rail', async () => {
    await act(async () => {
      root.render(<OnboardingFlow backendKind="matrix" onComplete={() => {}} />)
    })

    expect(container.querySelector('[aria-label="Set up Mesh"]')).not.toBeNull()

    /*
      The shell used to carry a pitch, three trust cues and a footer aphorism
      beside the one question it was asking. None of it was answerable, and all
      of it was read before the question. What remains is the mark and the step.
    */
    expect(container.textContent).not.toContain('Join your communities. Start talking.')
    expect(container.textContent).not.toContain('Messages stay protected')
    expect(container.textContent).not.toContain('Review signed-in devices')

    /*
      The Matrix path is one question followed by a completion screen, so
      "Step 1 of 2" reported progress through something nobody experienced as a
      journey. The rail is kept for the longer legacy path, which has three.
    */
    expect(container.querySelector('ol[aria-label="Setup progress"]')).toBeNull()
    expect(container.textContent).not.toContain('Step 1 of 2')
  })

  it('moves recovery after engagement and schedules a reminder for a new account', async () => {
    const skipped = vi.fn()
    await act(async () => {
      root.render(
        <OnboardingFlow
          backendKind="matrix"
          onComplete={() => {}}
          onBackupSkipped={skipped}
        />,
      )
    })

    const registered = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Registered',
    )
    await act(async () => {
      registered?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 350))
    })

    expect(skipped).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('Set up message recovery')
    expect(container.textContent).toContain('Ready step')
  })

  it('keeps the invitation destination visible through account handoff and bootstrap', async () => {
    await act(async () => {
      root.render(
        <OnboardingFlow
          backendKind="matrix"
          onComplete={() => {}}
          initialPendingInvitation={pendingInvitation()}
        />,
      )
    })

    expect(container.textContent).toContain('Invitation destination')
    expect(container.textContent).toContain('Lantern Guild')
    expect(container.textContent).not.toContain('playtest notes')

    const registered = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Registered',
    )
    await act(async () => {
      registered?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 350))
    })

    expect(container.textContent).toContain('Invitation destination')
    expect(container.textContent).not.toContain('playtest notes')
    expect(container.textContent).toContain('Ready step')
  })

  it('does not create a new backup code for an existing-account sign-in', async () => {
    await act(async () => {
      root.render(
        <OnboardingFlow backendKind="matrix" onComplete={() => {}} />,
      )
    })

    const signedIn = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Signed in',
    )
    await act(async () => {
      signedIn?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 350))
    })

    expect(container.textContent).toContain('Ready step')
  })
})

function pendingInvitation(): PendingInvitationMetadata {
  return {
    handle: 'pending-onboarding-invitation',
    roomOrAlias: '#playtest-notes:lantern.example',
    via: ['lantern.example'],
    service: 'https://matrix.lantern.example',
    admissionService: null,
    communityName: 'Lantern Guild',
    inviterDisplayName: 'Maya',
    joinRule: 'invite',
    communityServiceDisplayName: 'Lantern Accounts',
    storedAt: 1_786_000_000_000,
    expiresAt: 1_786_086_400_000,
  }
}
