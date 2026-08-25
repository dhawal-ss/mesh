import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useRoomOrganizationStore } from '../../store/room-organization'
import { RAIL_ORDER_SCOPE_KEY } from '../../lib/room-organization'
import type { Community } from '../../types/ipc'
import { CommunitySidebar } from './CommunitySidebar'

function community(id: string, name: string): Community {
  return { id, name, description: '', avatarUrl: null, memberCount: 1, role: 'member', joinedAt: null }
}

describe('CommunitySidebar rail organization', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useCommunityStore.setState({
      communities: [community('c1', 'Alpha'), community('c2', 'Beta'), community('c3', 'Gamma')],
      communityEntities: {},
      activeCommunityId: null,
    })
    useChannelStore.getState().setChannels([])
    localStorage.clear()
    useRoomOrganizationStore.getState().resetForAccountTransition()
    useRoomOrganizationStore.getState().initialize('@me:example.org')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.querySelectorAll('[data-radix-portal]').forEach((portal) => portal.remove())
    container.remove()
  })

  const railNames = () => [...container.querySelectorAll<HTMLButtonElement>('[data-mesh-rail-action^="community:"]')]
    .map((button) => button.getAttribute('aria-label')?.split(',')[0])

  it('pins a community to the top of the rail, above server order', async () => {
    await act(async () => {
      root.render(<CommunitySidebar />)
      await Promise.resolve()
    })
    expect(railNames()).toEqual(['Alpha', 'Beta', 'Gamma'])

    useRoomOrganizationStore.getState().pin(RAIL_ORDER_SCOPE_KEY, 'c3')
    await act(async () => {
      await Promise.resolve()
    })
    expect(railNames()).toEqual(['Gamma', 'Alpha', 'Beta'])
  })

  it('moves a community within the rail using the store order', async () => {
    await act(async () => {
      root.render(<CommunitySidebar />)
      await Promise.resolve()
    })

    useRoomOrganizationStore.getState().move(RAIL_ORDER_SCOPE_KEY, 'c1', 1, ['c1', 'c2', 'c3'])
    await act(async () => {
      await Promise.resolve()
    })
    expect(railNames()).toEqual(['Beta', 'Alpha', 'Gamma'])
  })
})
