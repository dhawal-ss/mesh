import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel } from '../types/ipc'
import { useChannelStore } from './channels'

function room(id: string, communityId: string): Channel {
  return { id, communityId, name: id, channelType: 'text', unreadCount: 0 }
}

describe('per-community room settlement', () => {
  beforeEach(() => {
    useChannelStore.setState({
      channelEntities: {},
      channelOrder: [],
      channels: [],
      activeChannelId: null,
      refreshByCommunity: {},
      refreshRequests: {},
    })
  })

  it('replaces only the successful community and preserves another community last-good rooms', () => {
    const alpha = room('alpha-old', 'alpha')
    const beta = room('beta-last-good', 'beta')
    useChannelStore.getState().setChannels([alpha, beta])
    useChannelStore.getState().setActiveChannel(beta.id)

    const refreshedAlpha = room('alpha-new', 'alpha')
    useChannelStore.getState().replaceCommunityChannels('alpha', [refreshedAlpha])

    expect(useChannelStore.getState().channels).toEqual([beta, refreshedAlpha])
    expect(useChannelStore.getState().activeChannelId).toBe(beta.id)
  })

  it('tracks retry requests without destroying stale navigation state', () => {
    const beta = room('beta-last-good', 'beta')
    useChannelStore.getState().setChannels([beta])
    useChannelStore.getState().setCommunityRefresh('beta', {
      status: 'stale',
      error: new Error('timeout'),
      generation: 3,
    })
    useChannelStore.getState().requestCommunityRefresh('beta')

    expect(useChannelStore.getState().channels).toEqual([beta])
    expect(useChannelStore.getState().refreshRequests.beta).toBe(1)
  })
})
