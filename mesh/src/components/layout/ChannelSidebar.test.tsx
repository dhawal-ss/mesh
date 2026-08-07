import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../community/ChannelItem', () => ({
  ChannelItem: ({
    channel,
    active,
    tabIndex,
    onFocus,
  }: {
    channel: { id: string; name: string; channelType: string }
    active: boolean
    tabIndex: number
    onFocus: () => void
  }) => (
    <button
      type="button"
      data-room-id={channel.id}
      aria-current={active ? 'page' : undefined}
      tabIndex={tabIndex}
      onFocus={onFocus}
      aria-label={`${channel.channelType} room: ${channel.name}`}
    >
      {channel.name}
    </button>
  ),
}))

vi.mock('./UserPanel', () => ({
  UserPanel: () => <div>User controls</div>,
}))

vi.mock('../../hooks/useMatrixRtcMembershipSync', () => ({
  useMatrixRtcMembershipSync: () => undefined,
}))

import * as bridge from '../../lib/bridge'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useNetworkStore } from '../../store/network'
import type { Channel } from '../../types/ipc'
import { ChannelSidebar } from './ChannelSidebar'

function room(index: number): Channel {
  return {
    id: `room-${index}`,
    communityId: 'community-1',
    name: `Room ${index}`,
    channelType: 'text',
    unreadCount: 0,
  }
}

describe('ChannelSidebar room containment', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    useCommunityStore.getState().setCommunities([{
      id: 'community-1',
      name: 'Large community',
      description: '',
      memberCount: 5_000,
      role: 'owner',
      joinedAt: '2026-07-29T12:00:00.000Z',
    }])
    useIdentityStore.setState({
      identity: {
        publicKey: '@me:example.org',
        displayName: 'Me',
        avatarColor: '#3ba55d',
      },
      isLoading: false,
    })
    useNetworkStore.setState({
      status: {
        state: 'connected',
        peerCount: 1,
        averageLatency: 1,
      },
    })
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getBackendStatusSnapshot').mockReturnValue(null)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue(null)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.querySelectorAll('[data-radix-portal]').forEach((portal) => portal.remove())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps a 5,000-room community within a bounded ordered DOM', async () => {
    useChannelStore.getState().setChannels(
      Array.from({ length: 5_000 }, (_, index) => room(index)),
    )

    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    // The virtualized room navigation is now one keyboard stop with roving room buttons.
    const list = container.querySelector('[role="navigation"][aria-label="Community rooms"]')
    expect(list).not.toBeNull()
    expect(list?.querySelectorAll('button[data-room-id]').length).toBeGreaterThan(0)
    expect(list?.querySelectorAll('button[data-room-id]').length).toBeLessThan(100)
    expect(list?.querySelector('button[aria-label="text room: Room 0"]')).not.toBeNull()
    expect(list?.querySelector('h3')?.textContent).toContain('Rooms')

    await act(async () => {
      if (list instanceof HTMLElement) list.scrollTop = 180_032
      list?.dispatchEvent(new Event('scroll', { bubbles: true }))
      await Promise.resolve()
    })
    const finalRoom = list?.querySelector<HTMLButtonElement>(
      'button[aria-label="text room: Room 4999"]',
    )
    expect(finalRoom).not.toBeNull()
    finalRoom?.focus()
    expect(document.activeElement).toBe(finalRoom)
  })

  it('never presents the account service as community metadata', async () => {
    useCommunityStore.getState().setCommunities([{
      id: '!canyon:community.example',
      name: 'Canyon Crew',
      description: '',
      memberCount: 42,
      role: 'owner',
      joinedAt: '2026-07-29T12:00:00.000Z',
    }])
    useChannelStore.getState().setChannels([{
      ...room(1),
      id: '!lobby:community.example',
      communityId: '!canyon:community.example',
      name: 'Lobby',
    }])
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    vi.mocked(bridge.getMatrixUserId).mockReturnValue('@me:accounts.example')
    vi.mocked(bridge.getBackendStatusSnapshot).mockReturnValue({
      authenticated: true,
      userId: '@me:accounts.example',
      homeserver: 'https://accounts.example',
    } as bridge.BackendStatus)

    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    const header = container.querySelector('.mesh-community-header')
    expect(header?.textContent).toContain('Canyon Crew')
    expect(header?.textContent).toContain('42 members')
    expect(header?.textContent).not.toContain('accounts.example')
    expect(header?.textContent).not.toContain('community.example')
  })

  it('uses roving focus, arrow keys, Home/End, and type-ahead', async () => {
    useChannelStore.getState().setChannels([
      { ...room(1), name: 'Alpha' },
      { ...room(2), name: 'Beta' },
      { ...room(3), name: 'Gamma' },
    ])
    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    const options = [...container.querySelectorAll<HTMLButtonElement>('button[data-room-id]')]
    expect(options.filter((option) => option.tabIndex === 0)).toHaveLength(1)
    options[0]?.focus()
    await act(async () => {
      options[0]?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(document.activeElement?.textContent).toBe('Beta')
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'End',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(document.activeElement?.textContent).toBe('Gamma')
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(document.activeElement?.textContent).toBe('Alpha')
  })

  it('opens invitation options before creating or copying a link', async () => {
    useChannelStore.getState().setChannels([{ ...room(1), name: 'Welcome' }])
    const generateInviteLink = vi.spyOn(bridge, 'generateInviteLink')

    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    const inviteButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Invite')
    expect(inviteButton).toBeDefined()

    await act(async () => {
      inviteButton?.click()
      await vi.dynamicImportSettled()
    })

    expect(generateInviteLink).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Invite to Large community')
    expect(document.body.textContent).toContain('Share a private invitation')
    expect(document.body.textContent).toContain('Create invite link')
  })
})
