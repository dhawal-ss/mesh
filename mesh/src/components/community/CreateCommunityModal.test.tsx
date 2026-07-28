import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateCommunityModal } from './CreateCommunityModal'

const bridgeMocks = vi.hoisted(() => ({
  createCommunity: vi.fn(),
  createChannel: vi.fn(),
  getChannels: vi.fn(),
}))

vi.mock('../../lib/bridge', () => ({
  isMatrixBackend: () => true,
  createCommunity: bridgeMocks.createCommunity,
  createChannel: bridgeMocks.createChannel,
  getChannels: bridgeMocks.getChannels,
  joinCommunity: vi.fn(),
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
})
