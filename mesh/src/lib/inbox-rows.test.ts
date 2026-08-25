import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, DmConversation } from '../types/ipc'
import { useSettingsStore } from '../store/settings'
import { useRoomOrganizationStore } from '../store/room-organization'
import {
  resolveInboxRows,
  resolveWaitingDirectRow,
  resolveWaitingRoomRow,
  rowAccessibleName,
} from './inbox-rows'

describe('explicit mark-as-unread rows', () => {
  const notifications = () => useSettingsStore.getState().notifications

  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      notifications: { ...state.notifications, channelNotificationLevels: {} },
    }))
  })

  const communities = {
    crew: {
      id: 'crew',
      name: 'Canyon Crew',
      description: '',
      avatarUrl: null,
      memberCount: 12,
      role: 'member' as const,
    },
  } as unknown as Parameters<typeof resolveWaitingRoomRow>[1]

  const channel = (patch: Partial<Channel> = {}): Channel => ({
    id: '!lobby:example.org',
    communityId: 'crew',
    name: 'lobby',
    topic: '',
    channelType: 'text',
    unreadCount: 0,
    joined: true,
    ...patch,
  })

  const conversation = (patch: Partial<DmConversation> = {}): DmConversation => ({
    id: '!maya:example.org',
    peers: [{ userId: '@maya:example.org', displayName: 'Maya', avatarColor: '#fff' }],
    lastMessageAt: null,
    unreadCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...patch,
  })

  it('surfaces a room carrying only the explicit marker, with no message or mention count', () => {
    const row = resolveWaitingRoomRow(
      channel({ unreadCount: 0, unreadMentions: 0, unreadMarked: true }),
      communities,
      {},
      true,
      notifications(),
    )

    expect(row?.title).toBe('lobby')
    expect(row?.unreadMarked).toBe(true)
  })

  it('surfaces a conversation carrying only the explicit marker', () => {
    const row = resolveWaitingDirectRow(
      conversation({ unreadCount: 0, unreadMentions: 0, unreadMarked: true }),
      {},
      true,
      notifications(),
    )

    expect(row?.title).toBe('Maya')
    expect(row?.unreadMarked).toBe(true)
  })

  it('still drops a silenced room even when explicitly marked unread', () => {
    useSettingsStore.getState().setChannelNotificationLevel('!lobby:example.org', 'nothing')

    expect(resolveWaitingRoomRow(
      channel({ unreadMarked: true }),
      communities,
      {},
      true,
      notifications(),
    )).toBeNull()
  })

  it('never puts a room this account has not joined in front of it', () => {
    /*
      Unjoined rooms reach this function because Inbox reads the channel store
      directly, the same reason P11's hidden rooms do. They carry no unread
      count because there is no membership to count against, so nothing here
      needs to know about them. Locked in rather than left true by accident: an
      unread count invented for an unjoined room would put a room that cannot
      be opened at the top of the one surface that promises everything waiting.
    */
    expect(resolveWaitingRoomRow(
      channel({ joined: false }),
      communities,
      {},
      true,
      notifications(),
    )).toBeNull()
  })

  it('names the explicit marker in the accessible name when no count backs it', () => {
    const row = { title: 'lobby', detail: 'Canyon Crew · New activity', unreadCount: 0, unreadMentions: 0, unreadMarked: true }
    expect(rowAccessibleName(row)).toBe('lobby, Canyon Crew · New activity, marked unread')
  })

  it('lets a real count speak for itself instead of also saying "marked unread"', () => {
    const row = { title: 'lobby', detail: 'Canyon Crew · New activity', unreadCount: 3, unreadMentions: 0, unreadMarked: true }
    expect(rowAccessibleName(row)).toBe('lobby, Canyon Crew · New activity, 3 unread')
  })
})

describe('resolveInboxRows', () => {
  const notifications = () => useSettingsStore.getState().notifications

  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      notifications: { ...state.notifications, channelNotificationLevels: {} },
    }))
  })

  const communities = {
    crew: {
      id: 'crew',
      name: 'Canyon Crew',
      description: '',
      avatarUrl: null,
      memberCount: 12,
      role: 'member' as const,
    },
  } as unknown as Parameters<typeof resolveInboxRows>[1]

  const channel = (patch: Partial<Channel> = {}): Channel => ({
    id: '!lobby:example.org',
    communityId: 'crew',
    name: 'lobby',
    topic: '',
    channelType: 'text',
    unreadCount: 0,
    joined: true,
    ...patch,
  })

  const conversation = (patch: Partial<DmConversation> = {}): DmConversation => ({
    id: '!maya:example.org',
    peers: [{ userId: '@maya:example.org', displayName: 'Maya', avatarColor: '#fff' }],
    lastMessageAt: null,
    unreadCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...patch,
  })

  it('gathers every unread channel and conversation regardless of navigation history', () => {
    const rows = resolveInboxRows(
      { [channel().id]: channel({ unreadCount: 2 }) },
      communities,
      {},
      { [conversation().id]: conversation({ unreadCount: 1 }) },
      {},
      true,
      notifications(),
    )

    expect(rows.map((row) => row.key).sort()).toEqual(['direct:!maya:example.org', 'room:!lobby:example.org'])
  })

  it('still surfaces a room locally hidden from the sidebar: hiding is a rendering filter, not data removal', () => {
    localStorage.clear()
    useRoomOrganizationStore.getState().resetForAccountTransition()
    useRoomOrganizationStore.getState().initialize('@me:example.org')
    useRoomOrganizationStore.getState().hide(channel().id)
    expect(useRoomOrganizationStore.getState().hidden).toContain(channel().id)

    // resolveInboxRows takes the channel store directly and has no concept of
    // room-organization's hidden list, so a hidden room's unread state must
    // still reach it exactly as an unhidden room's would.
    const rows = resolveInboxRows(
      { [channel().id]: channel({ unreadCount: 2 }) },
      communities,
      {},
      {},
      {},
      true,
      notifications(),
    )
    expect(rows.map((row) => row.key)).toEqual(['room:!lobby:example.org'])
  })

  it('leaves quiet rooms and conversations out entirely', () => {
    const rows = resolveInboxRows(
      { [channel().id]: channel() },
      communities,
      {},
      { [conversation().id]: conversation() },
      {},
      true,
      notifications(),
    )

    expect(rows).toHaveLength(0)
  })

  it('floats a callout above plain unread, without reordering within either band', () => {
    const quiet = channel({ id: '!a:example.org', name: 'a', unreadCount: 1 })
    const mentioned = channel({ id: '!b:example.org', name: 'b', unreadMentions: 1 })
    const rows = resolveInboxRows(
      { [quiet.id]: quiet, [mentioned.id]: mentioned },
      communities,
      {},
      {},
      {},
      true,
      notifications(),
    )

    expect(rows.map((row) => row.title)).toEqual(['b', 'a'])
  })

  it('non-text channels (voice-only rooms) never appear', () => {
    const voiceOnly = channel({ channelType: 'voice' as Channel['channelType'], unreadCount: 5 })
    const rows = resolveInboxRows(
      { [voiceOnly.id]: voiceOnly },
      communities,
      {},
      {},
      {},
      true,
      notifications(),
    )

    expect(rows).toHaveLength(0)
  })
})

describe('the summary slot carries a message or nothing', () => {
  const notifications = () => useSettingsStore.getState().notifications

  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      notifications: { ...state.notifications, channelNotificationLevels: {} },
    }))
  })

  const communities = {
    crew: {
      id: 'crew',
      name: 'Canyon Crew',
      description: '',
      avatarUrl: null,
      memberCount: 12,
      role: 'member' as const,
    },
  } as unknown as Parameters<typeof resolveWaitingRoomRow>[1]

  const channel = (patch: Partial<Channel> = {}): Channel => ({
    id: '!lobby:example.org',
    communityId: 'crew',
    name: 'lobby',
    topic: '',
    channelType: 'text',
    unreadCount: 0,
    joined: true,
    ...patch,
  })

  const message = (content: string) => ({
    '!lobby:example.org': [{
      id: '$1',
      channelId: '!lobby:example.org',
      authorPublicKey: '@maya:example.org',
      authorDisplayName: 'Maya',
      authorAvatarColor: '#fff',
      content,
      timestamp: '2026-08-01T00:00:00.000Z',
      signature: '',
      attachments: [],
      reactions: {},
    }],
  } as unknown as Parameters<typeof resolveWaitingRoomRow>[2])

  /*
    Every row on these surfaces carries its own unread count as a numeral, so a
    phrase beside it saying there is something new repeats the numeral in words,
    and a phrase saying there is not repeats the numeral's absence. Neither told
    anybody which row to open. What does is the message, so the slot holds that
    or it holds nothing.
  */
  it('details only the community when there is no message to quote', () => {
    const row = resolveWaitingRoomRow(
      channel({ unreadCount: 4 }),
      communities,
      {},
      true,
      notifications(),
    )

    expect(row?.detail).toBe('Canyon Crew')
    expect(row?.unreadCount).toBe(4)
  })

  it('quotes the message when there is one', () => {
    const row = resolveWaitingRoomRow(
      channel({ unreadCount: 4 }),
      communities,
      message('Bring a headlamp'),
      true,
      notifications(),
    )

    expect(row?.detail).toBe('Canyon Crew · Maya: Bring a headlamp')
  })

  /*
    The privacy branch is the one thing here that must survive the cut. With
    notification previews turned off, the row is forbidden the message; what it
    is not forbidden is saying that four things are waiting, and the count and
    the accessible name both still do.
  */
  it('withholds the message with previews off, and still counts the unread', () => {
    const row = resolveWaitingRoomRow(
      channel({ unreadCount: 4 }),
      communities,
      message('Bring a headlamp'),
      false,
      notifications(),
    )

    expect(row?.detail).toBe('Canyon Crew')
    expect(row?.detail).not.toContain('headlamp')
    expect(row?.preview).toBe('')
    expect(row?.unreadCount).toBe(4)
    expect(rowAccessibleName(row!)).toBe('lobby, Canyon Crew, 4 unread')
  })

  it('reads a conversation row without an empty gap where the summary was', () => {
    expect(rowAccessibleName({
      title: 'Maya',
      detail: '',
      unreadCount: 2,
      unreadMentions: 0,
    })).toBe('Maya, 2 unread')
  })
})
