import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MatrixNotification,
  MatrixUnreadUpdate,
  NotificationPresentationContext,
} from '../types/ipc'

const bridgeMocks = vi.hoisted(() => ({
  getNotificationAccountScope: vi.fn(() => Promise.resolve({
    accountGeneration: 7,
    userId: '@alice:example.org',
  })),
  setNotificationContext: vi.fn<(
    scope: { accountGeneration: number; userId: string },
    context: NotificationPresentationContext,
  ) => Promise<void>>(
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
  getNotificationAccountScope: bridgeMocks.getNotificationAccountScope,
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

import * as bridge from '../lib/bridge'
import { useNotificationSync } from './useNotificationSync'
import { useChannelStore } from '../store/channels'
import { useDmStore } from '../store/dms'
import { useSettingsStore } from '../store/settings'

const room = {
  id: '!general:example.org',
  communityId: '!space:example.org',
  name: 'general',
  topic: '',
  channelType: 'text' as const,
  unreadCount: 0,
  joined: true,
}

function Harness({ activeRoomId = room.id }: { activeRoomId?: string | null }) {
  const sync = useNotificationSync({
    matrixMode: true,
    accountUserId: '@alice:example.org',
    activeRoomId,
  })
  return (
    <button
      type="button"
      data-notification-mode-failures={sync.notificationModeFailureCount}
      onClick={sync.retryNotificationModeSync}
    >
      Retry notification choices
    </button>
  )
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
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    bridgeMocks.notificationHandler = undefined
    bridgeMocks.unreadHandler = undefined
    bridgeMocks.getMatrixRoomNotificationMode.mockResolvedValue('mentions')
    bridgeMocks.getNotificationAccountScope.mockResolvedValue({
      accountGeneration: 7,
      userId: '@alice:example.org',
    })
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

    expect(bridgeMocks.getNotificationAccountScope).toHaveBeenCalledWith(
      '@alice:example.org',
    )
    expect(bridgeMocks.setNotificationContext).toHaveBeenCalledWith(
      { accountGeneration: 7, userId: '@alice:example.org' },
      {
        activeRoomId: room.id,
        notificationsEnabled: true,
        doNotDisturb: false,
        showMessageContent: false,
        quietHoursActive: false,
        mutedRoomIds: [],
      },
    )
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
        unreadMarked: false,
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

  it('does not schedule a notification policy clock while quiet hours are off', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval')

    await act(async () => {
      root.render(<Harness />)
    })

    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
  })

  it('keeps notification policy time-aware while quiet hours are on', async () => {
    useSettingsStore.setState((state) => ({
      notifications: {
        ...state.notifications,
        quietHours: { ...state.notifications.quietHours, enabled: true },
      },
    }))
    const setIntervalSpy = vi.spyOn(window, 'setInterval')

    await act(async () => {
      root.render(<Harness />)
    })

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000)
    setIntervalSpy.mockRestore()
  })

  it('keeps the policy clock ticking for a timed mute while quiet hours are off', async () => {
    // A timed mute only expires as the policy clock advances; the clock must run
    // even with quiet hours off, or the mute would never lift.
    useSettingsStore.setState((state) => ({
      notifications: {
        ...state.notifications,
        quietHours: { ...state.notifications.quietHours, enabled: false },
        channelMuteUntil: { [room.id]: '2999-01-01T00:00:00.000Z' },
      },
    }))
    const setIntervalSpy = vi.spyOn(window, 'setInterval')

    await act(async () => {
      root.render(<Harness />)
    })

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000)
    setIntervalSpy.mockRestore()
  })

  it('reconciles DM rooms through the same Matrix push-rule path', async () => {
    useDmStore.getState().setConversations([{
      id: '!dm:example.org',
      peers: [{ userId: 'peer-key', displayName: 'Friend', avatarColor: '#123456' }],
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
        unreadMarked: false,
      })
    })
    expect(useDmStore.getState().conversationEntities['!dm:example.org']).toMatchObject({
      unreadCount: 4,
      unreadMentions: 3,
    })
  })

  it('carries the explicit unread marker through to channels and DMs', async () => {
    useDmStore.getState().setConversations([{
      id: '!dm:example.org',
      peers: [{ userId: 'peer-key', displayName: 'Friend', avatarColor: '#123456' }],
      lastMessageAt: null,
      unreadCount: 0,
      createdAt: '2026-07-27T00:00:00.000Z',
    }])

    await act(async () => {
      root.render(<Harness />)
    })
    await flushEffects()

    act(() => {
      bridgeMocks.unreadHandler?.({
        roomId: room.id,
        unreadMessages: 0,
        unreadMentions: 0,
        unreadMarked: true,
      })
      bridgeMocks.unreadHandler?.({
        roomId: '!dm:example.org',
        unreadMessages: 0,
        unreadMentions: 0,
        unreadMarked: true,
      })
    })

    expect(useChannelStore.getState().channelEntities[room.id]).toMatchObject({
      unreadCount: 0,
      unreadMentions: 0,
      unreadMarked: true,
    })
    expect(useDmStore.getState().conversationEntities['!dm:example.org']).toMatchObject({
      unreadCount: 0,
      unreadMentions: 0,
      unreadMarked: true,
    })

    act(() => {
      bridgeMocks.unreadHandler?.({
        roomId: room.id,
        unreadMessages: 0,
        unreadMentions: 0,
        unreadMarked: false,
      })
    })
    expect(useChannelStore.getState().channelEntities[room.id]).toMatchObject({
      unreadMarked: false,
    })
  })

  it('preserves a local room setting changed while remote settings are loading', async () => {
    let resolveMode!: (mode: 'all' | 'mentions' | 'nothing') => void
    bridgeMocks.getMatrixRoomNotificationMode.mockReturnValue(new Promise((resolve) => {
      resolveMode = resolve
    }))
    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
    })

    act(() => {
      useSettingsStore.getState().setChannelNotificationLevel(room.id, 'nothing')
    })
    resolveMode('mentions')
    await flushEffects()

    expect(bridgeMocks.setMatrixRoomNotificationMode).toHaveBeenCalledWith(room.id, 'nothing')
    expect(useSettingsStore.getState().getChannelNotificationLevel(room.id)).toBe('nothing')
  })

  it('surfaces a scoped notification-mode failure and clears it after retry', async () => {
    bridgeMocks.getMatrixRoomNotificationMode
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('mentions')

    await act(async () => {
      root.render(<Harness />)
    })
    await flushEffects()

    const status = container.querySelector<HTMLButtonElement>(
      '[data-notification-mode-failures]',
    )
    expect(status?.dataset.notificationModeFailures).toBe('1')
    expect(console.warn).toHaveBeenCalledWith(
      'Failed to load notification settings for a room:',
      expect.any(Error),
    )

    await act(async () => {
      status?.click()
    })
    await flushEffects()
    expect(status?.dataset.notificationModeFailures).toBe('0')
  })

  it('keeps a room choice that is still being written through a channel refresh', async () => {
    let resolveWrite!: () => void
    bridgeMocks.setMatrixRoomNotificationMode.mockReturnValue(new Promise<void>((resolve) => {
      resolveWrite = () => resolve()
    }))

    await act(async () => {
      root.render(<Harness />)
    })
    await flushEffects()

    act(() => {
      useSettingsStore.getState().setChannelNotificationLevel(room.id, 'nothing')
    })
    expect(bridgeMocks.setMatrixRoomNotificationMode).toHaveBeenCalledWith(room.id, 'nothing')

    // A community refresh changes the room list and re-runs the sync effect
    // while the write is still unsettled. The reconcile that follows reads the
    // pre-write server value and must not write it back over the choice.
    await act(async () => {
      useChannelStore.getState().setChannels([
        room,
        { ...room, id: '!second:example.org', name: 'second' },
      ])
    })
    await flushEffects()
    expect(useSettingsStore.getState().getChannelNotificationLevel(room.id)).toBe('nothing')

    await act(async () => {
      resolveWrite()
      await Promise.resolve()
    })
    await flushEffects()
    expect(useSettingsStore.getState().getChannelNotificationLevel(room.id)).toBe('nothing')
  })

  it('keeps unread and notification listeners attached across a room switch', async () => {
    await act(async () => {
      root.render(<Harness activeRoomId={room.id} />)
    })
    await flushEffects()
    expect(bridge.onMatrixUnreadUpdate).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(<Harness activeRoomId="!other:example.org" />)
    })
    await flushEffects()

    // Re-registering is asynchronous, so tearing the listeners down on every
    // room switch left a window where unread counts reached nothing.
    expect(bridge.onMatrixUnreadUpdate).toHaveBeenCalledTimes(1)
    expect(bridge.onMatrixNotification).toHaveBeenCalledTimes(1)

    act(() => {
      bridgeMocks.unreadHandler?.({
        roomId: room.id,
        unreadMessages: 3,
        unreadMentions: 1,
        unreadMarked: false,
      })
    })
    expect(useChannelStore.getState().channelEntities[room.id]).toMatchObject({
      unreadCount: 3,
      unreadMentions: 1,
    })

    // The retained handler still has to know which room is open.
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
    })
    expect(interfaceSoundMocks.play).not.toHaveBeenCalled()

    act(() => {
      bridgeMocks.notificationHandler?.({
        roomId: room.id,
        eventId: '$event-2',
        sender: '@friend:example.org',
        displayName: 'Friend',
        preview: 'Hello',
        isMention: true,
        isDm: false,
        avatarUrl: null,
      })
    })
    expect(interfaceSoundMocks.play).toHaveBeenCalledWith('message-mention', {
      contextKey: room.id,
      focused: false,
    })
  })

  it('does not apply a policy scope after its account shell is gone', async () => {
    let resolveScope: ((scope: { accountGeneration: number; userId: string }) => void) | undefined
    bridgeMocks.getNotificationAccountScope.mockReturnValue(new Promise((resolve) => {
      resolveScope = resolve
    }))

    await act(async () => {
      root.render(<Harness />)
    })
    await act(async () => {
      root.render(null)
    })
    await act(async () => {
      resolveScope?.({ accountGeneration: 7, userId: '@alice:example.org' })
      await Promise.resolve()
    })

    expect(bridgeMocks.setNotificationContext).not.toHaveBeenCalled()
  })

})
