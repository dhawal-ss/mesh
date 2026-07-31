import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupCodeScreen } from './BackupCodeScreen'

const BACKUP_CODE = 'MESH-7K2P-9QXR-4LMN-8BVC-3TWD'

describe('BackupCodeScreen', () => {
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

  it('shows the supplied code and delegates copy and print actions', async () => {
    const onCopy = vi.fn()
    const onPrint = vi.fn()
    await act(async () => {
      root.render(
        <BackupCodeScreen
          backupCode={BACKUP_CODE}
          challengeIndices={[0, 2, 4]}
          onCopy={onCopy}
          onPrint={onPrint}
          onContinue={() => {}}
          onSkip={() => {}}
        />,
      )
    })

    expect(container.querySelector('output')?.textContent).toBe(BACKUP_CODE)
    await act(async () => findButton('Copy').click())
    await act(async () => findButton('Print').click())

    expect(onCopy).toHaveBeenCalledWith(BACKUP_CODE)
    expect(onPrint).toHaveBeenCalledWith(BACKUP_CODE)
    expect(container.textContent).toContain('does not download an unencrypted backup file')
    expect(container.textContent).not.toContain('Save as file')
  })

  it('requires all three requested parts before continuing', async () => {
    const onContinue = vi.fn()
    await act(async () => {
      root.render(
        <BackupCodeScreen
          backupCode={BACKUP_CODE}
          challengeIndices={[0, 2, 4]}
          onCopy={() => {}}
          onPrint={() => {}}
          onContinue={onContinue}
          onSkip={() => {}}
        />,
      )
    })

    act(() => findButton('I saved it').click())
    expect(container.querySelectorAll('input')).toHaveLength(3)
    act(() => findButton('Continue').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('do not match')
    expect(onContinue).not.toHaveBeenCalled()

    const inputs = [...container.querySelectorAll<HTMLInputElement>('input')]
    act(() => {
      setInputValue(inputs[0], '7k2p')
      setInputValue(inputs[1], '4lmn')
      setInputValue(inputs[2], '3twd')
    })
    act(() => findButton('Continue').click())
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('emits an explicit recurring warning when setup is deferred', () => {
    const onSkip = vi.fn()
    act(() => {
      root.render(
        <BackupCodeScreen
          backupCode={BACKUP_CODE}
          onCopy={() => {}}
          onPrint={() => {}}
          onContinue={() => {}}
          onSkip={onSkip}
        />,
      )
    })

    act(() => findButton('Remind me later').click())
    expect(onSkip).toHaveBeenCalledWith({
      kind: 'backup-code-reminder',
      recurringWarning: true,
    })
  })

  it('reports protected-device storage and SDK-backed verification honestly', () => {
    act(() => {
      root.render(
        <BackupCodeScreen
          backupCode={BACKUP_CODE}
          secureStorageState="unavailable"
          verificationState="failed"
          onCopy={() => {}}
          onPrint={() => {}}
          onContinue={() => {}}
          onSkip={() => {}}
        />,
      )
    })

    expect(container.textContent).toContain('could not save a copy')
    expect(container.textContent).toContain('could not complete the backup check')
    expect(container.textContent).toContain('Keep this screen open')
  })

  it('contains none of the banned storage terminology', () => {
    act(() => {
      root.render(
        <BackupCodeScreen
          backupCode={BACKUP_CODE}
          onCopy={() => {}}
          onPrint={() => {}}
          onContinue={() => {}}
          onSkip={() => {}}
        />,
      )
    })

    const copy = container.textContent?.toLowerCase() ?? ''
    for (const banned of ['recovery key', 'secret storage', 'cross-signing', 'ssss']) {
      expect(copy).not.toContain(banned)
    }
  })

  function findButton(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.textContent?.includes(label),
    )
    if (!button) throw new Error(`Button not found: ${label}`)
    return button
  }
})

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
