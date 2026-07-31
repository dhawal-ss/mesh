import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingFlow } from './OnboardingFlow'

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

vi.mock('./BackupCodeScreen', () => ({
  BackupCodeScreen: ({
    backupCode,
    onContinue,
    onSkip,
  }: {
    backupCode: string
    onContinue: () => void
    onSkip: () => void
  }) => (
    <div>
      <p>Backup: {backupCode}</p>
      <button type="button" onClick={onContinue}>
        Confirm backup
      </button>
      <button type="button" onClick={onSkip}>
        Skip backup
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

  it('introduces Mesh trust cues and exposes the current setup step', async () => {
    await act(async () => {
      root.render(<OnboardingFlow backendKind="matrix" onComplete={() => {}} />)
    })

    expect(container.querySelector('[aria-label="Set up Mesh"]')).not.toBeNull()
    expect(container.textContent).toContain('Conversations that stay yours.')
    expect(container.textContent).toContain('Protected from the first message')

    const progress = container.querySelector<HTMLOListElement>('ol[aria-label="Setup progress"]')
    expect(progress).not.toBeNull()
    expect(progress?.querySelector('[aria-current="step"]')?.textContent).toContain('Account')
    expect(progress?.textContent).toContain('Ready')
  })

  it('requires the backup-code step after registration, but only enables recovery on consent', async () => {
    const createBackupCode = vi.fn().mockResolvedValue({
      recoveryKey: 'MESH-ONE-TWO-THREE-FOUR',
      secureStorageState: 'saved',
      verificationState: 'verified',
    })
    const configured = vi.fn()
    await act(async () => {
      root.render(
        <OnboardingFlow
          backendKind="matrix"
          onComplete={() => {}}
          onCreateBackupCode={createBackupCode}
          onBackupConfigured={configured}
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

    /*
     * Creating the code enables cross-signing recovery on the account. Doing
     * that as a side effect of navigation meant a user who then declined ended
     * up with recovery on and a key they had never seen. Reaching the step must
     * not enable anything.
     */
    expect(createBackupCode).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Set up message recovery')
    expect(container.textContent).not.toContain('Ready step')

    const consent = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Set up recovery',
    )
    await act(async () => {
      consent?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 350))
    })

    expect(createBackupCode).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Backup: MESH-ONE-TWO-THREE-FOUR')

    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Confirm backup',
    )
    await act(async () => {
      confirm?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 350))
    })
    expect(configured).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Ready step')
  })

  it('never enables recovery when the user declines at the consent step', async () => {
    const createBackupCode = vi.fn().mockResolvedValue({
      recoveryKey: 'MESH-ONE-TWO-THREE-FOUR',
      secureStorageState: 'saved',
      verificationState: 'verified',
    })
    const skipped = vi.fn()
    await act(async () => {
      root.render(
        <OnboardingFlow
          backendKind="matrix"
          onComplete={() => {}}
          onCreateBackupCode={createBackupCode}
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

    const decline = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('Not now'),
    )
    await act(async () => {
      decline?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 350))
    })

    expect(createBackupCode).not.toHaveBeenCalled()
    expect(skipped).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Ready step')
  })

  it('does not create a new backup code for an existing-account sign-in', async () => {
    const createBackupCode = vi.fn()
    await act(async () => {
      root.render(
        <OnboardingFlow
          backendKind="matrix"
          onComplete={() => {}}
          onCreateBackupCode={createBackupCode}
        />,
      )
    })

    const signedIn = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Signed in',
    )
    await act(async () => {
      signedIn?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 350))
    })

    expect(createBackupCode).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Ready step')
  })
})
