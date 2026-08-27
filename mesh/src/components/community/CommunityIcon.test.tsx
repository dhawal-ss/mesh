import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Community } from '../../types/ipc'

const settingsMocks = vi.hoisted(() => ({
  muteCommunityFor: vi.fn(),
  unmuteCommunity: vi.fn(),
  setCommunityNotificationLevel: vi.fn(),
  isMuted: false,
  communityNotificationLevels: {} as Record<string, 'all' | 'mentions' | 'nothing'>,
}))

vi.mock('../../store/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/settings')>()
  return {
    ...actual,
    useSettingsStore: (
      selector: (state: {
        muteCommunityFor: typeof settingsMocks.muteCommunityFor
        unmuteCommunity: typeof settingsMocks.unmuteCommunity
        setCommunityNotificationLevel: typeof settingsMocks.setCommunityNotificationLevel
        isCommunityMuted: (communityId: string) => boolean
        notifications: { communityNotificationLevels: Record<string, string> }
      }) => unknown,
    ) => selector({
      muteCommunityFor: settingsMocks.muteCommunityFor,
      unmuteCommunity: settingsMocks.unmuteCommunity,
      setCommunityNotificationLevel: settingsMocks.setCommunityNotificationLevel,
      isCommunityMuted: () => settingsMocks.isMuted,
      notifications: { communityNotificationLevels: settingsMocks.communityNotificationLevels },
    }),
  }
})

import { CommunityIcon } from './CommunityIcon'

const community: Community = {
  id: '+mesh:example.org',
  name: 'Mesh Builders',
  description: 'Build together',
  avatarUrl: null,
  memberCount: 8,
  role: 'member',
  joinedAt: null,
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

describe('CommunityIcon notification context menu', () => {
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
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function renderIcon(extra: Partial<React.ComponentProps<typeof CommunityIcon>> = {}) {
    act(() => {
      root.render(
        <CommunityIcon
          community={community}
          active={false}
          unreadCount={7}
          onClick={onClick}
          onMarkRead={onMarkRead}
          onOpenNotificationSettings={onOpenNotificationSettings}
          onCopyLink={onCopyLink}
          {...extra}
        />,
      )
    })
    return container.querySelector('button')!
  }

  it('puts a number on the mention marker instead of an unexplained dot', () => {
    renderIcon({ mentionCount: 3 })

    const marker = container.querySelector('[data-rail-mention]')
    expect(marker?.textContent).toBe('3')
  })

  it('keeps the mention marker off a community that only has ordinary unreads', () => {
    renderIcon({ mentionCount: 0 })

    expect(container.querySelector('[data-rail-mention]')).toBeNull()
  })

  it('names mentions in the accessible name, not only in the marker', () => {
    const button = renderIcon({ mentionCount: 3 })

    expect(button.getAttribute('aria-label')).toContain('3 mentions')
  })

  it('caps a very large mention count so the marker stays inside the tile', () => {
    renderIcon({ mentionCount: 140 })

    expect(container.querySelector('[data-rail-mention]')?.textContent).toBe('99+')
  })

  it('shows live voice with a marker and says so in words', () => {
    const button = renderIcon({ liveVoice: true })

    expect(container.querySelector('[data-rail-live]')).not.toBeNull()
    expect(button.getAttribute('aria-label')).toContain('live voice')
  })

  /*
   * A green outline is a green outline. High contrast flattens status colour,
   * and a sighted person reading in greyscale gets nothing from it, so the
   * marker has to carry the state in where it sits, not only in its colour.
   */
  it('carries live voice in position rather than in colour alone', () => {
    renderIcon({ liveVoice: true })

    const marker = container.querySelector('[data-rail-live]')
    expect(marker?.className).toContain('bottom-0')
    expect(marker?.className).not.toContain('inset-0')
  })

  it('lets the mention marker stand alone instead of doubling the unread stub', () => {
    renderIcon({ unreadCount: 3, mentionCount: 3 })

    expect(container.querySelector('[data-rail-mention]')).not.toBeNull()
    expect(container.querySelector('.mesh-rail-unread')).toBeNull()
  })

  it('leaves a quiet community without a live voice marker', () => {
    renderIcon({ liveVoice: false })

    expect(container.querySelector('[data-rail-live]')).toBeNull()
  })

  it('preserves the accessible community button and primary navigation action', () => {
    const button = renderIcon()
    expect(button.getAttribute('aria-label')).toBe(`${community.name}, 7 unread`)
    // Unread is the short stub at the rail edge. The dot beside the tile now
    // means mentions and nothing else, so an ordinary unread does not paint one.
    expect(container.querySelector('.mesh-rail-unread')).toBeTruthy()
    expect(container.querySelector('[data-rail-mention]')).toBeNull()

    act(() => button.click())
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('supports temporary and indefinite community mutes', async () => {
    const button = renderIcon()
    await openContextMenu(button)

    await act(async () => findMenuItem('Mute for 15 minutes')?.click())
    expect(settingsMocks.muteCommunityFor).toHaveBeenCalledWith(
      community.id,
      15 * 60 * 1000,
    )

    await openContextMenu(button)
    await act(async () => findMenuItem('Mute until turned back on')?.click())
    expect(settingsMocks.muteCommunityFor).toHaveBeenCalledWith(community.id, null)
  })

  it('wires community notification settings and copy-link actions', async () => {
    const button = renderIcon()

    await openContextMenu(button)
    await act(async () => findMenuItem('Notification settings')?.click())
    expect(onOpenNotificationSettings).toHaveBeenCalledOnce()

    await openContextMenu(button)
    await act(async () => findMenuItem('Copy community link')?.click())
    expect(onCopyLink).toHaveBeenCalledOnce()
  })

  it('marks every unread room in the community as read through its callback', async () => {
    const button = renderIcon()
    await openContextMenu(button)
    await act(async () => findMenuItem('Mark community as read')?.click())
    expect(onMarkRead).toHaveBeenCalledOnce()
  })

  it('offers the same actions from the keyboard-discoverable more menu', async () => {
    renderIcon()
    const moreActions = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions for Mesh Builders"]',
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
    await act(async () => findMenuItem('Copy community link')?.click())
    expect(onCopyLink).toHaveBeenCalledOnce()
  })

  it('announces a muted community and offers to turn notifications back on', async () => {
    settingsMocks.isMuted = true
    const button = renderIcon()
    await openContextMenu(button)

    expect(button.getAttribute('aria-label')).toBe(`${community.name}, muted`)
    expect(container.querySelector('.bg-primary')).toBeNull()
    expect(document.body.textContent).not.toContain('Mute for 15 minutes')

    await act(async () => findMenuItem('Turn notifications back on')?.click())
    expect(settingsMocks.unmuteCommunity).toHaveBeenCalledWith(community.id)
  })

  it.each([
    ['Shift+F10', { key: 'F10', shiftKey: true }],
    ['the Menu key', { key: 'ContextMenu', shiftKey: false }],
  ])('opens the community menu from the keyboard with %s', async (_label, keyInit) => {
    /*
      The rail keeps one tab stop per community and the ellipsis trigger beside
      the icon carries tabIndex={-1}, so without this the pin, reorder, mute,
      mark-as-read and copy-link actions were reachable only with a mouse -- and
      reordering has no other route at all.
    */
    const button = renderIcon()
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...keyInit,
      }))
      await Promise.resolve()
    })

    expect(findMenuItem('Copy community link')).not.toBeNull()
    await act(async () => findMenuItem('Copy community link')?.click())
    expect(onCopyLink).toHaveBeenCalledOnce()
  })
})
