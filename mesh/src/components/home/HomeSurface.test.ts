import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, DmConversation, PendingInvitationMetadata } from '../../types/ipc'
import * as bridge from '../../lib/bridge'
import { useSettingsStore } from '../../store/settings'
import { useShellStore } from '../../store/shell'
import {
  communityInviteLabel,
  discardSavedInvitation,
  homeEmptyReason,
} from './HomeSurface'
import {
  resolveWaitingDirectRow,
  resolveWaitingRoomRow,
  safeActivitySummary,
  rowAccessibleName,
} from '../../lib/inbox-rows'

beforeEach(() => {
  vi.restoreAllMocks()
  useShellStore.setState({
    pendingInvitation: null,
    foregroundInvitationHandle: null,
  })
})

describe('Home privacy summaries', () => {
  it('hides message content when notification previews are off', () => {
    expect(safeActivitySummary(false, 3, 'Meet in the hidden room', 'Maya')).toBe('')
  })

  it('shows bounded content only when previews are allowed', () => {
    const summary = safeActivitySummary(true, 1, `  ${'a'.repeat(160)}  `, 'Maya')
    expect(summary.startsWith('Maya: ')).toBe(true)
    expect(summary).toHaveLength('Maya: '.length + 120)
  })

  /*
    Changed deliberately, not relaxed. The fallbacks used to be "All caught up"
    and "Something new", and every surface that prints this summary prints the
    row's unread count beside it, so both phrases restated the numeral in words
    on every row at once. Nothing is the honest value; the numeral carries the
    state, and `rowAccessibleName` spells it out for a screen reader.
  */
  it('returns nothing when there is no visible message', () => {
    expect(safeActivitySummary(true, 0)).toBe('')
    expect(safeActivitySummary(false, 2)).toBe('')
  })
})

describe('Home invitation actions', () => {
  it('clears the native invitation before removing its renderer summary', async () => {
    const pending = pendingInvitation('saved-invitation')
    useShellStore.getState().setPendingInvitation(pending)
    vi.spyOn(bridge, 'clearPendingInvitation').mockResolvedValue()

    await expect(discardSavedInvitation(pending.handle)).resolves.toBe(true)
    expect(bridge.clearPendingInvitation).toHaveBeenCalledWith(pending.handle)
    expect(useShellStore.getState().pendingInvitation).toBeNull()
  })

  it('does not clear a newer invitation when an older native discard finishes', async () => {
    const older = pendingInvitation('older-invitation')
    const newer = pendingInvitation('newer-invitation')
    useShellStore.getState().setPendingInvitation(older)
    vi.spyOn(bridge, 'clearPendingInvitation').mockImplementation(async () => {
      useShellStore.getState().setPendingInvitation(newer)
    })

    await expect(discardSavedInvitation(older.handle)).resolves.toBe(false)
    expect(useShellStore.getState().pendingInvitation).toEqual(newer)
  })
})

describe('Home waiting destinations', () => {
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

  it('surfaces a room that is waiting even though it was never opened here', () => {
    const row = resolveWaitingRoomRow(
      channel({ unreadCount: 3 }),
      communities,
      {},
      true,
      notifications(),
    )

    expect(row?.title).toBe('lobby')
    expect(row?.route).toEqual({
      kind: 'room',
      communityId: 'crew',
      roomId: '!lobby:example.org',
    })
    // No navigation record exists, so there is no honest "last opened" time.
    expect(row?.lastOpenedAt).toBeNull()
    expect(row?.detail).toContain('Canyon Crew')
  })

  it('leaves quiet rooms and conversations off Home entirely', () => {
    expect(resolveWaitingRoomRow(channel(), communities, {}, true, notifications())).toBeNull()
    expect(resolveWaitingDirectRow(conversation(), {}, true, notifications())).toBeNull()
  })

  it('counts a mention even when the unread total is stale at zero', () => {
    const row = resolveWaitingRoomRow(
      channel({ unreadCount: 0, unreadMentions: 2 }),
      communities,
      {},
      true,
      notifications(),
    )

    expect(row?.unreadMentions).toBe(2)
  })

  it('respects a silenced room', () => {
    useSettingsStore.getState().setChannelNotificationLevel('!lobby:example.org', 'nothing')

    expect(resolveWaitingRoomRow(
      channel({ unreadCount: 9, unreadMentions: 4 }),
      communities,
      {},
      true,
      notifications(),
    )).toBeNull()
  })

  it('drops a room whose community is not loaded rather than showing a stray name', () => {
    expect(resolveWaitingRoomRow(
      channel({ communityId: 'gone', unreadCount: 5 }),
      communities,
      {},
      true,
      notifications(),
    )).toBeNull()
  })

  it('honours the notification-preview setting for waiting conversations', () => {
    const messages = {
      '!maya:example.org': [
        { content: 'See you at the playtest', authorDisplayName: 'Maya' },
      ],
    } as unknown as Parameters<typeof resolveWaitingDirectRow>[1]

    expect(resolveWaitingDirectRow(
      conversation({ unreadCount: 1 }),
      messages,
      true,
      notifications(),
    )?.detail).toBe('Maya: See you at the playtest')

    // Nothing, rather than "Something new": with previews off the row is
    // permitted no content at all, and the unread count beside it already says
    // that something is waiting.
    expect(resolveWaitingDirectRow(
      conversation({ unreadCount: 1 }),
      messages,
      false,
      notifications(),
    )?.detail).toBe('')
  })
})

describe('Home row accessible names', () => {
  const row = { title: 'lobby', detail: 'Canyon Crew · New activity' }

  it('spells out what each bare numeral badge counts', () => {
    expect(rowAccessibleName({ ...row, unreadCount: 4, unreadMentions: 1 }))
      .toBe('lobby, Canyon Crew · New activity, 1 mention, 4 unread')
    expect(rowAccessibleName({ ...row, unreadCount: 4, unreadMentions: 0 }))
      .toBe('lobby, Canyon Crew · New activity, 4 unread')
    expect(rowAccessibleName({ ...row, unreadCount: 0, unreadMentions: 2 }))
      .toBe('lobby, Canyon Crew · New activity, 2 mentions')
  })

  it('says nothing about counts when there is nothing waiting', () => {
    expect(rowAccessibleName({ ...row, unreadCount: 0, unreadMentions: 0 }))
      .toBe('lobby, Canyon Crew · New activity')
  })
})

function pendingInvitation(handle: string): PendingInvitationMetadata {
  return {
    handle,
    roomOrAlias: '#party:example.org',
    via: ['example.org'],
    service: null,
    admissionService: null,
    communityName: 'Canyon Crew',
    storedAt: 1_786_000_000_000,
    expiresAt: 1_786_086_400_000,
  }
}

describe('homeEmptyReason', () => {
  it('does not call an unreached account service an empty account', () => {
    // restore_session turns a network failure into an empty local store, so an
    // offline start is indistinguishable from a new account by the list alone.
    expect(homeEmptyReason(false, 'reconnecting')).toBe('not-connected')
    expect(homeEmptyReason(false, 'unreachable')).toBe('not-connected')
    expect(homeEmptyReason(false, 'signed-out')).toBe('not-connected')
  })

  it('reports a genuinely empty account only once the link is online', () => {
    expect(homeEmptyReason(false, 'online')).toBe('no-communities')
  })

  it('keeps the invitation path when the link is online', () => {
    expect(homeEmptyReason(true, 'online')).toBe('invitation')
  })

  it('holds the connection answer above the invitation, which cannot be acted on yet', () => {
    expect(homeEmptyReason(true, 'reconnecting')).toBe('not-connected')
  })

  it('treats a silent backend as no evidence of trouble', () => {
    // null is first paint and the legacy backend's permanent state.
    expect(homeEmptyReason(false, null)).toBe('no-communities')
    expect(homeEmptyReason(true, null)).toBe('invitation')
  })
})

describe('communityInviteLabel', () => {
  const invite = {
    roomId: '!space:mesh.test',
    name: 'Aurora Collective',
    inviterUserId: '@lena:mesh.test',
    inviterDisplayName: 'Lena',
    inviterAvatarColor: 'var(--avatar-sand)',
    canAccept: true,
  }

  it('names the inviter and the community in one actionable sentence', () => {
    expect(communityInviteLabel(invite)).toBe('Lena invited you to Aurora Collective')
  })

  it('says why an unencrypted community can only be declined', () => {
    expect(communityInviteLabel({ ...invite, canAccept: false })).toBe(
      'Lena invited you to Aurora Collective. This community is not end-to-end encrypted, so Mesh can only decline.',
    )
  })
})
