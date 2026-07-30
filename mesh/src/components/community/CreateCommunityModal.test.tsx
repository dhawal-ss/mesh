import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateCommunityModal } from './CreateCommunityModal'

const bridgeMocks = vi.hoisted(() => ({
  createCommunity: vi.fn(),
  createChannel: vi.fn(),
  getChannels: vi.fn(),
  storePendingInvitation: vi.fn(),
  joinOrRequestCommunity: vi.fn(),
}))

vi.mock('../../lib/bridge', () => ({
  isMatrixBackend: () => true,
  createCommunity: bridgeMocks.createCommunity,
  createChannel: bridgeMocks.createChannel,
  getChannels: bridgeMocks.getChannels,
  storePendingInvitation: bridgeMocks.storePendingInvitation,
  joinOrRequestCommunity: bridgeMocks.joinOrRequestCommunity,
  searchCommunityDirectory: vi.fn(),
  requestCommunityAccess: vi.fn(),
}))

describe('CreateCommunityModal', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    bridgeMocks.createCommunity.mockReset().mockResolvedValue({
      id: '!server:example.org',
      name: '🎮 Design Club',
      description: '',
      memberCount: 1,
      role: 'owner',
      joinedAt: null,
    })
    bridgeMocks.createChannel.mockReset().mockImplementation(
      (_communityId: string, name: string) => Promise.resolve({
        id: `!${name}:example.org`,
        communityId: '!server:example.org',
        name,
        channelType: 'text',
        unreadCount: 0,
      }),
    )
    bridgeMocks.getChannels.mockReset().mockResolvedValue([])
    bridgeMocks.storePendingInvitation.mockReset().mockResolvedValue({
      handle: 'pending-1',
      roomOrAlias: '!server:example.org',
      via: ['example.org'],
      service: null,
      admissionService: null,
      storedAt: 1_752_000_000_000,
      expiresAt: 1_754_592_000_000,
    })
    bridgeMocks.joinOrRequestCommunity.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.querySelectorAll('[data-radix-portal]').forEach((portal) => portal.remove())
  })

  it('creates from a two-step icon and template flow', async () => {
    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })

    expect(
      document.body.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby'),
    ).toBeTruthy()
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      'Create a community',
    )

    const nameInput = document.body.querySelector<HTMLInputElement>('input[placeholder="e.g. Design Club"]')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
      Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent === '🎮')
        ?.click()
    })

    const next = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Next')
    await act(async () => next?.click())
    expect(document.body.textContent).toContain('Choose a starting layout')

    const gaming = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Gaming'))
    await act(async () => gaming?.click())

    const create = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Create Community')
    await act(async () => {
      create?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridgeMocks.createCommunity).toHaveBeenCalledWith('🎮 Design Club', '')
    expect(bridgeMocks.createChannel).toHaveBeenCalledWith('!server:example.org', 'squad-up', 'text')
    expect(bridgeMocks.createChannel).toHaveBeenCalledWith('!server:example.org', 'clips', 'text')
  })

  it('keeps the dialog open and exposes a retryable error when creation fails', async () => {
    bridgeMocks.createCommunity.mockRejectedValueOnce(new Error('Homeserver unavailable'))

    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })

    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Design Club"]',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const next = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Next')
    await act(async () => next?.click())

    const create = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Create Community')
    await act(async () => {
      create?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('stores a Matrix invitation for review instead of joining immediately', async () => {
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <CreateCommunityModal
          isOpen
          onClose={onClose}
          initialTab="join"
          initialInvite="mesh://join?v=3&kind=matrix&room=!server:example.org&via=example.org"
        />,
      )
    })
    const join = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Join Community')
    await act(async () => {
      join?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridgeMocks.storePendingInvitation).toHaveBeenCalledWith(
      'mesh://join?v=3&kind=matrix&room=!server:example.org&via=example.org',
    )
    expect(bridgeMocks.joinOrRequestCommunity).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
