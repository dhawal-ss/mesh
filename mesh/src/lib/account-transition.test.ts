import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRendererAccountState } from './account-transition'
import { registeredAccountResets } from './account-reset-registry'
import { useChannelStore } from '../store/channels'
import { useCommunityStore } from '../store/communities'
import { useDmStore } from '../store/dms'
import { useDraftStore } from '../store/drafts'
import { useFileDownloadStore } from '../store/file-downloads'
import { useMatrixAvatarStore } from '../store/matrix-avatars'
import { useMembershipStore } from '../store/membership'
import { useMessageNavigationStore } from '../store/message-navigation'
import { useMessageStore } from '../store/messages'
import { useNetworkStore } from '../store/network'
import { useMeshNavigationStore } from '../store/navigation'
import { useRoomOrganizationStore } from '../store/room-organization'
import { useRoomPinStore } from '../store/room-pins'
import { useShellStore } from '../store/shell'
import { useThreadListStore } from '../store/threads'
import { useTypingStore } from '../store/typing'
import { useVoiceStore } from '../store/voice'
import { useSettingsStore } from '../store/settings'
import { meshNavigationStorageKey } from './mesh-navigation'
import { onboardingChecklistStorageKey } from './onboarding-checklist'
import { useOnboardingChecklistStore } from '../store/onboarding-checklist'
import { roomOrganizationStorageKey } from './room-organization'

describe('account transition', () => {
  beforeEach(() => {
    localStorage.clear()
    clearRendererAccountState()
    useSettingsStore.setState({
      backup: { configured: false, reminderPending: false, dismissedAt: null },
      backupAccountId: null,
      backupByAccount: {},
    })
  })

  it('holds a reset for every store, so a new one cannot be forgotten quietly', async () => {
    /*
      The failure this replaces: `clearRendererAccountState` inlined the initial
      state of nine stores in a file their authors had no reason to open, so a
      new field survived an account switch silently. useThreadListStore was
      missed exactly that way and left one account's thread list on screen for
      the next.

      Reading the store directory rather than a hand-written list is the point.
      A list here would need the same maintenance the old file did, and would go
      stale in the same silence.
      */
    const modules = import.meta.glob('../store/*.ts')
    const storeNames = Object.keys(modules)
      .map((path) => path.replace('../store/', '').replace('.ts', ''))
      .filter((name) => !name.endsWith('.test'))
    const creating: string[] = []
    for (const name of storeNames) {
      const source = await import(`../store/${name}.ts?raw`).then((m) => m.default as string)
      if (source.includes('create<')) creating.push(name)
    }

    const registered = new Set(registeredAccountResets())
    const missing = creating.filter((name) => !registered.has(name))
    expect(missing, `these stores create state but declare no account reset: ${missing.join(', ')}`)
      .toEqual([])
    expect(creating.length).toBeGreaterThan(15)
  })

  it('deletes saved navigation only for an explicitly removed account', () => {
    const removedNavigationKey = meshNavigationStorageKey('@removed:example.org')
    const retainedNavigationKey = meshNavigationStorageKey('@retained:example.org')
    localStorage.setItem(removedNavigationKey, 'removed-navigation')
    localStorage.setItem(retainedNavigationKey, 'retained-navigation')
    useMeshNavigationStore.getState().initialize('@removed:example.org')

    clearRendererAccountState('@removed:example.org')

    expect(localStorage.getItem(removedNavigationKey)).toBeNull()
    expect(localStorage.getItem(retainedNavigationKey)).toBe('retained-navigation')
    expect(useMeshNavigationStore.getState()).toMatchObject({
      accountId: 'local-device',
      hydrated: false,
      drawer: 'none',
    })
  })

  it('deletes saved room organization only for an explicitly removed account', () => {
    const removedKey = roomOrganizationStorageKey('@removed:example.org')
    const retainedKey = roomOrganizationStorageKey('@retained:example.org')
    localStorage.setItem(removedKey, 'removed-organization')
    localStorage.setItem(retainedKey, 'retained-organization')
    useRoomOrganizationStore.getState().initialize('@removed:example.org')
    useRoomOrganizationStore.getState().hide('room-noisy')

    clearRendererAccountState('@removed:example.org')

    expect(localStorage.getItem(removedKey)).toBeNull()
    expect(localStorage.getItem(retainedKey)).toBe('retained-organization')
    expect(useRoomOrganizationStore.getState()).toMatchObject({
      accountId: 'local-device',
      hydrated: false,
      hidden: [],
    })
  })

  /*
   * The checklist is reached through a registration rather than imported here,
   * so that a function only sign-out needs stays out of the startup chunk. That
   * indirection can silently become a no-op, which is what this covers.
   */
  it('deletes a saved getting started list only for an explicitly removed account', () => {
    const removedKey = onboardingChecklistStorageKey('@removed:example.org')
    const retainedKey = onboardingChecklistStorageKey('@retained:example.org')
    localStorage.setItem(retainedKey, 'retained-checklist')
    useOnboardingChecklistStore.getState().initialize('@removed:example.org')
    useOnboardingChecklistStore.getState().dismiss()
    expect(localStorage.getItem(removedKey)).not.toBeNull()

    clearRendererAccountState('@removed:example.org')

    expect(localStorage.getItem(removedKey)).toBeNull()
    expect(localStorage.getItem(retainedKey)).toBe('retained-checklist')
    expect(useOnboardingChecklistStore.getState()).toMatchObject({
      accountId: 'local-device',
      hydrated: false,
      dismissed: false,
      reached: [],
    })
  })

  it('continues account cleanup when browser storage denies removal', () => {
    const denied = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })

    expect(() => clearRendererAccountState('@removed:example.org')).not.toThrow()
    denied.mockRestore()
    expect(useCommunityStore.getState().communities).toEqual([])
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
      blockedAccounts: [{ userId: '@blocked:old.example.org' }],
      blockedAccountsNextCursor: '@next:old.example.org',
      blockedAccountLoad: { status: 'loaded', error: null, generation: 4 },
      messages: { dm: [{ id: 'secret-dm' } as never] },
      activeConversationId: 'dm',
      isDmMode: true,
    })
    useMembershipStore.setState({
      members: { old: [{ publicKey: '@old:example.org' } as never] },
      rosterNextCursor: { old: '@old:example.org' },
      rosterStateComplete: { old: true },
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
      recoveredConnection: { durationMs: 8_000, recoveredAt: 1_786_000_000_000 },
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
    expect(useDmStore.getState()).toMatchObject({
      blockedAccounts: [],
      blockedAccountsNextCursor: null,
      blockedAccountLoad: { status: 'idle', error: null, generation: 0 },
    })
    expect(useMembershipStore.getState().members).toEqual({})
    expect(useMembershipStore.getState().rosterNextCursor).toEqual({})
    expect(useMembershipStore.getState().rosterStateComplete).toEqual({})
    expect(useMessageStore.getState().messages).toEqual({})
    expect(useMessageStore.getState().matrixQueueStates).toEqual({})
    expect(useTypingStore.getState().typingByChannel).toEqual({})
    expect(useDraftStore.getState().drafts).toEqual({})
    expect(useFileDownloadStore.getState().downloads).toEqual({})
    expect(useMessageNavigationStore.getState().pending).toBeNull()
    expect(useRoomPinStore.getState().roomId).toBeNull()
    expect(useNetworkStore.getState().status.state).toBe('connecting')
    expect(useNetworkStore.getState().recoveredConnection).toBeNull()
    expect(useVoiceStore.getState().currentChannelId).toBeNull()
    expect(useVoiceStore.getState().localPublicKey).toBeNull()
    expect(useVoiceStore.getState().matrixRtcMembersByRoom).toEqual({})
    expect(useShellStore.getState()).toMatchObject({
      serverModalOpen: false,
      profileOpen: false,
      securityOpen: false,
    })
  })

  it('revokes and drops profile pictures the departing account had resolved', () => {
    /*
      A resolved picture is two things the next account has no claim to: an
      object URL that stays resident off-heap until something revokes it, and
      readable image content belonging to the previous account's contacts.
    */
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL }))
    useMatrixAvatarStore.setState({
      entries: {
        'mxc://old.example.org/one': { status: 'ready', objectUrl: 'blob:old-one' },
        'mxc://old.example.org/two': { status: 'ready', objectUrl: 'blob:old-two' },
      },
      recency: ['mxc://old.example.org/two', 'mxc://old.example.org/one'],
    })

    clearRendererAccountState()

    expect(revokeObjectURL.mock.calls.flat().sort()).toEqual(['blob:old-one', 'blob:old-two'])
    expect(useMatrixAvatarStore.getState().entries).toEqual({})
    expect(useMatrixAvatarStore.getState().recency).toEqual([])
    vi.unstubAllGlobals()
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
        reduceMotion: true,
      textScale: 100,
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
      backupAccountId: '@current:example.org',
      backupByAccount: {
        '@current:example.org': {
          configured: true,
          reminderPending: false,
          dismissedAt: null,
        },
        '@other:example.org': {
          configured: false,
          reminderPending: true,
          dismissedAt: '2026-07-30T00:00:00.000Z',
        },
      },
    })

    clearRendererAccountState()

    expect(useSettingsStore.getState()).toMatchObject({
      appearance: {
        theme: 'high-contrast',
        density: 'compact',
        accent: 'violet',
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
      backupAccountId: null,
      backupByAccount: {
        '@current:example.org': {
          configured: true,
          reminderPending: false,
          dismissedAt: null,
        },
        '@other:example.org': {
          configured: false,
          reminderPending: true,
          dismissedAt: '2026-07-30T00:00:00.000Z',
        },
      },
      matrixPreferenceSync: {
        status: 'idle',
        error: null,
      },
    })
  })
  it('drops the previous account thread list even when both share a room', () => {
    useThreadListStore.setState({
      roomId: '!shared:example.org',
      items: [
        {
          rootEventId: '$root:example.org',
          rootPreview: 'private to the account that just signed out',
          replyCount: 3,
          latestActivityTs: 1,
          unreadCount: 1,
          hasMention: true,
          participants: [],
        },
      ] as never,
      hasMore: true,
      loading: false,
      loadFailed: false,
    })

    clearRendererAccountState('@previous:example.org')

    expect(useThreadListStore.getState().roomId).toBeNull()
    expect(useThreadListStore.getState().items).toEqual([])
    expect(useThreadListStore.getState().hasMore).toBe(false)
  })
})
