import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MatrixRoomPins, Message } from '../types/ipc'

const bridge = vi.hoisted(() => ({
  matrixRoomPins: vi.fn(),
  matrixToggleRoomPin: vi.fn(),
}))

vi.mock('../lib/bridge', () => bridge)

import { useRoomPinStore } from './room-pins'

const message: Message = {
  id: '$message:example.org',
  channelId: '!room:example.org',
  authorPublicKey: '@alice:example.org',
  authorDisplayName: 'Alice',
  authorAvatarColor: 'var(--avatar-sand)',
  content: 'Pinned reference',
  attachments: [],
  reactions: {},
  timestamp: '2026-07-28T12:00:00.000Z',
  signature: '',
}

function snapshot(overrides: Partial<MatrixRoomPins> = {}): MatrixRoomPins {
  return {
    roomId: message.channelId,
    eventIds: [message.id],
    messages: [message],
    unavailableEventIds: [],
    canManage: true,
    ...overrides,
  }
}

describe('native room pins', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useRoomPinStore.getState().clear()
  })

  it('loads an authoritative bounded snapshot and rejects unrelated message payloads', async () => {
    const excessEventIds = Array.from(
      { length: 101 },
      (_, index) => `$excess-${index}:example.org`,
    )
    bridge.matrixRoomPins.mockResolvedValue(snapshot({
      eventIds: [message.id, message.id, ...excessEventIds],
      messages: [
        message,
        { ...message, id: '$unrelated:example.org' },
      ],
      unavailableEventIds: ['$missing:example.org'],
    }))

    await useRoomPinStore.getState().load(message.channelId)

    expect(useRoomPinStore.getState()).toMatchObject({
      roomId: message.channelId,
      messages: [message],
      unavailableEventIds: [],
      canManage: true,
      loading: false,
      loadFailed: false,
    })
    expect(useRoomPinStore.getState().eventIds).toHaveLength(100)
    expect(useRoomPinStore.getState().eventIds[99]).toBe('$excess-98:example.org')
  })

  it('updates optimistically and reconciles with the authoritative response', async () => {
    useRoomPinStore.setState({
      roomId: message.channelId,
      eventIds: [],
      messages: [],
      unavailableEventIds: [],
      canManage: true,
      loading: false,
      loadFailed: false,
    })
    let resolveToggle: (value: MatrixRoomPins) => void = () => {}
    bridge.matrixToggleRoomPin.mockReturnValue(new Promise<MatrixRoomPins>((resolve) => {
      resolveToggle = resolve
    }))

    const toggle = useRoomPinStore.getState().toggle(message.channelId, message)
    expect(useRoomPinStore.getState().eventIds).toEqual([message.id])

    resolveToggle(snapshot())
    await expect(toggle).resolves.toBe(true)
    expect(useRoomPinStore.getState()).toMatchObject({
      eventIds: [message.id],
      messages: [message],
      canManage: true,
    })
  })

  it('rolls back an optimistic change when the state event is rejected', async () => {
    useRoomPinStore.setState({
      roomId: message.channelId,
      eventIds: [message.id],
      messages: [message],
      unavailableEventIds: [],
      canManage: true,
      loading: false,
      loadFailed: false,
    })
    bridge.matrixToggleRoomPin.mockRejectedValue(new Error('permission changed'))

    await expect(
      useRoomPinStore.getState().toggle(message.channelId, message),
    ).resolves.toBe(false)

    expect(useRoomPinStore.getState()).toMatchObject({
      eventIds: [message.id],
      messages: [message],
      canManage: true,
    })
  })
})
