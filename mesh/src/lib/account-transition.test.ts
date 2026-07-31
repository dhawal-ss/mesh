import { beforeEach, describe, expect, it } from 'vitest'
import { clearRendererAccountState } from './account-transition'
import { roomTabStorageKey } from './room-tabs'
import { useChannelStore } from '../store/channels'
import { useCommunityStore } from '../store/communities'
import { useDmStore } from '../store/dms'
import { useDraftStore } from '../store/drafts'
import { useFileDownloadStore } from '../store/file-downloads'
import { useMembershipStore } from '../store/membership'
import { useMessageNavigationStore } from '../store/message-navigation'
import { useMessageStore } from '../store/messages'
import { useNetworkStore } from '../store/network'
import { useRoomPinStore } from '../store/room-pins'
import { useShellStore } from '../store/shell'
import { useTypingStore } from '../store/typing'
import { useVoiceStore } from '../store/voice'
import { useSettingsStore } from '../store/settings'

describe('account transition', () => {
  beforeEach(() => {
    clearRendererAccountState()
  })

  it('deletes room-tab metadata only for an explicitly removed account', () => {
    const removedKey = roomTabStorageKey('@removed:example.org')
    const retainedKey = roomTabStorageKey('@retained:example.org')
    localStorage.setItem(removedKey, 'removed-room-title')
    localStorage.setItem(retainedKey, 'retained-room-title')

    clearRendererAccountState('@removed:example.org')

    expect(localStorage.getItem(removedKey)).toBeNull()
    expect(localStorage.getItem(retainedKey)).toBe('retained-room-title')
    localStorage.removeItem(retainedKey)
  })

  it('removes room, notification, draft, transfer, and voice projections', () => {
    useCommunityStore.setState({
      communityEntities: { old: { id: 'old' } as never },
      communityOrder: ['old'],
      communities: [{ id: 'old' } as never],
      activeCommunityId: 'old',
    })
    useChannelStore.setState({
      channelEntities: { room: { id: 'room' } as never },
      channelOrder: ['room'],
      channels: [{ id: 'room' } as never],
      activeChannelId: 'room',
    })
    useDmStore.setState({
      conversations: [{ id: 'dm' } as never],
      messages: { dm: [{ id: 'secret-dm' } as never] },
      activeConversationId: 'dm',
      isDmMode: true,
    })
    useMembershipStore.setState({
      members: { old: [{ publicKey: '@old:example.org' } as never] },
    })
    useMessageStore.setState({
      messages: { room: [{ id: 'secret-room-message' } as never] },
      matrixQueueStates: {
        room: { request: { state: 'queued' } },
      } as never,
    })
    useTypingStore.setState({
      typingByChannel: {
        room: [
          {
            author: '@old:example.org',
            displayName: 'Old account',
            expiresAt: Infinity,
          },
        ],
      },
    })
    useDraftStore.setState({ drafts: { room: 'private unsent draft' } })
    useFileDownloadStore.setState({
      downloads: { secret: { localPath: 'C:\\private\\file.txt' } as never },
    })
    useMessageNavigationStore.setState({
      pending: {
        requestId: 1,
        message: { id: 'secret-room-message' } as never,
      },
    })
    useRoomPinStore.setState({
      roomId: 'room',
      eventIds: ['secret-room-message'],
      messages: [{ id: 'secret-room-message' } as never],
    })
    useNetworkStore.setState({
      status: { state: 'connected', peerCount: 4, averageLatency: 12 },
    })
    useVoiceStore.setState({
      currentCommunityId: 'old',
      currentChannelId: 'voice',
      localPublicKey: '@old:example.org',
      matrixRtcMembersByRoom: {
        voice: [{ userId: '@old:example.org' } as never],
      },
    })
    useShellStore.setState({
      serverModalOpen: true,
      profileOpen: true,
      securityOpen: true,
    })

    clearRendererAccountState()

    expect(useCommunityStore.getState().communities).toEqual([])
    expect(useChannelStore.getState().channels).toEqual([])
    expect(useDmStore.getState().messages).toEqual({})
    expect(useMembershipStore.getState().members).toEqual({})
    expect(useMessageStore.getState().messages).toEqual({})
    expect(useMessageStore.getState().matrixQueueStates).toEqual({})
    expect(useTypingStore.getState().typingByChannel).toEqual({})
    expect(useDraftStore.getState().drafts).toEqual({})
    expect(useFileDownloadStore.getState().downloads).toEqual({})
    expect(useMessageNavigationStore.getState().pending).toBeNull()
    expect(useRoomPinStore.getState().roomId).toBeNull()
    expect(useNetworkStore.getState().status.state).toBe('connecting')
    expect(useVoiceStore.getState().currentChannelId).toBeNull()
    expect(useVoiceStore.getState().localPublicKey).toBeNull()
    expect(useVoiceStore.getState().matrixRtcMembersByRoom).toEqual({})
    expect(useShellStore.getState()).toMatchObject({
      serverModalOpen: false,
      profileOpen: false,
      securityOpen: false,
    })
  })

  it('preserves the pending invitation and store actions for the next bootstrap', () => {
    const pendingInvitation = {
      handle: 'd283967b-e094-460c-bf06-fbe068c21d5b',
      roomOrAlias: '!garden:community.example',
      via: ['community.example'],
      service: 'community.example',
      admissionService: null,
      storedAt: 1_786_000_000_000,
      expiresAt: 1_788_592_000_000,
    }
    useShellStore.setState({ pendingInvitation })

    clearRendererAccountState()

    expect(useShellStore.getState().pendingInvitation).toEqual(pendingInvitation)
    expect(useCommunityStore.getState().setCommunities).toEqual(expect.any(Function))
    expect(useDraftStore.getState().setDraft).toEqual(expect.any(Function))
  })

  it('clears account preferences while preserving device appearance', () => {
    useSettingsStore.setState({
      appearance: {
        theme: 'high-contrast',
        density: 'compact',
        accent: 'violet',
        transparency: 'opaque',
      },
      notifications: {
        ...useSettingsStore.getState().notifications,
        enabled: false,
        mutedChannels: ['!private:example.org'],
        channelMuteUntil: { '!private:example.org': null },
      },
      privacy: {
        readReceiptMode: 'public',
        sendTypingIndicators: true,
        conversationPrivacy: {
          '!private:example.org': {
            readReceiptMode: 'public',
            sendTypingIndicators: true,
          },
        },
        sharePresence: true,
        invisibleMode: true,
      },
      backup: {
        configured: true,
        reminderPending: false,
        dismissedAt: '2026-07-30T00:00:00.000Z',
      },
    })

    clearRendererAccountState()

    expect(useSettingsStore.getState()).toMatchObject({
      appearance: {
        theme: 'high-contrast',
        density: 'compact',
        accent: 'violet',
        transparency: 'opaque',
      },
      notifications: {
        enabled: true,
        mutedChannels: [],
        channelMuteUntil: {},
      },
      privacy: {
        readReceiptMode: 'off',
        sendTypingIndicators: false,
        conversationPrivacy: {},
        sharePresence: false,
        invisibleMode: false,
      },
      backup: {
        configured: false,
        reminderPending: false,
        dismissedAt: null,
      },
      matrixPreferenceSync: {
        status: 'idle',
        error: null,
      },
    })
  })
})
