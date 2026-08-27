import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel } from '../../types/ipc'

const settingsMocks = vi.hoisted(() => ({
  muteChannelFor: vi.fn(),
  unmuteChannel: vi.fn(),
  setChannelNotificationLevel: vi.fn(),
  isMuted: false,
  notificationLevel: 'all' as 'all' | 'mentions' | 'nothing',
}))

vi.mock('../../store/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/settings')>()
  return {
    ...actual,
    getEffectiveChannelNotificationLevel: () =>
      settingsMocks.isMuted ? 'nothing' : settingsMocks.notificationLevel,
    useSettingsStore: (
      selector: (state: {
        muteChannelFor: typeof settingsMocks.muteChannelFor
        unmuteChannel: typeof settingsMocks.unmuteChannel
        setChannelNotificationLevel: typeof settingsMocks.setChannelNotificationLevel
        isChannelMuted: (channelId: string) => boolean
        notifications: {
          channelNotificationLevels: Record<string, 'all' | 'mentions' | 'nothing'>
        }
      }) => unknown,
    ) => selector({
      muteChannelFor: settingsMocks.muteChannelFor,
      unmuteChannel: settingsMocks.unmuteChannel,
      setChannelNotificationLevel: settingsMocks.setChannelNotificationLevel,
      isChannelMuted: () => settingsMocks.isMuted,
      notifications: {
        channelNotificationLevels: {
          [channel.id]: settingsMocks.notificationLevel,
        },
      },
    }),
  }
})

import { ChannelItem } from './ChannelItem'
import { useDraftStore } from '../../store/drafts'

const channel: Channel = {
  id: '!general:example.org',
  communityId: '+mesh:example.org',
  name: 'general',
  topic: '',
  channelType: 'text',
  unreadCount: 4,
  joined: true,
}

async function openContextMenu(trigger: HTMLElement) {
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX: 24,
      clientY: 24,
    }))
    await Promise.resolve()
  })
}

function findMenuItem(label: string) {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((item) => item.textContent === label)
}

describe('ChannelItem notification context menu', () => {
  let container: HTMLDivElement
  let root: Root
  const onClick = vi.fn()
  const onMarkRead = vi.fn()
  const onMarkUnread = vi.fn()
  const onOpenNotificationSettings = vi.fn()
  const onCopyLink = vi.fn()

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    settingsMocks.isMuted = false
    settingsMocks.notificationLevel = 'all'
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function renderItem(overrides: Partial<Channel> = {}, matrixMode = false) {
    act(() => {
      root.render(
        <ChannelItem
          channel={{ ...channel, ...overrides }}
          matrixMode={matrixMode}
          active={false}
          onClick={onClick}
          onMarkRead={onMarkRead}
          onMarkUnread={onMarkUnread}
          onOpenNotificationSettings={onOpenNotificationSettings}
          onCopyLink={onCopyLink}
        />,
      )
    })
    return container.querySelector('button')!
  }

  it('keeps the room button keyboard-accessible and exposes unread state', () => {
    const button = renderItem()

    expect(button.getAttribute('aria-label')).toBe('Text room: general, 4 unread')
    /*
      The pill badge is back, as the Material 3 large badge. The zero-padded
      mono numeral it replaced belonged to a row whose leading gutter was also
      a numeral; with that gutter gone, a bare count beside a room name reads
      as part of the name.
    */
    expect(button.textContent).toContain('4')
    expect(container.querySelector('.bg-surface-container-highest')).toBeTruthy()
    expect(container.querySelector('.bg-secondary-container')).toBeNull()
    act(() => button.click())
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('reports a cleared count immediately, whatever the badge animation is doing', () => {
    const button = renderItem()
    expect(button.getAttribute('aria-label')).toBe('Text room: general, 4 unread')

    // The badge leaves through a 100ms collapse, so the visible count can
    // still be mid-exit here. The accessible name is state, not decoration,
    // and must never wait for motion.
    act(() => {
      root.render(
        <ChannelItem
          channel={{ ...channel, unreadCount: 0 }}
          active={false}
          onClick={onClick}
          onMarkRead={onMarkRead}
          onMarkUnread={onMarkUnread}
          onOpenNotificationSettings={onOpenNotificationSettings}
          onCopyLink={onCopyLink}
        />,
      )
    })

    expect(container.querySelector('button')?.getAttribute('aria-label'))
      .toBe('Text room: general')
  })

  it('offers every planned mute duration and delegates a timed mute to settings', async () => {
    const button = renderItem()
    await openContextMenu(button)

    expect(document.body.textContent).toContain('Mute for 15 minutes')
    expect(document.body.textContent).toContain('Mute for 1 hour')
    expect(document.body.textContent).toContain('Mute for 8 hours')
    expect(document.body.textContent).toContain('Mute for 24 hours')
    expect(document.body.textContent).toContain('Mute until turned back on')

    await act(async () => findMenuItem('Mute for 8 hours')?.click())
    expect(settingsMocks.muteChannelFor).toHaveBeenCalledWith(
      channel.id,
      8 * 60 * 60 * 1000,
    )
  })

  it('wires mark-read, notification settings, and copy-link actions', async () => {
    const button = renderItem()

    await openContextMenu(button)
    await act(async () => findMenuItem('Mark as read')?.click())
    expect(onMarkRead).toHaveBeenCalledOnce()

    await openContextMenu(button)
    await act(async () => findMenuItem('Notification settings')?.click())
    expect(onOpenNotificationSettings).toHaveBeenCalledOnce()

    await openContextMenu(button)
    await act(async () => findMenuItem('Copy room link')?.click())
    expect(onCopyLink).toHaveBeenCalledOnce()
  })

  it('offers the same actions from the keyboard-discoverable more menu', async () => {
    renderItem()
    const moreActions = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions for general"]',
    )
    expect(moreActions).not.toBeNull()

    await act(async () => {
      moreActions?.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }))
      await Promise.resolve()
    })
    await act(async () => findMenuItem('Mark as read')?.click())
    expect(onMarkRead).toHaveBeenCalledOnce()
  })

  it('sets per-channel notification levels and marks the current choice', async () => {
    settingsMocks.notificationLevel = 'mentions'
    const button = renderItem()
    await openContextMenu(button)

    expect(document.body.textContent).toContain('Notifications: all messages')
    expect(document.body.textContent).toContain('Notifications: only @mentions (selected)')
    expect(document.body.textContent).toContain('Notifications: nothing')

    await act(async () => findMenuItem('Notifications: nothing')?.click())
    expect(settingsMocks.setChannelNotificationLevel).toHaveBeenCalledWith(
      channel.id,
      'nothing',
    )
  })

  it('suppresses the unread badge while muted but still allows mark-read', async () => {
    settingsMocks.isMuted = true
    const button = renderItem()
    await openContextMenu(button)

    expect(button.getAttribute('aria-label')).toContain('muted')
    expect(button.getAttribute('aria-label')).not.toContain('unread')
    expect(button.textContent).not.toContain('4')
    expect(findMenuItem('Mark as read')?.getAttribute('data-disabled')).toBeNull()
    expect(document.body.textContent).not.toContain('Mute for 15 minutes')

    await act(async () => findMenuItem('Turn notifications back on')?.click())
    expect(settingsMocks.unmuteChannel).toHaveBeenCalledWith(channel.id)
  })

  it('keeps mention-only SDK unread state visible', () => {
    const button = renderItem({ unreadCount: 0, unreadMentions: 2 })

    expect(button.getAttribute('aria-label')).toContain('2 mentions')
    expect(button.textContent).toContain('2')
  })

  it('surfaces an explicit mark-unread with no message count as its own state', () => {
    const button = renderItem({ unreadCount: 0, unreadMentions: 0, unreadMarked: true })

    expect(button.getAttribute('aria-label')).toBe('Text room: general, marked unread')
    expect(container.querySelector('[data-unread-marker]')).toBeTruthy()
  })

  it('offers mark-as-unread only while the room is fully read, and mark-as-read only while it is not', async () => {
    const unread = renderItem()
    await openContextMenu(unread)
    expect(findMenuItem('Mark as read')?.getAttribute('data-disabled')).toBeNull()
    expect(findMenuItem('Mark as unread')?.getAttribute('data-disabled')).not.toBeNull()

    const read = renderItem({ unreadCount: 0, unreadMentions: 0 })
    await openContextMenu(read)
    expect(findMenuItem('Mark as read')?.getAttribute('data-disabled')).not.toBeNull()
    expect(findMenuItem('Mark as unread')?.getAttribute('data-disabled')).toBeNull()

    await act(async () => findMenuItem('Mark as unread')?.click())
    expect(onMarkUnread).toHaveBeenCalledOnce()
  })

  it('mutes an unmuted Matrix room through the push-rule path', async () => {
    const button = renderItem({}, true)
    await openContextMenu(button)

    expect(document.body.textContent).not.toContain('Mute for 15 minutes')
    await act(async () => findMenuItem('Mute notifications')?.click())
    expect(settingsMocks.setChannelNotificationLevel).toHaveBeenCalledWith(
      channel.id,
      'nothing',
    )
    expect(settingsMocks.muteChannelFor).not.toHaveBeenCalled()
  })

  it('unmutes a muted Matrix room through the push-rule path', async () => {
    settingsMocks.notificationLevel = 'nothing'
    const button = renderItem({}, true)
    await openContextMenu(button)

    expect(document.body.textContent).not.toContain('Mute for 15 minutes')
    expect(document.body.textContent).not.toContain('Mute notifications')
    await act(async () => findMenuItem('Turn notifications back on')?.click())
    expect(settingsMocks.setChannelNotificationLevel).toHaveBeenCalledWith(
      channel.id,
      'all',
    )
    expect(settingsMocks.unmuteChannel).not.toHaveBeenCalled()
  })
})

describe('ChannelItem room management', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    settingsMocks.isMuted = false
    settingsMocks.notificationLevel = 'all'
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function renderManaged(props: {
    canManage: boolean
    onRename?: () => void
    onRemove?: () => void
  }) {
    act(() => {
      root.render(
        <ChannelItem
          channel={channel}
          matrixMode
          active={false}
          onClick={vi.fn()}
          onMarkRead={vi.fn()}
          onMarkUnread={vi.fn()}
          onOpenNotificationSettings={vi.fn()}
          onCopyLink={vi.fn()}
          canManage={props.canManage}
          onRename={props.onRename}
          onRemove={props.onRemove}
        />,
      )
    })
    return container.querySelector<HTMLElement>('button[data-room-id]')!
  }

  it('offers rename and remove to someone who can manage rooms', async () => {
    /*
      Community settings tells administrators to manage each room from this
      menu. Before this the menu was mark-read, mute, three notification
      levels, notification settings and copy link, so the instruction pointed
      at actions that did not exist.
    */
    const onRename = vi.fn()
    const onRemove = vi.fn()
    const trigger = renderManaged({ canManage: true, onRename, onRemove })
    await openContextMenu(trigger)

    expect(findMenuItem('Rename room')).toBeTruthy()
    expect(findMenuItem('Remove room')).toBeTruthy()

    await act(async () => findMenuItem('Rename room')?.click())
    expect(onRename).toHaveBeenCalledTimes(1)
  })

  it('hides both from someone who cannot manage rooms', async () => {
    const trigger = renderManaged({ canManage: false, onRename: vi.fn(), onRemove: vi.fn() })
    await openContextMenu(trigger)

    expect(findMenuItem('Rename room')).toBeUndefined()
    expect(findMenuItem('Remove room')).toBeUndefined()
    // The rest of the menu is unaffected.
    expect(findMenuItem('Copy room link')).toBeTruthy()
  })

  it('marks removal as destructive rather than an ordinary entry', async () => {
    const trigger = renderManaged({ canManage: true, onRename: vi.fn(), onRemove: vi.fn() })
    await openContextMenu(trigger)

    expect(findMenuItem('Remove room')?.className).toContain('text-error')
    expect(findMenuItem('Rename room')?.className).not.toContain('text-error')
  })
})

describe('ChannelItem for a room this account has not joined', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    settingsMocks.isMuted = false
    settingsMocks.notificationLevel = 'all'
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const unjoined: Channel = { ...channel, unreadCount: 0, joined: false }

  function renderUnjoined(props: { joining?: boolean; onClick?: () => void } = {}) {
    act(() => {
      root.render(
        <ChannelItem
          channel={unjoined}
          matrixMode
          active={false}
          onClick={props.onClick ?? vi.fn()}
          joining={props.joining}
          onMarkRead={vi.fn()}
          onMarkUnread={vi.fn()}
          onOpenNotificationSettings={vi.fn()}
          onCopyLink={vi.fn()}
          onHide={vi.fn()}
        />,
      )
    })
    return container.querySelector<HTMLElement>('button[data-room-id]')!
  }

  it('says the room is not joined in words, not only in colour', () => {
    const trigger = renderUnjoined()

    expect(trigger.textContent).toContain('Join')
    expect(trigger.getAttribute('aria-label')).toContain('not joined yet')
  })

  it('offers only what works before joining', async () => {
    /*
      Marking read, muting, and renaming all need membership this account does
      not have, and the backend refuses each one. A menu that listed them would
      be offering actions that cannot succeed.
    */
    const trigger = renderUnjoined()
    await openContextMenu(trigger)

    expect(findMenuItem('Copy room link')).toBeTruthy()
    expect(findMenuItem('Hide from sidebar')).toBeTruthy()
    expect(findMenuItem('Mark as read')).toBeUndefined()
    expect(findMenuItem('Mute notifications')).toBeUndefined()
    expect(findMenuItem('Notification settings')).toBeUndefined()
  })

  it('suppresses a second join while one is in flight', () => {
    const onClick = vi.fn()
    const trigger = renderUnjoined({ joining: true, onClick })

    expect(trigger.textContent).toContain('Joining')
    expect(trigger.getAttribute('aria-label')).toContain('joining')
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    trigger.click()
    expect(onClick).not.toHaveBeenCalled()
  })

  it("leaves a joined room row exactly as it was", () => {
    act(() => {
      root.render(
        <ChannelItem
          channel={channel}
          matrixMode
          active={false}
          onClick={vi.fn()}
          onMarkRead={vi.fn()}
          onMarkUnread={vi.fn()}
          onOpenNotificationSettings={vi.fn()}
          onCopyLink={vi.fn()}
        />,
      )
    })
    const trigger = container.querySelector<HTMLElement>('button[data-room-id]')!

    expect(trigger.textContent).not.toContain('Join')
    expect(trigger.getAttribute('aria-label')).not.toContain('not joined')
    expect((trigger as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('ChannelItem draft marker', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useDraftStore.setState({ drafts: {} })
    settingsMocks.isMuted = false
    settingsMocks.notificationLevel = 'all'
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useDraftStore.setState({ drafts: {} })
  })

  function renderRow(overrides: Partial<Channel> = {}, active = false) {
    act(() => {
      root.render(
        <ChannelItem
          channel={{ ...channel, ...overrides }}
          matrixMode
          active={active}
          onClick={vi.fn()}
          onMarkRead={vi.fn()}
          onMarkUnread={vi.fn()}
          onOpenNotificationSettings={vi.fn()}
          onCopyLink={vi.fn()}
        />,
      )
    })
    return container.querySelector<HTMLElement>('button[data-room-id]')!
  }

  it('marks a room holding an unsent draft', () => {
    useDraftStore.getState().setDraft(channel.id, 'half a thought')

    const row = renderRow()

    expect(row.textContent).toContain('Draft')
  })

  it('names the unsent draft for assistive technology', () => {
    useDraftStore.getState().setDraft(channel.id, 'half a thought')

    const row = renderRow()

    expect(row.getAttribute('aria-label')).toContain('unsent draft')
  })

  it('leaves a room with no draft unmarked', () => {
    const row = renderRow()

    expect(row.textContent).not.toContain('Draft')
    expect(row.getAttribute('aria-label')).not.toContain('unsent draft')
  })

  it('treats whitespace as no draft at all', () => {
    useDraftStore.getState().setDraft(channel.id, '   \n  ')

    const row = renderRow()

    expect(row.textContent).not.toContain('Draft')
  })

  it('leaves exactly one element claiming the trailing space', () => {
    useDraftStore.getState().setDraft(channel.id, 'half a thought')

    const row = renderRow({ unreadCount: 4 })

    const claimants = Array.from(row.querySelectorAll('*'))
      .filter((node) => node.className.toString().split(/\s+/).includes('ml-auto'))
    expect(claimants).toHaveLength(1)
  })

  it('drops the marker on the room you are already reading', () => {
    useDraftStore.getState().setDraft(channel.id, 'half a thought')

    const row = renderRow({}, true)

    expect(row.textContent).not.toContain('Draft')
  })

  /*
    A draft outlives the membership that produced it, so an unjoined room can
    carry one. The marker is suppressed there, and the badges have to know that
    -- they give up `ml-auto` to the marker, and would otherwise give it up to
    nothing and bunch against the room name.
  */
  it('leaves the unread badge holding the spacer when an unjoined room has a draft', () => {
    useDraftStore.getState().setDraft(channel.id, 'half a thought')

    const row = renderRow({ joined: false, unreadCount: 3 })

    expect(row.textContent).not.toContain('Draft')
    const badge = row.querySelector('.badge-count')
    expect(badge?.className).toContain('ml-auto')
  })
})
