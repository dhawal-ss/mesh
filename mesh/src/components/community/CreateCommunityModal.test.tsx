import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateCommunityModal } from './CreateCommunityModal'

const bridgeMocks = vi.hoisted(() => ({
  createCommunity: vi.fn(),
  createChannel: vi.fn(),
  getChannels: vi.fn(),
  updateCommunityAccess: vi.fn(),
  joinOrRequestCommunity: vi.fn(),
}))

vi.mock('../../lib/bridge', () => ({
  isMatrixBackend: () => true,
  createCommunity: bridgeMocks.createCommunity,
  createChannel: bridgeMocks.createChannel,
  getChannels: bridgeMocks.getChannels,
  updateCommunityAccess: bridgeMocks.updateCommunityAccess,
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
      name: 'Design Club',
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
    bridgeMocks.updateCommunityAccess.mockReset().mockResolvedValue({
      alias: null,
      discoverable: false,
      joinRule: 'invite',
    })
    bridgeMocks.joinOrRequestCommunity.mockReset().mockResolvedValue({
      status: 'joined',
      community: {
        id: '!server:example.org',
        name: 'Design Club',
        description: '',
        memberCount: 2,
        role: 'member',
        joinedAt: null,
      },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.querySelectorAll('[data-radix-portal]').forEach((portal) => portal.remove())
  })

  it('creates from a two-step identity, access, and gaming starter-room flow', async () => {
    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })

    expect(
      document.body.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby'),
    ).toBeTruthy()
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      'Create a community',
    )

    const nameInput = document.body.querySelector<HTMLInputElement>('input[placeholder="e.g. Canyon Raiders"]')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const next = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Next')
    await act(async () => next?.click())
    expect(document.body.textContent).toContain('Access and starter rooms')
    expect(document.body.textContent).toContain('#clips-and-builds')

    const create = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Create community')
    await act(async () => {
      create?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridgeMocks.createCommunity).toHaveBeenCalledWith('Design Club', '')
    expect(bridgeMocks.updateCommunityAccess).toHaveBeenCalledWith('!server:example.org', '', false)
    expect(bridgeMocks.createChannel).toHaveBeenCalledWith('!server:example.org', 'general', 'text')
    expect(bridgeMocks.createChannel).toHaveBeenCalledWith('!server:example.org', 'clips-and-builds', 'text')
    expect(bridgeMocks.createChannel).toHaveBeenCalledWith('!server:example.org', 'playtest-notes', 'text')
  })

  it('renders Browse as a route surface and requires an explicit advanced directory', async () => {
    await act(async () => {
      root.render(
        <CreateCommunityModal
          embedded
          isOpen
          activeTab="discover"
          onClose={() => {}}
        />,
      )
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).toContain('Browsing is not available yet')
    expect(document.body.textContent).toContain('Use another directory')
    expect(document.body.textContent).not.toContain('Leave blank to search Mesh')
  })

  it('keeps the dialog open and exposes a retryable error when creation fails', async () => {
    bridgeMocks.createCommunity.mockRejectedValueOnce(new Error('Homeserver unavailable'))

    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })

    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Canyon Raiders"]',
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
      .find((button) => button.textContent === 'Create community')
    await act(async () => {
      create?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('finishes a partial community idempotently without duplicating completed rooms', async () => {
    const rooms: Array<{
      id: string
      communityId: string
      name: string
      channelType: 'text'
      unreadCount: number
    }> = []
    let clipsAttempt = 0
    bridgeMocks.getChannels.mockImplementation(async () => [...rooms])
    bridgeMocks.createChannel.mockImplementation(async (
      communityId: string,
      name: string,
    ) => {
      if (name === 'clips-and-builds' && clipsAttempt++ === 0) {
        throw new Error('room service unavailable')
      }
      const created = {
        id: `!${name}:example.org`,
        communityId,
        name,
        channelType: 'text' as const,
        unreadCount: 0,
      }
      rooms.push(created)
      return created
    })

    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Canyon Raiders"]',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Next')
        ?.click()
    })
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Create community')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain('Community created. Some rooms still need attention.')
    expect(bridgeMocks.createCommunity).toHaveBeenCalledTimes(1)
    expect(bridgeMocks.createChannel).toHaveBeenCalledWith(
      '!server:example.org',
      'general',
      'text',
    )

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Finish setup')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(bridgeMocks.createCommunity).toHaveBeenCalledTimes(1)
    expect(bridgeMocks.createChannel.mock.calls.filter((call) => call[1] === 'general')).toHaveLength(1)
    expect(bridgeMocks.createChannel.mock.calls.filter((call) => call[1] === 'clips-and-builds')).toHaveLength(2)
    expect(rooms.map((room) => room.name).sort()).toEqual(['clips-and-builds', 'general', 'playtest-notes'])
  })

  it('does not treat Enter inside the description textarea as Next', async () => {
    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Canyon Raiders"]',
    )
    const description = document.body.querySelector<HTMLTextAreaElement>(
      '#create-community-description',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
      description?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(document.body.textContent).toContain('Name and identity')
    expect(document.body.textContent).not.toContain('Access and starter rooms')
  })

  it('retries refresh after creation without recreating the community or starter rooms', async () => {
    const rooms: Array<{
      id: string
      communityId: string
      name: string
      channelType: 'text'
      unreadCount: number
    }> = []
    let listAttempt = 0
    bridgeMocks.getChannels.mockImplementation(async () => {
      listAttempt += 1
      if (listAttempt === 2) throw new Error('refresh timed out')
      return [...rooms]
    })
    bridgeMocks.createChannel.mockImplementation(async (communityId: string, name: string) => {
      const created = {
        id: `!${name}:example.org`,
        communityId,
        name,
        channelType: 'text' as const,
        unreadCount: 0,
      }
      rooms.push(created)
      return created
    })

    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Canyon Raiders"]',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Next')
        ?.click()
    })
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Create community')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('Finish setup')

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Finish setup')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(bridgeMocks.createCommunity).toHaveBeenCalledTimes(1)
    expect(bridgeMocks.createChannel).toHaveBeenCalledTimes(3)
  })

  it('reviews a standard Matrix community invitation before joining', async () => {
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
    const review = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Review invitation')
    await act(async () => review?.click())
    expect(bridgeMocks.joinOrRequestCommunity).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Destination ready to review')
    const join = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Continue with current account')
    await act(async () => {
      join?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridgeMocks.joinOrRequestCommunity).toHaveBeenCalledWith(
      'mesh://join?v=3&kind=matrix&room=!server:example.org&via=example.org',
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps invalid invitation input editable and never attempts a join', async () => {
    await act(async () => {
      root.render(
        <CreateCommunityModal
          embedded
          isOpen
          activeTab="join"
          initialInvite="not an invitation"
          onClose={() => {}}
        />,
      )
    })
    const review = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Review invitation')
    await act(async () => review?.click())

    expect(document.body.querySelector<HTMLInputElement>('input')?.value).toBe('not an invitation')
    expect(document.body.textContent).toContain('Check the invitation link or code')
    expect(bridgeMocks.joinOrRequestCommunity).not.toHaveBeenCalled()
  })
})
