import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ui/Avatar', () => ({
  Avatar: ({ name }: { name: string }) => <div>{name}</div>,
}))

vi.mock('./MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <p>{content}</p>,
}))

vi.mock('./ReactionPicker', () => ({
  ReactionPicker: () => null,
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}))

import type { Message } from '../../types/ipc'
import { MessageComponent } from './Message'

function malformedMessage(): Message {
  return {
    id: 'message-1',
    channelId: 'channel-1',
    authorPublicKey: '@alice:example.org',
    authorDisplayName: 'Alice',
    authorAvatarColor: '#5865f2',
    content: 'Federated message',
    attachments: [],
    reactions: {},
    timestamp: 'not-a-timestamp',
    signature: '',
  }
}

describe('MessageComponent federated timestamps', () => {
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
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([false, true])(
    'renders honest fallback copy for malformed %s-group timestamps',
    async (isGrouped) => {
      await expect(
        act(async () => {
          root.render(
            <MessageComponent
              message={malformedMessage()}
              isGrouped={isGrouped}
            />,
          )
        }),
      ).resolves.toBeUndefined()

      expect(container.textContent).toContain('Time unavailable')
      expect(container.textContent).not.toContain('Invalid Date')
    },
  )
})
