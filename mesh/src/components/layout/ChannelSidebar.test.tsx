import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../community/ChannelItem', () => ({
  ChannelItem: ({
    channel,
    active,
    tabIndex,
    onFocus,
    onOpenNotificationSettings,
    isPinned,
    onPin,
    onUnpin,
    canMoveUp,
    onMoveUp,
    canMoveDown,
    onMoveDown,
    isHidden,
    onHide,
    onUnhide,
    onRename,
    onClick,
    joining,
  }: {
    channel: { id: string; name: string; channelType: string; joined?: boolean }
    active: boolean
    tabIndex: number
    onFocus: () => void
    onOpenNotificationSettings: () => void
    isPinned?: boolean
    onPin?: () => void
    onUnpin?: () => void
    canMoveUp?: boolean
    onMoveUp?: () => void
    canMoveDown?: boolean
    onMoveDown?: () => void
    isHidden?: boolean
    onHide?: () => void
    onUnhide?: () => void
    onRename?: () => void
    onClick?: () => void
    joining?: boolean
  }) => (
    <>
      <button
        type="button"
        data-room-id={channel.id}
        data-pinned={isPinned ? 'true' : undefined}
        data-hidden-row={isHidden ? 'true' : undefined}
        aria-current={active ? 'page' : undefined}
        tabIndex={tabIndex}
        onFocus={onFocus}
        onClick={onClick}
        data-joining={joining ? 'true' : undefined}
        data-unjoined={channel.joined === false ? 'true' : undefined}
        aria-label={`${channel.channelType} room: ${channel.name}`}
      >
        {channel.name}
      </button>
      {/* Stand-ins for the room menu items, which the real ChannelItem owns. */}
      <button
        type="button"
        data-notification-room={channel.id}
        onClick={onOpenNotificationSettings}
      >
        Notification settings
      </button>
      {onPin && (
        <button type="button" data-pin-room={channel.id} onClick={isPinned ? onUnpin : onPin}>
          {isPinned ? 'Unpin' : 'Pin'}
        </button>
      )}
      {onMoveUp && (
        <button
          type="button"
          data-move-up={channel.id}
          disabled={!canMoveUp}
          onClick={onMoveUp}
        >
          Move up
        </button>
      )}
      {onMoveDown && (
        <button
          type="button"
          data-move-down={channel.id}
          disabled={!canMoveDown}
          onClick={onMoveDown}
        >
          Move down
        </button>
      )}
      {onHide && (
        <button type="button" data-hide-room={channel.id} onClick={onHide}>
          Hide
        </button>
      )}
      {onUnhide && (
        <button type="button" data-unhide-room={channel.id} onClick={onUnhide}>
          Unhide
        </button>
      )}
      {onRename && (
        <button type="button" data-settings-room={channel.id} onClick={onRename}>
          Room settings
        </button>
      )}
    </>
  ),
}))

vi.mock('./UserPanel', () => ({
  UserPanel: () => <div>User controls</div>,
}))

vi.mock('../../hooks/useMatrixRtcMembershipSync', () => ({
  useMatrixRtcMembershipSync: () => undefined,
}))

import * as bridge from '../../lib/bridge'
import { currentMeshRoute } from '../../lib/mesh-navigation'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useMeshNavigationStore } from '../../store/navigation'
import { useNetworkStore } from '../../store/network'
import { useRoomOrganizationStore } from '../../store/room-organization'
import { textOrderScopeKey } from '../../lib/room-organization'
import type { Channel } from '../../types/ipc'
import { ChannelSidebar } from './ChannelSidebar'

function room(index: number): Channel {
  return {
    id: `room-${index}`,
    communityId: 'community-1',
    name: `Room ${index}`,
    topic: '',
    channelType: 'text',
    unreadCount: 0,
    joined: true,
  }
}

describe('ChannelSidebar room containment', () => {
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
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    useCommunityStore.getState().setCommunities([{
      id: 'community-1',
      name: 'Large community',
      description: '',
      avatarUrl: null,
      memberCount: 5_000,
      role: 'owner',
      joinedAt: '2026-07-29T12:00:00.000Z',
    }])
    useChannelStore.getState().setChannels([])
    useChannelStore.setState({ refreshByCommunity: {} })
    useIdentityStore.setState({
      identity: {
        publicKey: '@me:example.org',
        displayName: 'Me',
        avatarColor: '#3ba55d',
      },
      isLoading: false,
    })
    useNetworkStore.setState({
      status: {
        state: 'connected',
        peerCount: 1,
        averageLatency: 1,
      },
    })
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
    vi.spyOn(bridge, 'getBackendStatusSnapshot').mockReturnValue(null)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue(null)
    localStorage.clear()
    useRoomOrganizationStore.getState().resetForAccountTransition()
    useRoomOrganizationStore.getState().initialize('@me:example.org')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.querySelectorAll('[data-radix-portal]').forEach((portal) => portal.remove())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps a 5,000-room community within a bounded ordered DOM', async () => {
    useChannelStore.getState().setChannels(
      Array.from({ length: 5_000 }, (_, index) => room(index)),
    )

    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    // The virtualized room navigation is now one keyboard stop with roving room buttons.
    const list = container.querySelector('[role="navigation"][aria-label="Community rooms"]')
    expect(list).not.toBeNull()
    expect(list?.querySelectorAll('button[data-room-id]').length).toBeGreaterThan(0)
    expect(list?.querySelectorAll('button[data-room-id]').length).toBeLessThan(100)
    expect(list?.querySelector('button[aria-label="text room: Room 0"]')).not.toBeNull()
    // Non-collapsible section labels are the shared `SectionHeader`, which
    // exposes its heading with role and aria-level rather than an `h3` element.
    expect(list?.querySelector('[role="heading"][aria-level="3"]')?.textContent).toContain('Rooms')

    await act(async () => {
      if (list instanceof HTMLElement) list.scrollTop = 180_032
      list?.dispatchEvent(new Event('scroll', { bubbles: true }))
      await Promise.resolve()
    })
    const finalRoom = list?.querySelector<HTMLButtonElement>(
      'button[aria-label="text room: Room 4999"]',
    )
    expect(finalRoom).not.toBeNull()
    finalRoom?.focus()
    expect(document.activeElement).toBe(finalRoom)
  })

  it('never presents the account service as community metadata', async () => {
    useCommunityStore.getState().setCommunities([{
      id: '!canyon:community.example',
      name: 'Canyon Crew',
      description: '',
      avatarUrl: null,
      memberCount: 42,
      role: 'owner',
      joinedAt: '2026-07-29T12:00:00.000Z',
    }])
    useChannelStore.getState().setChannels([{
      ...room(1),
      id: '!lobby:community.example',
      communityId: '!canyon:community.example',
      name: 'Lobby',
    }])
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    vi.mocked(bridge.getMatrixUserId).mockReturnValue('@me:accounts.example')
    vi.mocked(bridge.getBackendStatusSnapshot).mockReturnValue({
      authenticated: true,
      userId: '@me:accounts.example',
      homeserver: 'https://accounts.example',
    } as bridge.BackendStatus)

    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    const header = container.querySelector('.mesh-community-header')
    expect(header?.textContent).toContain('Canyon Crew')
    expect(header?.textContent).toContain('42 members')
    expect(header?.textContent).not.toContain('accounts.example')
    expect(header?.textContent).not.toContain('community.example')
  })

  it('uses roving focus, arrow keys, Home/End, and type-ahead', async () => {
    useChannelStore.getState().setChannels([
      { ...room(1), name: 'Alpha' },
      { ...room(2), name: 'Beta' },
      { ...room(3), name: 'Gamma' },
    ])
    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    const options = [...container.querySelectorAll<HTMLButtonElement>('button[data-room-id]')]
    expect(options.filter((option) => option.tabIndex === 0)).toHaveLength(1)
    options[0]?.focus()
    await act(async () => {
      options[0]?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(document.activeElement?.textContent).toBe('Beta')
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'End',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(document.activeElement?.textContent).toBe('Gamma')
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(document.activeElement?.textContent).toBe('Alpha')
  })

  it('pins a room to the top, keeping its relative order among other pinned rooms', async () => {
    useChannelStore.getState().setChannels([
      { ...room(1), name: 'Alpha' },
      { ...room(2), name: 'Beta' },
      { ...room(3), name: 'Gamma' },
    ])
    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    const roomNames = () => [...container.querySelectorAll<HTMLButtonElement>('button[data-room-id]')]
      .map((button) => button.textContent)

    expect(roomNames()).toEqual(['Alpha', 'Beta', 'Gamma'])

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-pin-room="room-3"]')?.click()
    })
    expect(roomNames()).toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(
      container.querySelector('button[data-room-id="room-3"]')?.getAttribute('data-pinned'),
    ).toBe('true')

    // A second pin is membership only: the pinned band's relative order comes
    // from the base list (Alpha before Gamma there), not from click order, so
    // pinning Alpha second still puts it ahead of the already-pinned Gamma.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-pin-room="room-1"]')?.click()
    })
    expect(roomNames()).toEqual(['Alpha', 'Gamma', 'Beta'])

    // Unpinning Gamma (clicking its now-"Unpin" button) drops it back into
    // the unpinned band, leaving Alpha the only pinned room.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-pin-room="room-3"]')?.click()
    })
    expect(roomNames()).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('moves a room within its band without crossing into the pinned band', async () => {
    useChannelStore.getState().setChannels([
      { ...room(1), name: 'Alpha' },
      { ...room(2), name: 'Beta' },
      { ...room(3), name: 'Gamma' },
    ])
    useRoomOrganizationStore.getState().pin(textOrderScopeKey('community-1'), 'room-1')
    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    const roomNames = () => [...container.querySelectorAll<HTMLButtonElement>('button[data-room-id]')]
      .map((button) => button.textContent)
    expect(roomNames()).toEqual(['Alpha', 'Beta', 'Gamma'])

    // The pinned room is the only member of its band, so its own move
    // buttons are disabled rather than offering a click that does nothing.
    const alphaMoveUp = container.querySelector<HTMLButtonElement>('button[data-move-up="room-1"]')
    expect(alphaMoveUp?.disabled).toBe(true)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-move-down="room-2"]')?.click()
    })
    // Beta and Gamma (the unpinned band) swap; Alpha stays pinned at the top.
    expect(roomNames()).toEqual(['Alpha', 'Gamma', 'Beta'])

    const gammaMoveUp = container.querySelector<HTMLButtonElement>('button[data-move-up="room-3"]')
    // Gamma is now first in the unpinned band, so moving it up further would
    // be a no-op: the button is disabled rather than offering that click.
    expect(gammaMoveUp?.disabled).toBe(true)
    await act(async () => {
      gammaMoveUp?.click()
    })
    expect(roomNames()).toEqual(['Alpha', 'Gamma', 'Beta'])
  })

  it('hides a room into a collapsed tray and back out, without touching the store data', async () => {
    useChannelStore.getState().setChannels([
      { ...room(1), name: 'Alpha' },
      { ...room(2), name: 'Beta' },
    ])
    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    const roomNames = () => [...container.querySelectorAll<HTMLButtonElement>('button[data-room-id]')]
      .map((button) => button.textContent)
    expect(roomNames()).toEqual(['Alpha', 'Beta'])

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-hide-room="room-2"]')?.click()
      await Promise.resolve()
    })

    // Hiding removes the room from the main list but never from the channel
    // store: nothing about the room itself, including its unread state, is
    // touched by a local sidebar preference.
    expect(roomNames()).toEqual(['Alpha'])
    expect(useChannelStore.getState().channelEntities['room-2']).toBeDefined()

    const trayToggle = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('hidden room'))
    expect(trayToggle).toBeTruthy()
    expect(trayToggle?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      trayToggle?.click()
      await Promise.resolve()
    })
    expect(trayToggle?.getAttribute('aria-expanded')).toBe('true')
    expect(
      container.querySelector('button[data-room-id="room-2"][data-hidden-row="true"]'),
    ).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-unhide-room="room-2"]')?.click()
      await Promise.resolve()
    })
    expect(roomNames()).toEqual(['Alpha', 'Beta'])
  })

  it('opens invitation options before creating or copying a link', async () => {
    useChannelStore.getState().setChannels([{ ...room(1), name: 'Welcome' }])
    const generateInviteLink = vi.spyOn(bridge, 'generateInviteLink')

    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    const inviteButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Invite')
    expect(inviteButton).toBeDefined()

    await act(async () => {
      inviteButton?.click()
      await vi.dynamicImportSettled()
    })

    expect(generateInviteLink).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Invite to Large community')
    expect(document.body.textContent).toContain('Share a private invitation')
    expect(document.body.textContent).toContain('Create invite link')
  })

  it('shows placeholder rows while the first room refresh is still running', async () => {
    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    const loading = container.querySelector('[role="status"]')
    expect(loading?.textContent).toContain('Loading rooms')
    expect(loading?.querySelectorAll('.mesh-skeleton').length).toBeGreaterThan(0)
    // A community that is still loading must never be described as empty.
    expect(container.textContent).not.toContain('No rooms yet')
  })

  it('names an empty community once the refresh settles, and never alongside a failure', async () => {
    useChannelStore.getState().setCommunityRefresh('community-1', {
      status: 'loaded',
      error: null,
      generation: 1,
    })

    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('No rooms yet')
    expect(container.textContent).not.toContain('Loading rooms')

    const create = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Create a room')
    await act(async () => create?.click())
    expect(currentMeshRoute(useMeshNavigationStore.getState())).toEqual({
      kind: 'community-admin',
      communityId: 'community-1',
      section: 'rooms-voice',
    })

    await act(async () => {
      useChannelStore.getState().setCommunityRefresh('community-1', {
        status: 'failed',
        error: new Error('unreachable'),
        generation: 2,
      })
      await Promise.resolve()
    })

    // Two contradictory explanations of the same blank column is worse than one.
    expect(container.textContent).toContain('Rooms could not be loaded.')
    expect(container.textContent).not.toContain('No rooms yet')
  })

  it('offers no room creation to a member who cannot create one', async () => {
    useCommunityStore.getState().patchCommunity('community-1', { role: 'member' })
    useChannelStore.getState().setCommunityRefresh('community-1', {
      status: 'loaded',
      error: null,
      generation: 1,
    })

    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('No rooms yet')
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'Create a room'),
    ).toBe(false)
  })

  it('opens notification settings on the notifications section, not on whatever opens first', async () => {
    useChannelStore.getState().setChannels([{ ...room(1), name: 'Welcome' }])

    await act(async () => {
      root.render(<ChannelSidebar />)
      await Promise.resolve()
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-notification-room]')?.click()
    })

    expect(currentMeshRoute(useMeshNavigationStore.getState())).toEqual({
      kind: 'you',
      section: 'notifications',
    })
  })

  /*
    Rooms created after this account joined the community. Nothing joins an
    existing member to a new room, so these arrive unjoined, and before this
    they were dropped from the listing and counted as rooms Mesh could not open.
  */
  describe('a room this account has not joined', () => {
    const unjoined = (): Channel => ({ ...room(7), name: 'raid-planning', joined: false })

    async function renderWithUnjoinedRoom() {
      useChannelStore.getState().setChannels([room(1), unjoined()])
      await act(async () => {
        root.render(<ChannelSidebar />)
        await Promise.resolve()
      })
      return container.querySelector<HTMLButtonElement>('button[data-room-id="room-7"]')!
    }

    it('lists it as a room, marked unjoined, rather than hiding it', async () => {
      const row = await renderWithUnjoinedRoom()

      expect(row).not.toBeNull()
      expect(row.dataset.unjoined).toBe('true')
    })

    it('joins on click, records the joined room, and opens it', async () => {
      const joinCommunityChannel = vi
        .spyOn(bridge, 'joinCommunityChannel')
        .mockResolvedValue({ ...unjoined(), joined: true })
      const row = await renderWithUnjoinedRoom()

      await act(async () => {
        row.click()
        await Promise.resolve()
      })

      expect(joinCommunityChannel).toHaveBeenCalledWith('community-1', 'room-7')
      // Written from the response rather than waiting for the next listing, so
      // the row stops offering a join it has already performed.
      expect(useChannelStore.getState().channelEntities['room-7'].joined).toBe(true)
      expect(useChannelStore.getState().activeChannelId).toBe('room-7')
      expect(currentMeshRoute(useMeshNavigationStore.getState())).toEqual({
        kind: 'room',
        communityId: 'community-1',
        roomId: 'room-7',
      })
    })

    it('leaves the room unjoined and selects nothing when the join fails', async () => {
      vi.spyOn(bridge, 'joinCommunityChannel').mockRejectedValue(new Error('nope'))
      const row = await renderWithUnjoinedRoom()

      await act(async () => {
        row.click()
        await Promise.resolve()
      })

      expect(useChannelStore.getState().channelEntities['room-7'].joined).toBe(false)
      expect(useChannelStore.getState().activeChannelId).not.toBe('room-7')
    })

    it('sends one join for a double click', async () => {
      const joinCommunityChannel = vi
        .spyOn(bridge, 'joinCommunityChannel')
        .mockImplementation(() => new Promise(() => {}))
      const row = await renderWithUnjoinedRoom()

      await act(async () => {
        row.click()
        await Promise.resolve()
      })
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[data-room-id="room-7"]')?.click()
        await Promise.resolve()
      })

      expect(joinCommunityChannel).toHaveBeenCalledTimes(1)
      expect(
        container.querySelector<HTMLButtonElement>('button[data-room-id="room-7"]')?.dataset.joining,
      ).toBe('true')
    })
  })

  /*
    Room settings, which was a rename-only dialog. `m.room.topic` was writable
    through `updateChannel` from the day it existed and no UI ever passed one,
    so every room description was permanently empty.
  */
  describe('room settings', () => {
    async function openSettings(channel: Channel) {
      useChannelStore.getState().setChannels([channel])
      await act(async () => {
        root.render(<ChannelSidebar />)
        await Promise.resolve()
      })
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[data-settings-room]')?.click()
      })
    }

    function textareaFor(label: string): HTMLTextAreaElement {
      const field = [...document.body.querySelectorAll<HTMLLabelElement>('label')]
        .find((candidate) => candidate.textContent?.trim().startsWith(label))
      const element = field?.htmlFor ? document.getElementById(field.htmlFor) : null
      if (!(element instanceof HTMLTextAreaElement)) throw new Error(`No textarea for ${label}`)
      return element
    }

    function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }

    function findButton(label: string): HTMLButtonElement {
      const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent?.trim() === label)
      if (!button) throw new Error(`Button not found: ${label}`)
      return button
    }

    it('writes a description and keeps it on the room', async () => {
      const updateChannel = vi.spyOn(bridge, 'updateChannel').mockResolvedValue({
        ...room(1),
        topic: 'Reference and work in progress.',
      })
      await openSettings({ ...room(1), name: 'concept-art', topic: '' })

      await act(async () => {
        setValue(textareaFor('Description'), 'Reference and work in progress.')
      })
      await act(async () => {
        findButton('Save room').click()
        await Promise.resolve()
      })

      /*
        Only the changed field goes on the wire. update_channel writes one state
        event per field it receives, so resending an unchanged name would put an
        m.room.name event that changes nothing into every member's timeline.
      */
      expect(updateChannel).toHaveBeenCalledWith('community-1', 'room-1', {
        topic: 'Reference and work in progress.',
      })
      expect(useChannelStore.getState().channelEntities['room-1'].topic)
        .toBe('Reference and work in progress.')
    })

    it('clears a description that was set, rather than treating empty as no change', async () => {
      /*
        The case a person hits when they decide the description was wrong.
        `topicChanged` compares against the trimmed current value, so emptying
        the field sends `{ topic: '' }`; `update_channel`'s "must change
        something" guard is `name.is_none() && topic.is_none()`, which
        `Some("")` passes, and `normalize_optional_metadata` returns `""` for
        whitespace instead of refusing it the way an empty name is refused.
      */
      const updateChannel = vi.spyOn(bridge, 'updateChannel').mockResolvedValue({
        ...room(1),
        topic: '',
      })
      await openSettings({ ...room(1), name: 'concept-art', topic: 'Was wrong.' })

      await act(async () => setValue(textareaFor('Description'), ''))
      await act(async () => {
        findButton('Save room').click()
        await Promise.resolve()
      })

      expect(updateChannel).toHaveBeenCalledWith('community-1', 'room-1', { topic: '' })
      expect(useChannelStore.getState().channelEntities['room-1'].topic).toBe('')
    })

    it('sends nothing when neither the name nor the description changed', async () => {
      const updateChannel = vi.spyOn(bridge, 'updateChannel')
      await openSettings({ ...room(1), name: 'concept-art', topic: 'Unchanged.' })

      await act(async () => {
        findButton('Save room').click()
        await Promise.resolve()
      })

      expect(updateChannel).not.toHaveBeenCalled()
    })

    it('prefills both fields from the room rather than starting empty', async () => {
      await openSettings({ ...room(1), name: 'concept-art', topic: 'Already set.' })

      expect(textareaFor('Description').value).toBe('Already set.')
      const nameInput = [...document.body.querySelectorAll<HTMLInputElement>('input')]
        .find((candidate) => candidate.value === 'concept-art')
      expect(nameInput).toBeDefined()
    })
  })
})
