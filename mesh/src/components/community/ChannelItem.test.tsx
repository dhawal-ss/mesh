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

vi.mock('../../store/settings', () => ({
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
}))

import { ChannelItem } from './ChannelItem'

const channel: Channel = {
  id: '!general:example.org',
  communityId: '+mesh:example.org',
  name: 'general',
  channelType: 'text',
  unreadCount: 4,
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

  function renderItem(overrides: Partial<Channel> = {}) {
    act(() => {
      root.render(
        <ChannelItem
          channel={{ ...channel, ...overrides }}
          active={false}
          onClick={onClick}
          onMarkRead={onMarkRead}
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
    expect(button.textContent).toContain('4')
    act(() => button.click())
    expect(onClick).toHaveBeenCalledOnce()
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

  it('sets per-channel notification levels and marks the current choice', async () => {
    settingsMocks.notificationLevel = 'mentions'
    const button = renderItem()
    await openContextMenu(button)

    expect(document.body.textContent).toContain('Notifications: All messages')
    expect(document.body.textContent).toContain('Notifications: Only @mentions (selected)')
    expect(document.body.textContent).toContain('Notifications: Nothing')

    await act(async () => findMenuItem('Notifications: Nothing')?.click())
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
})
