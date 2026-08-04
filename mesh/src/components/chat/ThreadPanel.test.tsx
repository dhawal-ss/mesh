import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./Message', () => ({
  MessageComponent: ({ message }: { message: { id: string; content: string } }) => (
    <article data-message-id={message.id}>{message.content}</article>
  ),
}))

import type { Message } from '../../types/ipc'
import { ThreadPanel } from './ThreadPanel'

function message(id: string, content: string, threadRootId?: string): Message {
  return {
    id,
    channelId: 'room-1',
    authorPublicKey: '@player:example.org',
    authorDisplayName: 'Player',
    authorAvatarColor: '#9b7cff',
    content,
    attachments: [],
    reactions: {},
    timestamp: '2026-08-02T12:00:00.000Z',
    signature: '',
    threadRootId,
    deliveryStatus: 'sent',
  }
}

describe('ThreadPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('keeps the root and replies in a dedicated secondary surface', async () => {
    const rootMessage = message('$root', 'Main question')
    const reply = message('$reply', 'Focused answer', '$root')
    const onReply = vi.fn()
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <ThreadPanel
          title="#concept-art"
          root={rootMessage}
          replies={[reply]}
          onReply={onReply}
          onClose={onClose}
        />,
      )
    })

    const panel = container.querySelector('#mesh-thread-panel')
    expect(panel?.getAttribute('aria-label')).toBe('Thread in #concept-art')
    expect(panel?.querySelectorAll('[data-message-id]')).toHaveLength(2)
    expect(panel?.textContent).toContain('1 reply')

    const replyButton = [...panel!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Reply in thread')
    await act(async () => replyButton?.click())
    expect(onReply).toHaveBeenCalledWith(rootMessage)

    await act(async () => {
      panel?.querySelector<HTMLButtonElement>('button[aria-label="Close thread"]')?.click()
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps a missing root recoverable instead of rendering orphan replies', async () => {
    await act(async () => {
      root.render(
        <ThreadPanel
          title="Maya Chen"
          root={null}
          replies={[message('$orphan', 'Orphaned reply', '$missing')]}
          onReply={vi.fn()}
          onClose={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain('Thread unavailable')
    expect(container.querySelector('[data-message-id]')).toBeNull()
  })
})
