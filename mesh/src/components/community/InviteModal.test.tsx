import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InviteModal } from './InviteModal'

const bridgeMocks = vi.hoisted(() => ({
  matrixMode: false,
  generateInviteLink: vi.fn(),
  inviteMatrixUser: vi.fn(),
}))

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
      'They enter automatically after signing in.',
    )
    expect(document.body.textContent).toContain('Already on Mesh')
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
