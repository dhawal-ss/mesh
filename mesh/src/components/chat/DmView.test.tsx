import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./MessageInput', () => ({
  MessageInput: () => <div>Message composer remains available</div>,
}))

vi.mock('./Message', () => ({
  FileAttachmentCard: () => null,
}))

vi.mock('./ReactionPicker', () => ({
  ReactionPicker: () => null,
}))

import * as bridge from '../../lib/bridge'
import { useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import type { DirectMessage } from '../../types/ipc'
import { DmView } from './DmView'

function directMessage(id: string, content: string): DirectMessage {
  return {
    id,
    conversationId: 'conversation-1',
    authorPublicKey: `@${id}:example.org`,
    authorDisplayName: id,
    authorAvatarColor: '#52b5f4',
    content,
    timestamp: '2026-07-25T12:00:00.000Z',
    signature: '',
    attachments: [],
    reactions: {},
  }
}

describe('DmView message containment', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })

    useIdentityStore.setState({
      identity: {
        publicKey: '@me:example.org',
        displayName: 'Me',
        avatarColor: '#3ba55d',
      },
      isLoading: false,
    })
    useDmStore.setState({
      conversationEntities: {
        'conversation-1': {
          id: 'conversation-1',
          peerPublicKey: '@peer:example.org',
          peerDisplayName: 'Peer',
          peerAvatarColor: '#52b5f4',
          lastMessageAt: null,
          unreadCount: 0,
          createdAt: '2026-07-25T12:00:00.000Z',
        },
      },
      conversationOrder: ['conversation-1'],
      conversations: [{
        id: 'conversation-1',
        peerPublicKey: '@peer:example.org',
        peerDisplayName: 'Peer',
        peerAvatarColor: '#52b5f4',
        lastMessageAt: null,
        unreadCount: 0,
        createdAt: '2026-07-25T12:00:00.000Z',
      }],
      messageEntities: {},
      messageOrder: {},
      activeConversationId: 'conversation-1',
      messages: {},
      isDmMode: true,
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'onDmReceived').mockResolvedValue(() => {})
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('replaces only a malformed message while rendering the rest of the conversation', async () => {
    const malformed = {
      ...directMessage('malformed', 'Broken event'),
      authorDisplayName: null as unknown as string,
    }
    const valid = directMessage('valid', 'Healthy event remains visible')
    vi.spyOn(bridge, 'getDmMessages').mockResolvedValue([malformed, valid])

    await act(async () => {
      root.render(<DmView />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'One message could not be displayed.',
    )
    expect(container.textContent).toContain('Healthy event remains visible')
    expect(container.textContent).toContain('Message composer remains available')
  })
})
