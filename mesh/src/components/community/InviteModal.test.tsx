import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InviteModal } from './InviteModal'

const bridgeMocks = vi.hoisted(() => ({
  matrixMode: false,
  generateInviteLink: vi.fn(),
  inviteMatrixUser: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

vi.mock('../../lib/bridge', () => ({
  isMatrixBackend: () => bridgeMocks.matrixMode,
  generateInviteLink: bridgeMocks.generateInviteLink,
  inviteMatrixUser: bridgeMocks.inviteMatrixUser,
}))

describe('InviteModal', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    bridgeMocks.matrixMode = false
    bridgeMocks.generateInviteLink.mockReset()
    bridgeMocks.inviteMatrixUser.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.querySelectorAll('[data-radix-portal]').forEach((portal) => portal.remove())
    vi.useRealTimers()
  })

  it('labels the dialog and never exposes an error string as a copyable invite', async () => {
    bridgeMocks.generateInviteLink.mockRejectedValueOnce(
      new Error('Invite service unavailable'),
    )

    await act(async () => {
      root.render(
        <InviteModal
          isOpen
          onClose={() => {}}
          communityId="community-1"
          communityName="Mesh Test"
        />,
      )
    })
    const dialog = document.body.querySelector('[role="dialog"]')
    const createButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Create invite link'))
    const copyButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Copy Invite Link'))

    expect(dialog?.textContent).toContain('Invite to Mesh Test')
    expect(bridgeMocks.generateInviteLink).not.toHaveBeenCalled()
    expect(createButton).not.toBeNull()

    await act(async () => {
      createButton?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Failed to generate link')
    expect(document.body.textContent).not.toContain("Mesh couldn't invite this person")
    expect(copyButton?.disabled).toBe(true)
  })

  it('makes a private link primary while retaining direct account invites in Matrix mode', async () => {
    bridgeMocks.matrixMode = true
    bridgeMocks.generateInviteLink.mockResolvedValueOnce(
      'https://mesh.test/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789',
    )

    await act(async () => {
      root.render(
        <InviteModal
          isOpen
          onClose={() => {}}
          communityId="!community:mesh.test"
          communityName="Mesh Test"
        />,
      )
    })
    expect(bridgeMocks.generateInviteLink).not.toHaveBeenCalled()
    const createButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Create invite link'))
    expect(createButton).not.toBeNull()

    await act(async () => {
      createButton?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridgeMocks.generateInviteLink).toHaveBeenCalledWith('!community:mesh.test')
    expect(document.body.textContent).toContain('Copy Invite Link')
    expect(document.body.textContent).toContain(
      'They review the destination and choose when to join.',
    )
    expect(document.body.textContent).toContain('Already on Mesh')
  })

  it('does not render a direct-account failure as an invite-link failure', async () => {
    bridgeMocks.matrixMode = true
    bridgeMocks.inviteMatrixUser.mockRejectedValueOnce(new Error('private server detail'))

    await act(async () => {
      root.render(
        <InviteModal
          isOpen
          onClose={() => {}}
          communityId="!community:mesh.test"
          communityName="Mesh Test"
        />,
      )
    })
    const input = document.body.querySelector('input') as HTMLInputElement
    const sendButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Send invite'))

    await act(async () => {
      setInputValue(input, 'maya')
    })
    await act(async () => {
      sendButton?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain("Mesh couldn't invite this person")
    expect(document.body.textContent).not.toContain("Mesh couldn't create an invite link")
    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toContain("Mesh couldn't invite this person. Try again.")
  })

  it('keeps simultaneous link and direct-account outcomes scoped when they settle out of order', async () => {
    bridgeMocks.matrixMode = true
    const link = deferred<string>()
    const directInvite = deferred<void>()
    bridgeMocks.generateInviteLink.mockReturnValueOnce(link.promise)
    bridgeMocks.inviteMatrixUser.mockReturnValueOnce(directInvite.promise)

    await act(async () => {
      root.render(
        <InviteModal
          isOpen
          onClose={() => {}}
          communityId="!community:mesh.test"
          communityName="Mesh Test"
        />,
      )
    })
    const input = document.body.querySelector('input') as HTMLInputElement
    await act(async () => {
      setInputValue(input, 'maya')
    })
    const buttons = () => Array.from(document.body.querySelectorAll('button'))
    await act(async () => {
      buttons().find((button) => button.textContent?.includes('Create invite link'))?.click()
      buttons().find((button) => button.textContent?.includes('Send invite'))?.click()
    })

    await act(async () => {
      directInvite.reject(new Error('direct invite rejected'))
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain("Mesh couldn't invite this person")
    expect(document.body.textContent).not.toContain("Mesh couldn't create an invite link")

    await act(async () => {
      link.resolve('https://mesh.test/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789')
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Copy Invite Link')
    expect(document.body.textContent).toContain("Mesh couldn't invite this person")
  })

  it('invalidates in-flight outcomes when the modal closes', async () => {
    const link = deferred<string>()
    bridgeMocks.generateInviteLink.mockReturnValueOnce(link.promise)

    await act(async () => {
      root.render(
        <InviteModal
          isOpen
          onClose={() => {}}
          communityId="community-1"
          communityName="Mesh Test"
        />,
      )
    })
    const buttons = () => Array.from(document.body.querySelectorAll('button'))
    await act(async () => {
      buttons().find((button) => button.textContent?.includes('Create invite link'))?.click()
      buttons().find((button) => button.getAttribute('aria-label') === 'Close dialog')?.click()
    })
    await act(async () => {
      link.resolve('https://mesh.test/invite/stale-link-that-must-not-render')
      await Promise.resolve()
    })

    expect(document.body.textContent).not.toContain('stale-link-that-must-not-render')
  })

  it('clears the copy reset timer when the modal unmounts', async () => {
    vi.useFakeTimers()
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
    Object.assign(navigator, { clipboard })
    bridgeMocks.generateInviteLink.mockResolvedValueOnce(
      'https://mesh.test/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789',
    )

    await act(async () => {
      root.render(
        <InviteModal
          isOpen
          onClose={() => {}}
          communityId="community-1"
          communityName="Mesh Test"
        />,
      )
    })
    const createButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Create invite link'))
    await act(async () => {
      createButton?.click()
      await Promise.resolve()
    })
    const copyButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Copy Invite Link'))
    await act(async () => {
      copyButton?.click()
      await Promise.resolve()
    })

    act(() => root.unmount())
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })
})
