import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }))

import { InboxSurface } from './InboxSurface'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { useMessageStore } from '../../store/messages'
import { useSettingsStore } from '../../store/settings'

const COMMUNITY_ID = '+lantern:mesh.test'
const ROOM_ID = '!notes:mesh.test'

function seedCommunity() {
  useCommunityStore.setState({
    communityEntities: {
      [COMMUNITY_ID]: {
        id: COMMUNITY_ID,
        name: 'Lantern Guild',
        handle: 'lantern',
        memberCount: 15,
      },
    },
  } as never)
}

function seedUnreadRoom(unreadCount: number) {
  const room = {
    id: ROOM_ID,
    communityId: COMMUNITY_ID,
    name: 'notes',
    topic: '',
    channelType: 'text' as const,
    unreadCount,
    joined: true,
  }
  useChannelStore.setState({
    channels: [room],
    channelEntities: { [ROOM_ID]: room },
  } as never)
  useMessageStore.setState({
    messages: {
      [ROOM_ID]: [{
        id: '$msg',
        channelId: ROOM_ID,
        authorId: '@maya:mesh.test',
        authorDisplayName: 'Maya Chen',
        content: 'The warmer pass is ready for another look.',
        timestamp: 1_700_000_000_000,
      }],
    },
  } as never)
}

function seedUnreadConversation(unreadCount: number, displayName: string) {
  const conversation = {
    id: '!maya:mesh.test',
    peers: [{ userId: '@maya:mesh.test', displayName, avatarColor: '#52b5f4' }],
    lastMessageAt: null,
    unreadCount,
    createdAt: '2026-08-01T00:00:00.000Z',
  }
  useDmStore.setState({
    conversationEntities: { [conversation.id]: conversation },
    messages: {},
  } as never)
}

describe('InboxSurface', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    seedCommunity()
    useChannelStore.setState({ channels: [], channelEntities: {} } as never)
    useMessageStore.setState({ messages: {} } as never)
    useDmStore.setState({ conversationEntities: {}, messages: {} } as never)
    useSettingsStore.setState((state) => ({
      notifications: {
        ...state.notifications,
        showMessageContent: true,
        channelNotificationLevels: {},
      },
    }))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function renderInbox() {
    await act(async () => {
      root.render(<InboxSurface />)
      await Promise.resolve()
    })
    return container
  }

  /*
    An empty inbox used to say so three times over: "Nothing unread." in the
    masthead, "You are caught up" in the body, and a third line explaining what
    an inbox collects. The surface is named Inbox and it is visibly empty; one
    line is the whole message.
  */
  it('says an empty inbox is empty once', async () => {
    const inbox = await renderInbox()

    const caughtUp = (inbox.textContent ?? '').match(/caught up|Nothing unread/g) ?? []
    expect(caughtUp).toHaveLength(1)
    expect(inbox.textContent).not.toContain('will collect here')
  })

  /*
    The rows are the count. A sentence in the masthead totalling a list that is
    directly beneath it costs a line of the list to say what the list shows.
  */
  it('does not total the rows in a sentence above them', async () => {
    seedUnreadRoom(3)

    const inbox = await renderInbox()

    expect(inbox.textContent).toContain('notes')
    expect(inbox.textContent).not.toContain('waiting on you')
  })

  /*
    The privacy branch, end to end. With notification previews off the row is
    forbidden the message; it is not forbidden the count, and a screen reader
    still gets the count spelled out because the badge renders as a bare
    numeral.
  */
  it('withholds the message with previews off, and still shows the count', async () => {
    seedUnreadRoom(3)
    useSettingsStore.setState((state) => ({
      notifications: { ...state.notifications, showMessageContent: false },
    }))

    const inbox = await renderInbox()

    expect(inbox.textContent).not.toContain('warmer pass')
    expect(inbox.textContent).toContain('3')
    const row = inbox.querySelector('.mesh-inbox-row button')
    expect(row?.getAttribute('aria-label')).toBe('notes, Lantern Guild, 3 unread')
  })

  /*
    The direct-message branch is the one where an empty summary actually reaches
    the DOM: a room row still has its community name to fall back on, and a
    conversation row has nothing beneath the person's name at all. The name and
    the count carry the row, and the accessible name must not read out the gap
    where the summary used to be.
  */
  it('leaves a conversation row its name and its count, and no empty gap', async () => {
    seedUnreadConversation(3, 'Maya Chen')

    const inbox = await renderInbox()

    expect(inbox.textContent).toContain('Maya Chen')
    const row = inbox.querySelector('.mesh-inbox-row button')
    expect(row?.getAttribute('aria-label')).toBe('Maya Chen, 3 unread')
  })

  /*
    A person with no display name is an unknown account, not a "Private
    conversation": the row stands for somebody, and every conversation in this
    list is private, so that fallback named the surface where a name belongs.
  */
  it('calls a person with no display name an unknown account', async () => {
    seedUnreadConversation(1, '')

    const inbox = await renderInbox()

    expect(inbox.textContent).toContain('Unknown account')
    expect(inbox.textContent).not.toContain('Private conversation')
  })

  it('quotes the message when previews are allowed', async () => {
    seedUnreadRoom(3)

    const inbox = await renderInbox()

    expect(inbox.textContent).toContain('Maya Chen: The warmer pass is ready for another look.')
  })
})
