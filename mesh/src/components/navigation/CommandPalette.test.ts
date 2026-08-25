import { Fragment, act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandPalette,
  RECENT_GROUP_SIZE,
  accountServiceContext,
  filterPaletteOptions,
  isEditableTarget,
  nextCyclicIndex,
  parsePaletteQuery,
  sortCommandsByActivity,
  sortCommandsByRecency,
  withRecentGroup,
} from './CommandPalette'
import { COMMAND_PALETTE_OPEN_EVENT } from '../../lib/command-palette'
import { useChannelStore } from '../../store/channels'
import { useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { useVoiceStore } from '../../store/voice'
import { ToastContainer } from '../ui/Toast'
import type { Channel } from '../../types/ipc'
import * as bridge from '../../lib/bridge'

let mountedRoot: ReturnType<typeof createRoot> | null = null
let mountedContainer: HTMLDivElement | null = null

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount())
  mountedContainer?.remove()
  mountedRoot = null
  mountedContainer = null
  document.querySelectorAll('[data-radix-portal]').forEach((portal) => portal.remove())
  window.localStorage.clear()
  useVoiceStore.getState().resetVoiceState()
  vi.restoreAllMocks()
})

describe('command palette helpers', () => {
  it('moves valid recent commands to the front without losing base order', () => {
    const commands = [
      { id: 'one', label: 'One', keywords: [], run: () => {} },
      { id: 'two', label: 'Two', keywords: [], run: () => {} },
      { id: 'three', label: 'Three', keywords: [], run: () => {} },
    ]

    expect(sortCommandsByRecency(commands, ['three', 'missing', 'one']).map(({ id }) => id))
      .toEqual(['three', 'one', 'two'])
  })

  it('recognizes editable keyboard targets', () => {
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true)
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    expect(isEditableTarget(editable)).toBe(true)
  })

  it('cycles navigation in both directions and starts at the nearest edge', () => {
    expect(nextCyclicIndex(-1, 3, 1)).toBe(0)
    expect(nextCyclicIndex(-1, 3, -1)).toBe(2)
    expect(nextCyclicIndex(2, 3, 1)).toBe(0)
    expect(nextCyclicIndex(0, 3, -1)).toBe(2)
  })

  it('parses and applies sigil scopes before deterministic fuzzy ranking', () => {
    const options = [
      { value: 'channel:general', label: 'general', keywords: ['Mesh HQ'] },
      { value: 'server:mesh', label: 'Mesh HQ', keywords: ['community'] },
      { value: 'dm:ana', label: 'Ana', keywords: ['example.org'] },
      { value: 'person:alex', label: 'Alex', keywords: ['example.net'] },
    ]

    expect(parsePaletteQuery('  # gen')).toEqual({ scope: 'rooms', term: 'gen' })
    expect(filterPaletteOptions(options, '# gen').map(({ value }) => value))
      .toEqual(['channel:general'])
    expect(filterPaletteOptions(options, '@ a').map(({ value }) => value))
      .toEqual(['dm:ana', 'person:alex'])
    expect(filterPaletteOptions(options, '* mesh').map(({ value }) => value))
      .toEqual(['server:mesh'])
  })

  it('offers the last three commands back while the palette is still empty', () => {
    const options = [
      { value: 'channel:general', label: 'general', group: 'Rooms' },
      { value: 'server:mesh', label: 'Mesh HQ', group: 'Communities' },
      { value: 'dm:ana', label: 'Ana', group: 'Messages' },
      { value: 'person:alex', label: 'Alex', group: 'People' },
    ]
    const recents = ['dm:ana', 'person:alex', 'server:mesh', 'channel:general']

    const empty = withRecentGroup(options, recents, '')
    expect(empty.slice(0, RECENT_GROUP_SIZE).map(({ value, group }) => [value, group]))
      .toEqual([
        ['dm:ana', 'Recent'],
        ['person:alex', 'Recent'],
        ['server:mesh', 'Recent'],
      ])
    // The fourth recent keeps its own taxonomy heading, and nothing is listed
    // twice.
    expect(empty.map(({ value }) => value)).toHaveLength(options.length)
    expect(empty[3]).toEqual({ value: 'channel:general', label: 'general', group: 'Rooms' })

    // Once there is a query, the ranked match is the answer.
    expect(withRecentGroup(options, recents, 'ana')).toEqual(options)
    expect(withRecentGroup(options, [], '')).toEqual(options)
    expect(withRecentGroup(options, ['channel:missing'], '')).toEqual(options)
  })

  it('sorts the bounded empty state by activity with stable ties', () => {
    const commands = [
      { id: 'one', activityRank: 1 },
      { id: 'two', activityRank: 3 },
      { id: 'three', activityRank: 3 },
    ]
    expect(sortCommandsByActivity(commands).map(({ id }) => id))
      .toEqual(['two', 'three', 'one'])
  })

  it('uses neutral account-service wording', () => {
    expect(accountServiceContext('@ana:example.org'))
      .toBe('Account service: example.org')
    expect(accountServiceContext('legacy-key')).toBeNull()
  })

  it('opens from the global Ctrl+K shortcut', () => {
    mountedContainer = document.createElement('div')
    document.body.appendChild(mountedContainer)
    mountedRoot = createRoot(mountedContainer)
    act(() => mountedRoot?.render(createElement(CommandPalette)))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }))
    })

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('input[role="combobox"]')).not.toBeNull()
  })

  describe('messaging an address that is not in any shared community', () => {
    // These type into the field, so React updates have to flush inside act().
    // The rest of this file only inspects what a first render produced.
    beforeEach(() => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
      // The directory search debounces, so its tests drive the clock.
      vi.useFakeTimers({ shouldAdvanceTime: true })
    })
    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    function openPalette(paletteScope?: 'people') {
      mountedContainer = document.createElement('div')
      document.body.appendChild(mountedContainer)
      mountedRoot = createRoot(mountedContainer)
      act(() => mountedRoot?.render(createElement(CommandPalette)))
      act(() => window.dispatchEvent(
        paletteScope
          ? new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, { detail: paletteScope })
          : new Event(COMMAND_PALETTE_OPEN_EVENT),
      ))
      return document.querySelector('input[role="combobox"]') as HTMLInputElement
    }

    function type(input: HTMLInputElement, value: string) {
      act(() => {
        input.focus()
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set
        setter?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    function optionLabels() {
      return Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent ?? '')
    }

    it('offers a typed address, because there is no roster to pick from', async () => {
      // The whole point of the dead end: an account with no communities has
      // nobody to list. An address is the one thing Matrix identity always
      // gives you, and ensureDm has always accepted one.
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
      const ensureDm = vi.spyOn(bridge, 'ensureDm').mockResolvedValue({
        id: '!dm:mesh.test',
        peers: [{ userId: '@alice:mesh.test', displayName: 'Alice', avatarColor: '#111111' }],
        lastMessageAt: null,
        unreadCount: 0,
        createdAt: '2026-08-20T00:00:00.000Z',
      })
      const input = openPalette()
      type(input, '@alice:mesh.test')

      expect(optionLabels().some((label) => label.includes('Message @alice:mesh.test'))).toBe(true)

      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
        .find((candidate) => candidate.textContent?.includes('Message @alice:mesh.test'))
      await act(async () => {
        option?.click()
        await Promise.resolve()
      })
      expect(ensureDm).toHaveBeenCalledWith('@alice:mesh.test')
    })

    it('offers nothing for a partial address, so it never competes with a name', () => {
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
      const input = openPalette()
      type(input, '@alice')
      expect(optionLabels().some((label) => label.includes('Message @alice'))).toBe(false)
    })

    it('refuses your own address, which Matrix has no room for', () => {
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
      useIdentityStore.setState({ identity: { publicKey: '@me:mesh.test' } } as never)
      const input = openPalette()
      type(input, '@me:mesh.test')
      expect(optionLabels().some((label) => label.includes('Message @me:mesh.test'))).toBe(false)
      useIdentityStore.setState({ identity: null } as never)
    })

    it('opens the conversation that already exists rather than a second one', async () => {
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
      const ensureDm = vi.spyOn(bridge, 'ensureDm')
      useDmStore.setState({
        conversations: [{
          id: '!existing:mesh.test',
          peers: [{ userId: '@bob:mesh.test', displayName: 'Bob', avatarColor: '#222222' }],
          lastMessageAt: null,
          unreadCount: 0,
          createdAt: '2026-08-20T00:00:00.000Z',
        }],
      } as never)
      const input = openPalette()
      type(input, '@bob:mesh.test')

      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
        .find((candidate) => candidate.textContent?.includes('Message @bob:mesh.test'))
      expect(option?.textContent).toContain('Open your conversation')
      await act(async () => {
        option?.click()
        await Promise.resolve()
      })
      expect(ensureDm).not.toHaveBeenCalled()
      useDmStore.setState({ conversations: [] } as never)
    })

    it('asks the account service only when somebody is looking for a person', async () => {
      // What is typed here leaves the machine. Searching a homeserver because
      // somebody is looking for a settings page would be a privacy cost paid
      // for nothing, so the search is gated on the people scope or the `@`
      // sigil that means the same thing.
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
      const search = vi.spyOn(bridge, 'searchPersonDirectory')
        .mockResolvedValue({ people: [], truncated: false })

      mountedContainer = document.createElement('div')
      document.body.appendChild(mountedContainer)
      mountedRoot = createRoot(mountedContainer)
      act(() => mountedRoot?.render(createElement(CommandPalette)))
      act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT)))
      const input = document.querySelector('input[role="combobox"]') as HTMLInputElement

      type(input, 'appearance')
      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
      })
      expect(search).not.toHaveBeenCalled()

      type(input, '@alic')
      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
      })
      expect(search).toHaveBeenCalledWith('alic')
    })

    it('does not search for an address it already has', async () => {
      // typedAddressCommand covers this, and ensure_dm confirms it. Sending a
      // resolved address to a search endpoint buys nothing and tells the
      // service something it did not need to know.
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
      const search = vi.spyOn(bridge, 'searchPersonDirectory')
        .mockResolvedValue({ people: [], truncated: false })
      const input = openPalette('people')
      type(input, '@alice:mesh.test')
      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
      })
      expect(search).not.toHaveBeenCalled()
    })

    it('debounces to one request per pause rather than one per keystroke', async () => {
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
      const search = vi.spyOn(bridge, 'searchPersonDirectory')
        .mockResolvedValue({ people: [], truncated: false })
      const input = openPalette('people')
      for (const value of ['al', 'ali', 'alic', 'alice']) {
        type(input, value)
        await act(async () => {
          vi.advanceTimersByTime(50)
          await Promise.resolve()
        })
      }
      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
      })
      expect(search).toHaveBeenCalledOnce()
      expect(search).toHaveBeenCalledWith('alice')
    })

    it('words an empty answer as the service speaking, not as absence', async () => {
      // Most homeservers publish only people who share a room with the
      // searcher. The account this path exists for -- no communities -- can
      // therefore get nothing back from a service working exactly as designed,
      // and "no such person" would be Mesh inventing a fact, wrong for
      // precisely the people least able to check it.
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
      vi.spyOn(bridge, 'searchPersonDirectory')
        .mockResolvedValue({ people: [], truncated: false })
      const input = openPalette('people')
      type(input, 'alice')
      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
      })

      const announced = document.body.textContent ?? ''
      expect(announced).toContain('Your account service found nobody published')
      expect(announced).toContain('Type their full address instead')
    })

    it('offers who the service did publish, and starts a conversation with them', async () => {
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
      vi.spyOn(bridge, 'searchPersonDirectory').mockResolvedValue({
        people: [{
          userId: '@alice:mesh.test',
          displayName: 'Alice',
          avatarUrl: null,
          avatarColor: '#111111',
        }],
        truncated: false,
      })
      const ensureDm = vi.spyOn(bridge, 'ensureDm').mockResolvedValue({
        id: '!dm:mesh.test',
        peers: [{ userId: '@alice:mesh.test', displayName: 'Alice', avatarColor: '#111111' }],
        lastMessageAt: null,
        unreadCount: 0,
        createdAt: '2026-08-20T00:00:00.000Z',
      })
      const input = openPalette('people')
      type(input, 'alice')
      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
      })

      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
        .find((candidate) => candidate.textContent?.includes('@alice:mesh.test'))
      expect(option).toBeDefined()
      await act(async () => {
        option?.click()
        await Promise.resolve()
      })
      expect(ensureDm).toHaveBeenCalledWith('@alice:mesh.test')
    })

    it('stays quiet when a keystroke supersedes the search before it', async () => {
      // The cancellation is the debounce mechanism working. Surfacing it would
      // put an error on screen for typing at a normal speed.
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
      vi.spyOn(bridge, 'searchPersonDirectory').mockRejectedValue({
        code: 'cancelled',
        detail: 'people search was superseded',
        retryable: false,
      })
      const input = openPalette('people')
      type(input, 'alice')
      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
        await Promise.resolve()
      })

      const announced = document.body.textContent ?? ''
      expect(announced).toContain('Asking your account service')
      expect(announced).not.toContain('found nobody published')
    })

    it('names why an address was refused instead of shrugging at it', async () => {
      // "That action could not be completed" is the least useful answer to
      // typing an address: whether it was a typo, a block, or an unreachable
      // service is the entire question, and the backend already answers it.
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
      // The shape a Tauri command failure arrives in: a code the error model
      // recognises, not prose the renderer would have to parse.
      vi.spyOn(bridge, 'ensureDm').mockRejectedValue({
        code: 'account_not_found',
        detail: 'no account exists at @nobdy:mesh.test',
        retryable: false,
      })
      mountedContainer = document.createElement('div')
      document.body.appendChild(mountedContainer)
      mountedRoot = createRoot(mountedContainer)
      act(() => mountedRoot?.render(createElement(
        Fragment,
        null,
        createElement(CommandPalette),
        createElement(ToastContainer),
      )))
      act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT)))
      const input = document.querySelector('input[role="combobox"]') as HTMLInputElement
      type(input, '@nobdy:mesh.test')

      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
        .find((candidate) => candidate.textContent?.includes('Message @nobdy:mesh.test'))
      await act(async () => {
        option?.click()
        await Promise.resolve()
        await Promise.resolve()
      })

      const announced = document.body.textContent ?? ''
      expect(announced).not.toContain('That action could not be completed')
      expect(announced).toContain('No account at that address')
      // Not the room-shaped copy: nothing was removed and no access was lost.
      expect(announced).not.toContain('may no longer have access')
    })

    it('does not offer it on a backend that has no Matrix addresses', () => {
      vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(false)
      const input = openPalette()
      type(input, '@alice:mesh.test')
      expect(optionLabels().some((label) => label.includes('Message @alice:mesh.test'))).toBe(false)
    })
  })

  it('hides and disables voice actions when the selected backend has no voice capability', () => {
    mountedContainer = document.createElement('div')
    document.body.appendChild(mountedContainer)
    mountedRoot = createRoot(mountedContainer)
    act(() => mountedRoot?.render(createElement(CommandPalette)))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'm',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }))
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'd',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(useVoiceStore.getState()).toMatchObject({ isMuted: false, isDeafened: false })

    act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT)))
    expect(document.body.textContent).not.toContain('Mute microphone')
    expect(document.body.textContent).not.toContain('Deafen audio')

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: '/',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(document.body.textContent).not.toContain('Toggle mute')
    expect(document.body.textContent).not.toContain('Toggle deafen')
  })

  it('retains voice actions for a backend that explicitly enables voice', () => {
    vi.spyOn(bridge, 'getBackendCapabilities').mockReturnValue({
      encryptedText: true,
      encryptedAttachments: true,
      directMessages: true,
      voice: true,
      durableTimeouts: true,
      deviceManagement: true,
      recovery: true,
      legacyMigration: false,
    })
    mountedContainer = document.createElement('div')
    document.body.appendChild(mountedContainer)
    mountedRoot = createRoot(mountedContainer)
    act(() => mountedRoot?.render(createElement(CommandPalette)))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'm',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(useVoiceStore.getState().isMuted).toBe(true)

    act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT)))
    expect(document.body.textContent).toContain('Unmute microphone')
    expect(document.body.textContent).toContain('Deafen audio')
  })

  it('opens when recent-command storage is denied', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage access denied', 'SecurityError')
    })
    try {
      mountedContainer = document.createElement('div')
      document.body.appendChild(mountedContainer)
      mountedRoot = createRoot(mountedContainer)
      act(() => mountedRoot?.render(createElement(CommandPalette)))

      act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT)))

      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
      expect(document.querySelector('input[role="combobox"]')).not.toBeNull()
    } finally {
      read.mockRestore()
    }
  })

  it('opens from the visible affordance event and renders taxonomy as section headings', () => {
    window.localStorage.setItem(
      'mesh-command-palette-recents',
      JSON.stringify(['action:show-shortcuts']),
    )
    mountedContainer = document.createElement('div')
    document.body.appendChild(mountedContainer)
    mountedRoot = createRoot(mountedContainer)
    act(() => mountedRoot?.render(createElement(CommandPalette)))

    act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT)))

    expect(document.body.textContent).toContain('Recent')
    expect(document.body.textContent).toContain('Actions')
    expect(document.body.textContent).toContain('Show keyboard shortcuts')
    // Group names are headings, not prefixes that contaminate fuzzy matching.
    expect(document.body.textContent).not.toContain('Action · Show keyboard shortcuts')
  })

  it('leaves timeline Escape alone and announces the unread state it does clear', () => {
    const room: Channel = {
      id: '!general:example.org',
      communityId: '+mesh:example.org',
      name: 'general',
      topic: '',
      channelType: 'text',
      unreadCount: 3,
      joined: true,
    }
    const markChannelRead = vi.spyOn(bridge, 'markChannelRead').mockResolvedValue(undefined)
    act(() => {
      useChannelStore.getState().setChannels([room])
      useChannelStore.getState().setActiveChannel(room.id)
    })

    mountedContainer = document.createElement('div')
    document.body.appendChild(mountedContainer)
    mountedRoot = createRoot(mountedContainer)
    act(() => mountedRoot?.render(createElement(
      Fragment,
      null,
      createElement(CommandPalette),
      createElement(ToastContainer),
    )))

    // Escape is how a screen-reader user leaves focus mode inside the feed.
    const feed = document.createElement('div')
    feed.setAttribute('role', 'feed')
    const row = document.createElement('div')
    feed.appendChild(row)
    document.body.appendChild(feed)
    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(markChannelRead).not.toHaveBeenCalled()
    expect(useChannelStore.getState().channelEntities[room.id].unreadCount).toBe(3)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(useChannelStore.getState().channelEntities[room.id].unreadCount).toBe(0)
    expect(markChannelRead).toHaveBeenCalledWith(room.id)
    // Silent, unprompted, irreversible: it has to be perceivable.
    expect(document.body.textContent).toContain('Escape marked this room as read')

    feed.remove()
    act(() => {
      useChannelStore.getState().setActiveChannel(null)
      useChannelStore.getState().setChannels([])
    })
  })

  it('scopes the conversation entry point to people and messages', () => {
    mountedContainer = document.createElement('div')
    document.body.appendChild(mountedContainer)
    mountedRoot = createRoot(mountedContainer)
    act(() => mountedRoot?.render(createElement(CommandPalette)))

    act(() => window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, {
      detail: 'people',
    })))

    expect(document.body.textContent).toContain('Start a private conversation')
    expect(document.querySelector<HTMLInputElement>('[role="combobox"]')?.placeholder)
      .toBe('Find someone to message…')
    expect(document.body.textContent)
      .toContain('Find people from your communities and conversations.')
    expect(document.body.textContent).not.toContain('Profile and preferences')
    expect(document.body.textContent).not.toContain('Show keyboard shortcuts')
  })
})
