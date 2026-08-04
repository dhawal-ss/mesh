import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  getMatrixRoomNotificationMode,
  getIceServers,
  matrixCreateCommunity,
  matrixGetProfile,
  matrixListChannels,
  matrixLogout,
  matrixRevokeDevice,
  matrixRemoveLocalAccount,
  matrixDeactivateAccount,
  matrixSendMessage,
  probeIceServers,
  sendDm,
  matrixUpdateProfileDisplayName,
} from './bridge'

const invokeMock = vi.mocked(invoke)
const isTauriMock = vi.mocked(isTauri)

describe('bridge IPC resilience', () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    invokeMock.mockReset()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    isTauriMock.mockReturnValue(false)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('does not cross the destructive IPC boundary when native confirmation is cancelled', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'request_destructive_action_grant') return Promise.resolve(null) as never
      return Promise.reject(new Error(`unexpected command: ${command}`)) as never
    })

    await expect(matrixRevokeDevice('DEVICE-A', 'account-password')).resolves.toBe(false)
    await expect(matrixRemoveLocalAccount()).resolves.toBe(false)
    await expect(matrixDeactivateAccount('account-password')).resolves.toBe(false)
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'request_destructive_action_grant',
      'request_destructive_action_grant',
      'request_destructive_action_grant',
    ])
  })

  it('passes a native one-use grant only to the exact destructive write', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'request_destructive_action_grant') {
        return Promise.resolve('one-use-native-grant') as never
      }
      if (command === 'matrix_revoke_device') return Promise.resolve() as never
      return Promise.reject(new Error(`unexpected command: ${command}`)) as never
    })

    await expect(matrixRevokeDevice('DEVICE-A', 'account-password')).resolves.toBe(true)
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'request_destructive_action_grant', {
      action: 'revokeDevice',
      targetId: 'DEVICE-A',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'matrix_revoke_device', {
      deviceId: 'DEVICE-A',
      password: 'account-password',
      presenceGrant: 'one-use-native-grant',
    })
  })

  it('coalesces identical in-flight read requests', async () => {
    let resolveRequest!: (value: string) => void
    const pending = new Promise<string>((resolve) => {
      resolveRequest = resolve
    })
    invokeMock.mockReturnValue(pending as never)

    const first = getMatrixRoomNotificationMode('room-1')
    const second = getMatrixRoomNotificationMode('room-1')

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith(
      'matrix_get_room_notification_mode',
      expect.objectContaining({
        roomId: 'room-1',
        requestId: expect.any(String),
        deadlineMs: expect.any(Number),
      }),
    )
    resolveRequest('all')
    await expect(Promise.all([first, second])).resolves.toEqual(['all', 'all'])
  })

  it('retries transient read failures with bounded backoff', async () => {
    vi.useFakeTimers()
    invokeMock
      .mockRejectedValueOnce({ code: 'network_unavailable', detail: 'offline', retryable: true })
      .mockResolvedValueOnce('all')

    const result = getMatrixRoomNotificationMode('room-2')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe('all')
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it('times out a read instead of waiting forever', async () => {
    vi.useFakeTimers()
    invokeMock.mockImplementation((command) => {
      if (command === 'cancel_native_request') return Promise.resolve('completed') as never
      return new Promise(() => {}) as never
    })

    const result = matrixGetProfile()
    const assertion = expect(result).rejects.toMatchObject({
      code: 'network_unavailable',
      retryable: false,
    })
    await vi.advanceTimersByTimeAsync(15_000)

    await assertion
    expect(invokeMock.mock.calls.filter(([command]) => command === 'matrix_get_profile')).toHaveLength(1)
    expect(invokeMock).toHaveBeenCalledWith('cancel_native_request', {
      requestId: expect.any(String),
    })
  })

  it('blocks a later identical read until unacknowledged native work completes', async () => {
    vi.useFakeTimers()
    let resolveNative!: (value: unknown) => void
    const pendingNative = new Promise((resolve) => {
      resolveNative = resolve
    })
    let profileCalls = 0
    invokeMock.mockImplementation((command) => {
      if (command === 'cancel_native_request') return Promise.resolve('unknown-request') as never
      if (command === 'matrix_get_profile') {
        profileCalls += 1
        if (profileCalls === 1) return pendingNative as never
        return Promise.resolve({ userId: '@alice:example.org' }) as never
      }
      return Promise.resolve(undefined) as never
    })

    const first = matrixGetProfile()
    const firstAssertion = expect(first).rejects.toMatchObject({ retryable: false })
    await vi.advanceTimersByTimeAsync(15_000)
    await firstAssertion
    await Promise.resolve()

    const second = matrixGetProfile()
    await Promise.resolve()
    expect(profileCalls).toBe(1)

    resolveNative({ userId: '@alice:example.org' })
    await expect(second).resolves.toEqual({ userId: '@alice:example.org' })
    expect(profileCalls).toBe(2)
  })

  it('does not retry an untyped failure even when it claims to be retryable', async () => {
    invokeMock.mockRejectedValue({ detail: 'offline', retryable: true })

    await expect(matrixGetProfile()).rejects.toMatchObject({ code: 'network_unavailable' })
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('never retries mutations, even for transient failures', async () => {
    invokeMock.mockRejectedValue({ code: 'network_unavailable', detail: 'offline', retryable: true })

    await expect(matrixUpdateProfileDisplayName('New name')).rejects.toMatchObject({
      code: 'network_unavailable',
    })
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces a Tauri ICE configuration failure instead of silently using public defaults', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'network_unavailable',
      detail: 'ICE service offline',
      retryable: false,
    })

    await expect(getIceServers()).rejects.toMatchObject({
      code: 'network_unavailable',
      retryable: false,
    })
    expect(invokeMock).toHaveBeenCalledOnce()
  })

  it('keeps the browser preview fallback explicit and backend-free', async () => {
    isTauriMock.mockReturnValue(false)

    await expect(getIceServers()).resolves.toEqual([
      { urls: ['stun:stun.l.google.com:19302'] },
    ])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('propagates ICE probe failures so diagnostics can offer recovery', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'network_unavailable',
      detail: 'TURN probe offline',
      retryable: false,
    })

    await expect(probeIceServers()).rejects.toMatchObject({
      code: 'network_unavailable',
      retryable: false,
    })
    expect(invokeMock).toHaveBeenCalledOnce()
  })

  it('keeps newly created room names while Matrix state finishes syncing', async () => {
    invokeMock
      .mockResolvedValueOnce({
        community: {
          id: '!community:mesh.test',
          name: 'First Mesh',
          description: '',
          memberCount: 1,
          role: 'owner',
          joinedAt: null,
        },
        channel: {
          id: '!general:mesh.test',
          communityId: '!community:mesh.test',
          name: 'general',
          channelType: 'text',
          unreadCount: 0,
        },
      })
      .mockResolvedValueOnce({
        entities: [
          {
            id: '!general:mesh.test',
            communityId: '!community:mesh.test',
            name: 'unnamed',
            channelType: 'text',
            unreadCount: 4,
          },
        ],
        blockedEntities: [],
      })
      .mockResolvedValueOnce({
        entities: [
          {
            id: '!general:mesh.test',
            communityId: '!community:mesh.test',
            name: 'announcements',
            channelType: 'text',
            unreadCount: 5,
          },
        ],
        blockedEntities: [],
      })

    await matrixCreateCommunity('First Mesh', '')
    await expect(matrixListChannels('!community:mesh.test')).resolves.toEqual({
      entities: [expect.objectContaining({ name: 'general', unreadCount: 4 })],
      blockedEntities: [],
    })
    await expect(matrixListChannels('!community:mesh.test')).resolves.toEqual({
      entities: [expect.objectContaining({ name: 'announcements', unreadCount: 5 })],
      blockedEntities: [],
    })
  })

  it('carries stable delivery identifiers through message mutations', async () => {
    const message = { id: '$event:example.org' }
    invokeMock.mockResolvedValue(message as never)

    await matrixSendMessage('!room:example.org', 'hello', undefined, 'pending-123')
    expect(invokeMock).toHaveBeenLastCalledWith('matrix_send_message', {
      roomId: '!room:example.org',
      body: 'hello',
      replyToId: undefined,
      transactionId: 'pending-123',
    })

    await matrixLogout()
    await sendDm('@bob:example.org', 'hello', undefined, 'dm-123')
    expect(invokeMock).toHaveBeenLastCalledWith('matrix_send_dm', {
      recipientUserId: '@bob:example.org',
      body: 'hello',
      replyToId: undefined,
      transactionId: 'dm-123',
    })
  })
})
