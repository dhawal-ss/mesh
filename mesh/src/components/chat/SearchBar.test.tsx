import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as bridge from '../../lib/bridge'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import type { Message } from '../../types/ipc'
import { SearchBar } from './SearchBar'

const targetMessage: Message = {
  id: 'target-message',
  channelId: 'channel-b',
  authorPublicKey: 'sender-1',
  authorDisplayName: 'Sender',
  authorAvatarColor: '#5865f2',
  content: 'The searched message',
  attachments: [],
  reactions: {},
  timestamp: '2026-07-25T11:30:00.000Z',
  signature: '',
}

describe('SearchBar', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useCommunityStore.setState({
      communities: [],
      activeCommunityId: 'community-1',
    })
    useChannelStore.setState({
      channels: [
        {
          id: 'channel-b',
          communityId: 'community-1',
          name: 'beta',
          channelType: 'text',
          unreadCount: 0,
        },
      ],
      activeChannelId: 'channel-a',
    })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('passes the complete result to the navigation owner', async () => {
    const navigate = vi.fn()
    const searchMessages = vi.spyOn(bridge, 'searchMessages').mockResolvedValue([targetMessage])

    await act(async () => {
      root.render(<SearchBar onNavigateToMessage={navigate} />)
    })

    const openButton = container.querySelector<HTMLButtonElement>(
      'button[title="Search messages"]',
    )
    await act(async () => {
      openButton?.click()
    })

    const input = container.querySelector<HTMLInputElement>('input[type="text"]')
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    await act(async () => {
      setValue?.call(input, 'searched')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(searchMessages).toHaveBeenCalledWith('searched', 'community-1', 20)
    const resultButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes(targetMessage.content),
    )
    await act(async () => {
      resultButton?.click()
    })

    expect(navigate).toHaveBeenCalledWith(targetMessage)
    expect(useChannelStore.getState().activeChannelId).toBe('channel-a')
  })
})
