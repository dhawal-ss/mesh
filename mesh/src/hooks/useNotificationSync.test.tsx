import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MatrixNotification,
  MatrixUnreadUpdate,
  NotificationPresentationContext,
} from '../types/ipc'

const bridgeMocks = vi.hoisted(() => ({
  setNotificationContext: vi.fn<(context: NotificationPresentationContext) => Promise<void>>(
    () => Promise.resolve(),
  ),
  sendTestNotification: vi.fn(() => Promise.resolve()),
  getMatrixRoomNotificationMode: vi.fn<
    () => Promise<'all' | 'mentions' | 'nothing'>
  >(() => Promise.resolve('mentions')),
  setMatrixRoomNotificationMode: vi.fn(() => Promise.resolve()),
  notificationHandler: undefined as ((notification: MatrixNotification) => void) | undefined,
  unreadHandler: undefined as ((update: MatrixUnreadUpdate) => void) | undefined,
}))

const interfaceSoundMocks = vi.hoisted(() => ({
  play: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('../lib/bridge', () => ({
  isMatrixBackend: () => true,
  setKv: vi.fn(() => Promise.resolve()),
  getMatrixUserPreferences: vi.fn(() => Promise.resolve(null)),
  updateMatrixUserPreferences: vi.fn((preferences) =>
    Promise.resolve({ ...preferences, updatedAt: new Date().toISOString() }),
  ),
  setNotificationContext: bridgeMocks.setNotificationContext,
  sendTestNotification: bridgeMocks.sendTestNotification,
  getMatrixRoomNotificationMode: bridgeMocks.getMatrixRoomNotificationMode,
  setMatrixRoomNotificationMode: bridgeMocks.setMatrixRoomNotificationMode,
  onMatrixNotification: vi.fn((handler) => {
    bridgeMocks.notificationHandler = handler
    return Promise.resolve(vi.fn())
  }),
  onMatrixUnreadUpdate: vi.fn((handler) => {
    bridgeMocks.unreadHandler = handler
    return Promise.resolve(vi.fn())
  }),
}))

vi.mock('../lib/interface-sounds', () => ({
  playInterfaceSound: interfaceSoundMocks.play,
}))

vi.mock('../components/ui/Toast', () => ({
  showToast: vi.fn(),
}))

import { useNotificationSync } from './useNotificationSync'
import { useChannelStore } from '../store/channels'
import { useDmStore } from '../store/dms'
import { useSettingsStore } from '../store/settings'

const room = {
  id: '!general:example.org',
  communityId: '!space:example.org',
  name: 'general',
  channelType: 'text' as const,
  unreadCount: 0,
}

function Harness() {
  useNotificationSync({ matrixMode: true, activeRoomId: room.id })
  return null
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  })
}

describe('useNotificationSync', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    bridgeMocks.notificationHandler = undefined
    bridgeMocks.unreadHandler = undefined
    bridgeMocks.getMatrixRoomNotificationMode.mockResolvedValue('mentions')
    useChannelStore.getState().setChannels([room])
    useDmStore.getState().setConversations([])
    useSettingsStore.setState((state) => ({
      notifications: {
        ...state.notifications,
        enabled: true,
        sound: true,
        soundId: 'pulse',
        doNotDisturb: false,
        quietHours: { enabled: false, start: '22:00', end: '08:00' },
        mutedChannels: [],
        mutedCommunities: [],
        channelMuteUntil: {},
        communityMuteUntil: {},
        channelNotificationLevels: {},
      },
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('wires native policy, sound, SDK unread updates, and Matrix push rules', async () => {
    await act(async () => {
      root.render(<Harness />)
    })
    await flushEffects()

    expect(bridgeMocks.setNotificationContext).toHaveBeenCalledWith({
      activeRoomId: room.id,
      notificationsEnabled: true,
      doNotDisturb: false,
      showMessageContent: false,
      quietHoursActive: false,
      mutedRoomIds: [],
    })
    expect(bridgeMocks.getMatrixRoomNotificationMode).toHaveBeenCalledWith(room.id)
    expect(useSettingsStore.getState().getChannelNotificationLevel(room.id)).toBe('mentions')

    act(() => {
      bridgeMocks.notificationHandler?.({
        roomId: '!other:example.org',
        eventId: '$event',
        sender: '@friend:example.org',
        displayName: 'Friend',
        preview: 'Hello',
        isMention: true,
        isDm: false,
        avatarUrl: null,
      })
      bridgeMocks.unreadHandler?.({
        roomId: room.id,
        unreadMessages: 6,
        unreadMentions: 2,
      })
    })

    expect(interfaceSoundMocks.play).toHaveBeenCalledWith('message-mention', {
      contextKey: '!other:example.org',
      focused: false,
    })
    expect(useChannelStore.getState().channelEntities[room.id]).toMatchObject({
      unreadCount: 6,
      unreadMentions: 2,
    })

    act(() => {
      useSettingsStore.getState().setChannelNotificationLevel(room.id, 'nothing')
    })
    await flushEffects()
    expect(bridgeMocks.setMatrixRoomNotificationMode).toHaveBeenCalledWith(
      room.id,
      'nothing',
    )

    bridgeMocks.getMatrixRoomNotificationMode.mockResolvedValue('all')
    act(() => window.dispatchEvent(new Event('focus')))
    await flushEffects()
    expect(useSettingsStore.getState().getChannelNotificationLevel(room.id)).toBe('all')
  })

  it('reconciles DM rooms through the same Matrix push-rule path', async () => {
    useDmStore.getState().setConversations([{
      id: '!dm:example.org',
      peerPublicKey: 'peer-key',
      peerDisplayName: 'Friend',
      peerAvatarColor: '#123456',
      lastMessageAt: null,
      unreadCount: 0,
      createdAt: '2026-07-27T00:00:00.000Z',
    }])

    await act(async () => {
      root.render(<Harness />)
    })
    await flushEffects()

    expect(bridgeMocks.getMatrixRoomNotificationMode).toHaveBeenCalledWith(
      '!dm:example.org',
    )
    expect(useSettingsStore.getState().getChannelNotificationLevel('!dm:example.org')).toBe(
      'mentions',
    )

    act(() => {
      bridgeMocks.unreadHandler?.({
        roomId: '!dm:example.org',
        unreadMessages: 4,
        unreadMentions: 3,
      })
    })
    expect(useDmStore.getState().conversationEntities['!dm:example.org']).toMatchObject({
      unreadCount: 4,
      unreadMentions: 3,
    })
  })
})
