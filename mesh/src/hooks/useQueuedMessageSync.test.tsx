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

function Harness() {
  useQueuedMessageSync(true)
  return null
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
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
