import { describe, expect, it } from 'vitest'
import type { MeshRecentDestination } from '../../lib/mesh-navigation'
import type { Channel } from '../../types/ipc'
import { recentCommunityTextRooms, starterCommunityTextRooms } from './RouteSurface'

const channels: Channel[] = [
  { id: 'general', communityId: 'crew', name: 'general', channelType: 'text', unreadCount: 20 },
  { id: 'art', communityId: 'crew', name: 'concept-art', channelType: 'text', unreadCount: 0 },
  { id: 'voice', communityId: 'crew', name: 'Lobby', channelType: 'voice', unreadCount: 0 },
  { id: 'welcome', communityId: 'crew', name: 'welcome', channelType: 'text', unreadCount: 0 },
  { id: 'screenshots', communityId: 'crew', name: 'screenshots', channelType: 'text', unreadCount: 0 },
  { id: 'other', communityId: 'other-crew', name: 'general', channelType: 'text', unreadCount: 1 },
]

describe('community landing rooms', () => {
  it('uses actual navigation recency instead of unread volume', () => {
    const recents: MeshRecentDestination[] = [
      { route: { kind: 'room', communityId: 'crew', roomId: 'general' }, lastOpenedAt: 10 },
      { route: { kind: 'room', communityId: 'crew', roomId: 'art' }, lastOpenedAt: 20 },
    ]

    expect(recentCommunityTextRooms(channels, recents, 'crew').map((room) => room.id))
      .toEqual(['art', 'general'])
  })

  it('ignores other communities, voice rooms, and stale room ids', () => {
    const recents: MeshRecentDestination[] = [
      { route: { kind: 'room', communityId: 'other-crew', roomId: 'other' }, lastOpenedAt: 40 },
      { route: { kind: 'voice', communityId: 'crew', roomId: 'voice' }, lastOpenedAt: 30 },
      { route: { kind: 'room', communityId: 'crew', roomId: 'missing' }, lastOpenedAt: 20 },
      { route: { kind: 'room', communityId: 'crew', roomId: 'art' }, lastOpenedAt: 10 },
    ]

    expect(recentCommunityTextRooms(channels, recents, 'crew')).toEqual([channels[1]])
  })

  it('offers a small server-ordered starter set before the newcomer has recents', () => {
    expect(starterCommunityTextRooms(channels, 'crew').map((room) => room.id))
      .toEqual(['general', 'art', 'welcome'])
    expect(starterCommunityTextRooms(channels, 'crew', 1).map((room) => room.id))
      .toEqual(['general'])
  })
})
