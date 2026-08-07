import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixQueuedMessageUpdate, Message } from '../types/ipc'
import { useMessageStore } from '../store/messages'
import { useQueuedMessageSync } from './useQueuedMessageSync'
import * as bridge from '../lib/bridge'

vi.mock('../lib/bridge', () => ({
  onMatrixQueuedMessage: vi.fn(),
  matrixQueuedMessages: vi.fn(),
}))

function queuedMessage(): Message {
  return {
    id: 'txn-1',
    channelId: 'room-1',
    authorPublicKey: '@alice:example.org',
    authorDisplayName: 'Alice',
    authorAvatarColor: '#123456',
    content: 'Saved message',
    attachments: [],
    reactions: {},
    timestamp: '2025-01-01T00:00:00Z',
    signature: '',
    transactionId: 'txn-1',
    clientRequestId: 'request-1',
    deliveryStatus: 'pending',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useMessageStore.setState({
    messageEntities: {},
    messageOrder: {},
    messages: {},
    loadingOlder: {},
    hasMoreOlder: {},
    browsingOlder: {},
    newerGapCount: {},
    channelRecency: [],
    matrixQueueStates: {},
  })
})

let container: HTMLDivElement
let root: Root

function Harness({ reconnectSignal }: { reconnectSignal?: number }) {
  const sync = useQueuedMessageSync(true, reconnectSignal)
  return <button type="button" onClick={sync.retry}>{sync.status}</button>
}

async function flushEffects() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('useQueuedMessageSync', () => {
  it('registers first and replays updates received during snapshot hydration', async () => {
    let listener: ((update: MatrixQueuedMessageUpdate) => void) | undefined
    let resolveSnapshot: ((messages: Message[]) => void) | undefined
    vi.mocked(bridge.onMatrixQueuedMessage).mockImplementation(async (handler) => {
      listener = handler
      return () => {}
    })
    vi.mocked(bridge.matrixQueuedMessages).mockImplementation(
      () => new Promise((resolve) => {
        resolveSnapshot = resolve
      }),
    )

    await act(async () => root.render(<Harness />))
    await flushEffects()
    expect(bridge.matrixQueuedMessages).toHaveBeenCalledOnce()

    await act(async () => {
      listener?.({
        roomId: 'room-1',
        transactionId: 'txn-1',
        state: 'sent',
        eventId: '$event-1',
      })
      resolveSnapshot?.([queuedMessage()])
    })

    await flushEffects()
    expect(useMessageStore.getState().messages['room-1']?.[0]).toMatchObject({
      id: '$event-1',
      deliveryStatus: 'sent',
    })
    expect(vi.mocked(bridge.onMatrixQueuedMessage).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(bridge.matrixQueuedMessages).mock.invocationCallOrder[0])
  })

  it('restores the saved snapshot even when live updates fail, then retries the listener', async () => {
    const unlisten = vi.fn()
    vi.mocked(bridge.onMatrixQueuedMessage)
      .mockRejectedValueOnce(new Error('listener offline'))
      .mockResolvedValueOnce(unlisten)
    vi.mocked(bridge.matrixQueuedMessages).mockResolvedValue([queuedMessage()])

    await act(async () => root.render(<Harness />))
    await flushEffects()

    expect(container.querySelector('button')?.textContent).toBe('degraded')
    expect(useMessageStore.getState().messages['room-1']).toHaveLength(1)

    await act(async () => container.querySelector('button')?.click())
    await flushEffects()

    expect(container.querySelector('button')?.textContent).toBe('ready')
    expect(bridge.onMatrixQueuedMessage).toHaveBeenCalledTimes(2)
    expect(bridge.matrixQueuedMessages).toHaveBeenCalledTimes(2)
    expect(useMessageStore.getState().messages['room-1']).toHaveLength(1)
  })

  it('surfaces restore failure and replays an update buffered during a successful retry', async () => {
    let listener: ((update: MatrixQueuedMessageUpdate) => void) | undefined
    let resolveRetrySnapshot: ((messages: Message[]) => void) | undefined
    vi.mocked(bridge.onMatrixQueuedMessage).mockImplementation(async (handler) => {
      listener = handler
      return () => {}
    })
    vi.mocked(bridge.matrixQueuedMessages)
      .mockRejectedValueOnce(new Error('snapshot offline'))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveRetrySnapshot = resolve
      }))

    await act(async () => root.render(<Harness />))
    await flushEffects()
    expect(container.querySelector('button')?.textContent).toBe('failed')

    await act(async () => container.querySelector('button')?.click())
    await flushEffects()
    expect(container.querySelector('button')?.textContent).toBe('retrying-failed')

    await act(async () => {
      listener?.({
        roomId: 'room-1',
        transactionId: 'txn-1',
        state: 'sent',
        eventId: '$event-1',
      })
      resolveRetrySnapshot?.([queuedMessage()])
    })
    await flushEffects()

    expect(container.querySelector('button')?.textContent).toBe('ready')
    expect(useMessageStore.getState().messages['room-1']).toHaveLength(1)
    expect(useMessageStore.getState().messages['room-1']?.[0]).toMatchObject({
      id: '$event-1',
      deliveryStatus: 'sent',
    })
    expect(bridge.onMatrixQueuedMessage).toHaveBeenCalledOnce()
  })

  it('coalesces a reconnect retry that arrives while restore is still running', async () => {
    let rejectFirstSnapshot: ((error: Error) => void) | undefined
    vi.mocked(bridge.onMatrixQueuedMessage).mockResolvedValue(() => {})
    vi.mocked(bridge.matrixQueuedMessages)
      .mockImplementationOnce(() => new Promise((_, reject) => {
        rejectFirstSnapshot = reject
      }))
      .mockResolvedValueOnce([queuedMessage()])

    await act(async () => root.render(<Harness reconnectSignal={1} />))
    await flushEffects()
    expect(bridge.matrixQueuedMessages).toHaveBeenCalledOnce()

    await act(async () => root.render(<Harness reconnectSignal={2} />))
    await flushEffects()
    expect(bridge.matrixQueuedMessages).toHaveBeenCalledOnce()

    await act(async () => rejectFirstSnapshot?.(new Error('offline restore failed')))
    await flushEffects()

    expect(bridge.matrixQueuedMessages).toHaveBeenCalledTimes(2)
    expect(container.querySelector('button')?.textContent).toBe('ready')
    expect(useMessageStore.getState().messages['room-1']).toHaveLength(1)
  })

  it('does not mutate state when unmounted during snapshot loading', async () => {
    let resolveSnapshot: ((messages: Message[]) => void) | undefined
    const unlisten = vi.fn()
    vi.mocked(bridge.onMatrixQueuedMessage).mockResolvedValue(unlisten)
    vi.mocked(bridge.matrixQueuedMessages).mockImplementation(
      () => new Promise((resolve) => {
        resolveSnapshot = resolve
      }),
    )

    await act(async () => root.render(<Harness />))
    await flushEffects()
    expect(bridge.matrixQueuedMessages).toHaveBeenCalledOnce()
    await act(async () => root.render(<></>))
    await act(async () => resolveSnapshot?.([queuedMessage()]))

    await flushEffects()
    expect(useMessageStore.getState().messages).toEqual({})
    expect(unlisten).toHaveBeenCalledOnce()
  })
})
