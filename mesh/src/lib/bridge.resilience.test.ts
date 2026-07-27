import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  getMatrixRoomNotificationMode,
  matrixGetProfile,
  matrixLogout,
  matrixSendMessage,
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

  it('coalesces identical in-flight read requests', async () => {
    let resolveRequest!: (value: string) => void
    const pending = new Promise<string>((resolve) => {
      resolveRequest = resolve
    })
    invokeMock.mockReturnValue(pending as never)

    const first = getMatrixRoomNotificationMode('room-1')
    const second = getMatrixRoomNotificationMode('room-1')

    expect(invokeMock).toHaveBeenCalledTimes(1)
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
    invokeMock.mockReturnValue(new Promise(() => {}) as never)

    const result = matrixGetProfile()
    const assertion = expect(result).rejects.toMatchObject({ code: 'network_unavailable', retryable: true })
    await vi.advanceTimersByTimeAsync(46_000)

    await assertion
    expect(invokeMock).toHaveBeenCalledTimes(3)
  })

  it('never retries mutations, even for transient failures', async () => {
    invokeMock.mockRejectedValue({ code: 'network_unavailable', detail: 'offline', retryable: true })

    await expect(matrixUpdateProfileDisplayName('New name')).rejects.toMatchObject({
      code: 'network_unavailable',
    })
    expect(invokeMock).toHaveBeenCalledTimes(1)
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
