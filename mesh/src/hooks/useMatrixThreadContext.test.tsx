import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MatrixThreadContextDto, Message } from '../types/ipc'
import { useMatrixThreadContext } from './useMatrixThreadContext'

const mocks = vi.hoisted(() => ({ matrixThreadContext: vi.fn() }))
vi.mock('../lib/bridge', () => ({ matrixThreadContext: mocks.matrixThreadContext }))

function message(id: string): Message {
  return {
    id,
    channelId: '!room:example.org',
    authorPublicKey: '@alice:example.org',
    authorDisplayName: 'Alice',
    authorAvatarColor: '#000000',
    content: id,
    attachments: [],
    reactions: {},
    timestamp: '2026-08-07T10:00:00Z',
    signature: '',
  }
}

function context(rootId: string): MatrixThreadContextDto {
  return {
    root: message(rootId),
    replies: [],
    unreadCount: 2,
    unreadMentions: 1,
    unreadStateAvailable: true,
    hasMore: false,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function Harness({ rootId }: { rootId: string }) {
  const state = useMatrixThreadContext('!room:example.org', rootId, true)
  return (
    <button type="button" onClick={state.clearUnread}>
      {state.status}:{state.context?.root.id ?? 'none'}:{state.context?.unreadCount ?? 0}
    </button>
  )
}

describe('useMatrixThreadContext', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mocks.matrixThreadContext.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('ignores a late response after switching threads and clears confirmed unread state', async () => {
    const first = deferred<MatrixThreadContextDto>()
    const second = deferred<MatrixThreadContextDto>()
    mocks.matrixThreadContext.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    await act(async () => root.render(<Harness rootId="$first" />))
    await act(async () => root.render(<Harness rootId="$second" />))
    await act(async () => second.resolve(context('$second')))
    expect(container.textContent).toBe('ready:$second:2')

    await act(async () => first.resolve(context('$first')))
    expect(container.textContent).toBe('ready:$second:2')

    await act(async () => container.querySelector('button')?.click())
    expect(container.textContent).toBe('ready:$second:0')
  })
})
