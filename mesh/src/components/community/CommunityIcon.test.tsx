import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Community } from '../../types/ipc'

const settingsMocks = vi.hoisted(() => ({
  muteCommunityFor: vi.fn(),
  unmuteCommunity: vi.fn(),
  isMuted: false,
}))

vi.mock('../../store/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/settings')>()
  return {
    ...actual,
    useSettingsStore: (
      selector: (state: {
        muteCommunityFor: typeof settingsMocks.muteCommunityFor
        unmuteCommunity: typeof settingsMocks.unmuteCommunity
        isCommunityMuted: (communityId: string) => boolean
      }) => unknown,
    ) => selector({
      muteCommunityFor: settingsMocks.muteCommunityFor,
      unmuteCommunity: settingsMocks.unmuteCommunity,
      isCommunityMuted: () => settingsMocks.isMuted,
    }),
  }
})

import { CommunityIcon } from './CommunityIcon'

const community: Community = {
  id: '+mesh:example.org',
  name: 'Mesh Builders',
  description: 'Build together',
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

  function renderIcon() {
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
        />,
      )
    })
    return container.querySelector('button')!
  }

  it('preserves the accessible community button and primary navigation action', () => {
    const button = renderIcon()
    expect(button.getAttribute('aria-label')).toBe(`${community.name}, 7 unread`)
    expect(container.querySelector('.bg-accent')).toBeTruthy()

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
    expect(container.querySelector('.bg-accent')).toBeNull()
    expect(document.body.textContent).not.toContain('Mute for 15 minutes')

    await act(async () => findMenuItem('Turn notifications back on')?.click())
    expect(settingsMocks.unmuteCommunity).toHaveBeenCalledWith(community.id)
  })
})
