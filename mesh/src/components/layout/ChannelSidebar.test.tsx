import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../community/ChannelItem', () => ({
  ChannelItem: ({ channel }: { channel: { name: string; channelType: string } }) => (
    <button type="button" aria-label={`${channel.channelType} room: ${channel.name}`}>
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

    const list = container.querySelector('[role="list"][aria-label="Community rooms"]')
    expect(list).not.toBeNull()
    expect(list?.querySelectorAll('[role="listitem"]').length).toBeGreaterThan(0)
    expect(list?.querySelectorAll('[role="listitem"]').length).toBeLessThan(100)
    expect(list?.querySelector('button[aria-label="text room: Room 0"]')).not.toBeNull()
    expect(list?.querySelector('[role="heading"]')?.textContent).toContain('Rooms')

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
})
