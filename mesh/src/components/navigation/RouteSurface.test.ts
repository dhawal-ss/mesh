import { describe, expect, it } from 'vitest'
import type { MeshRecentDestination } from '../../lib/mesh-navigation'
import type { Channel } from '../../types/ipc'
import {
  communityDeskTextRooms,
  recentCommunityTextRooms,
  starterCommunityTextRooms,
} from './RouteSurface'

const channels: Channel[] = [
  { id: 'general', communityId: 'crew', name: 'general', topic: '', channelType: 'text', unreadCount: 20, joined: true },
  { id: 'art', communityId: 'crew', name: 'concept-art', topic: '', channelType: 'text', unreadCount: 0, joined: true },
  { id: 'voice', communityId: 'crew', name: 'Lobby', topic: '', channelType: 'voice', unreadCount: 0, joined: true },
  { id: 'welcome', communityId: 'crew', name: 'welcome', topic: '', channelType: 'text', unreadCount: 0, joined: true },
  { id: 'screenshots', communityId: 'crew', name: 'screenshots', topic: '', channelType: 'text', unreadCount: 0, joined: true },
  { id: 'other', communityId: 'other-crew', name: 'general', topic: '', channelType: 'text', unreadCount: 1, joined: true },
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

  it('keeps recent rooms first and fills the desk with other useful rooms', () => {
    const recents: MeshRecentDestination[] = [
      { route: { kind: 'room', communityId: 'crew', roomId: 'art' }, lastOpenedAt: 20 },
    ]

    expect(communityDeskTextRooms(channels, recents, 'crew', 4).map((room) => room.id))
      .toEqual(['art', 'general', 'welcome', 'screenshots'])
  })

  it('keeps a room that is waiting from being truncated away by read rooms', () => {
    // Server order puts the unread room last, and the cap would drop it, which
    // removes the one room the desk existed to point at.
    const serverOrder: Channel[] = [
      { id: 'welcome', communityId: 'crew', name: 'welcome', topic: '', channelType: 'text', unreadCount: 0, joined: true },
      { id: 'lobby', communityId: 'crew', name: 'lobby', topic: '', channelType: 'text', unreadCount: 0, joined: true },
      { id: 'busy', communityId: 'crew', name: 'busy', topic: '', channelType: 'text', unreadCount: 4, joined: true },
    ]

    expect(communityDeskTextRooms(serverOrder, [], 'crew', 2).map((room) => room.id))
      .toEqual(['busy', 'welcome'])
  })

  it('still refuses to reorder recents on unread volume', () => {
    const recents: MeshRecentDestination[] = [
      { route: { kind: 'room', communityId: 'crew', roomId: 'art' }, lastOpenedAt: 20 },
      { route: { kind: 'room', communityId: 'crew', roomId: 'general' }, lastOpenedAt: 10 },
    ]

    // `art` was opened more recently; `general` holds 20 unread and stays put.
    expect(communityDeskTextRooms(channels, recents, 'crew', 2).map((room) => room.id))
      .toEqual(['art', 'general'])
  })

  it('lets a mention jump the recency queue', () => {
    const mentioned: Channel[] = [
      { id: 'art', communityId: 'crew', name: 'concept-art', topic: '', channelType: 'text', unreadCount: 0, joined: true },
      { id: 'general', communityId: 'crew', name: 'general', topic: '', channelType: 'text', unreadCount: 2, unreadMentions: 1, joined: true },
    ]
    const recents: MeshRecentDestination[] = [
      { route: { kind: 'room', communityId: 'crew', roomId: 'art' }, lastOpenedAt: 20 },
      { route: { kind: 'room', communityId: 'crew', roomId: 'general' }, lastOpenedAt: 10 },
    ]

    expect(communityDeskTextRooms(mentioned, recents, 'crew', 2).map((room) => room.id))
      .toEqual(['general', 'art'])
  })

  it('never lifts a silenced room, however much it holds', () => {
    const serverOrder: Channel[] = [
      { id: 'welcome', communityId: 'crew', name: 'welcome', topic: '', channelType: 'text', unreadCount: 0, joined: true },
      { id: 'muted', communityId: 'crew', name: 'muted', topic: '', channelType: 'text', unreadCount: 99, unreadMentions: 9, joined: true },
    ]

    expect(
      communityDeskTextRooms(serverOrder, [], 'crew', 2, (room) => room.id === 'muted')
        .map((room) => room.id),
    ).toEqual(['welcome', 'muted'])
  })
})
