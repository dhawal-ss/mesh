import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateCommunityModal } from './CreateCommunityModal'
import {
  COMMUNITY_DESCRIPTION_MAX_LENGTH,
  COMMUNITY_NAME_MAX_LENGTH,
} from '../../lib/community-metadata-limits'

const bridgeMocks = vi.hoisted(() => ({
  createCommunity: vi.fn(),
  createChannel: vi.fn(),
  getChannels: vi.fn(),
  updateCommunityAccess: vi.fn(),
  joinOrRequestCommunity: vi.fn(),
  searchCommunityDirectory: vi.fn(),
  requestCommunityAccess: vi.fn(),
  joinCommunity: vi.fn(),
}))

vi.mock('../../lib/bridge', () => ({
  isMatrixBackend: () => true,
  createCommunity: bridgeMocks.createCommunity,
  createChannel: bridgeMocks.createChannel,
  getChannels: bridgeMocks.getChannels,
  updateCommunityAccess: bridgeMocks.updateCommunityAccess,
  joinOrRequestCommunity: bridgeMocks.joinOrRequestCommunity,
  searchCommunityDirectory: bridgeMocks.searchCommunityDirectory,
  requestCommunityAccess: bridgeMocks.requestCommunityAccess,
  joinCommunity: bridgeMocks.joinCommunity,
  getBackendStatusSnapshot: () => ({ homeserver: 'https://mesh.example.org' }),
  getMatrixUserId: () => '@ana:mesh.example.org',
}))

describe('CreateCommunityModal', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    bridgeMocks.createCommunity.mockReset().mockResolvedValue({
      id: '!server:example.org',
      name: 'Design Club',
      description: '',
      avatarUrl: null,
      memberCount: 1,
      role: 'owner',
      joinedAt: null,
    })
    bridgeMocks.createChannel.mockReset().mockImplementation(
      (_communityId: string, name: string) => Promise.resolve({
        id: `!${name}:example.org`,
        communityId: '!server:example.org',
        name,
        topic: '',
        channelType: 'text',
        unreadCount: 0,
      }),
    )
    bridgeMocks.getChannels.mockReset().mockResolvedValue([])
    bridgeMocks.updateCommunityAccess.mockReset().mockResolvedValue({
      alias: null,
      discoverable: false,
      joinRule: 'invite',
    })
    bridgeMocks.searchCommunityDirectory.mockReset().mockResolvedValue([])
    bridgeMocks.requestCommunityAccess.mockReset().mockResolvedValue({ status: 'knocked', community: null })
    bridgeMocks.joinCommunity.mockReset()
    bridgeMocks.joinOrRequestCommunity.mockReset().mockResolvedValue({
      status: 'joined',
      community: {
        id: '!server:example.org',
        name: 'Design Club',
        description: '',
        avatarUrl: null,
        memberCount: 2,
        role: 'member',
        joinedAt: null,
      },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.querySelectorAll('[data-radix-portal]').forEach((portal) => portal.remove())
  })

  it('creates from a two-step identity, access, and gaming starter-room flow', async () => {
    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })

    expect(
      document.body.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby'),
    ).toBeTruthy()
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      'Create a community',
    )

    const nameInput = document.body.querySelector<HTMLInputElement>('input[placeholder="e.g. Canyon Raiders"]')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const next = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Next')
    await act(async () => next?.click())
    expect(document.body.textContent).toContain('Access and starter rooms')
    expect(document.body.textContent).toContain('#clips-and-builds')

    const create = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Create community')
    await act(async () => {
      create?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridgeMocks.createCommunity).toHaveBeenCalledWith('Design Club', '')
    expect(bridgeMocks.updateCommunityAccess).toHaveBeenCalledWith('!server:example.org', '', false, 'invite')
    expect(bridgeMocks.createChannel).toHaveBeenCalledWith('!server:example.org', 'general', 'text')
    expect(bridgeMocks.createChannel).toHaveBeenCalledWith('!server:example.org', 'clips-and-builds', 'text')
    expect(bridgeMocks.createChannel).toHaveBeenCalledWith('!server:example.org', 'playtest-notes', 'text')
  })

  it('switches to the general starter-room template and creates only its rooms', async () => {
    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })

    const nameInput = document.body.querySelector<HTMLInputElement>('input[placeholder="e.g. Canyon Raiders"]')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Book Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent === 'Next')
        ?.click()
    })

    expect(document.body.textContent).toContain('#clips-and-builds')

    const generalOption = document.body.querySelector<HTMLInputElement>(
      'input[name="community-template"][value="general"]',
    )
    await act(async () => {
      generalOption?.click()
    })

    expect(document.body.textContent).not.toContain('#clips-and-builds')
    expect(document.body.textContent).not.toContain('#playtest-notes')

    const create = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Create community')
    await act(async () => {
      create?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridgeMocks.createChannel).toHaveBeenCalledTimes(1)
    expect(bridgeMocks.createChannel).toHaveBeenCalledWith('!server:example.org', 'general', 'text')
  })

  it('applies approval-required against a backend that enforces the real alias rule', async () => {
    /*
      This is the case the old code could never satisfy. It asserts the resulting
      access settings rather than the call arguments, and the fake below enforces
      the constraint the native side actually enforces: publishing to the
      directory needs an alias, joining by knock does not.

      Under the previous contract the renderer sent discoverable=true with an
      empty alias, this rejection fired, and the failure was reported to the
      owner as "some starter rooms still need setup".
    */
    let stored = { alias: null as string | null, discoverable: false, joinRule: 'invite' }
    bridgeMocks.updateCommunityAccess.mockReset().mockImplementation(
      async (_id: string, alias: string, discoverable: boolean, joinRule: string) => {
        const trimmed = alias.trim() || null
        if (discoverable && !trimmed) {
          throw { code: 'invalid_configuration', detail: 'alias required to publish', retryable: false }
        }
        stored = { alias: trimmed, discoverable, joinRule }
        return stored
      },
    )

    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })

    const nameInput = document.body.querySelector<HTMLInputElement>('input[placeholder="e.g. Canyon Raiders"]')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Canyon Raiders')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Next')?.click())

    const approval = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
      .find((input) => input.value === 'approval')
    expect(approval).toBeTruthy()
    await act(async () => {
      approval!.click()
    })

    await act(async () => {
      Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent === 'Create community')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    // The outcome, not the call: approval-required actually took effect.
    expect(stored.joinRule).toBe('knock')
    expect(stored.discoverable).toBe(false)
    // And creation is not reported as a starter-room problem.
    expect(document.body.textContent).not.toContain('starter rooms still need setup')
    expect(document.body.textContent).not.toContain('Some rooms still need attention')
  })

  it('exposes the switcher as tabs with a non-colour selected signal', async () => {
    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })

    const tablist = document.body.querySelector('[role="tablist"]')
    expect(tablist?.getAttribute('aria-label')).toBeTruthy()
    const tabs = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs).toHaveLength(3)
    const selected = tabs.filter((entry) => entry.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].textContent).toContain('Create')
    // Roving tab order: only the selected tab is a stop, the rest are arrowed to.
    expect(tabs.filter((entry) => entry.tabIndex === 0)).toHaveLength(1)
    expect(selected[0].tabIndex).toBe(0)

    const panel = document.body.querySelector(`#${selected[0].getAttribute('aria-controls')}`)
    expect(panel?.getAttribute('role')).toBe('tabpanel')
    expect(panel?.getAttribute('aria-labelledby')).toBe(selected[0].id)
    // The selected tab carries a shape, not only a tint a colour-blind user
    // misses. Every tab holds the indicator so it can transition, so asserting
    // it merely exists would pass on an unselected tab too: the signal is that
    // only the selected one is scaled up.
    const indicatorOf = (entry: HTMLButtonElement) =>
      entry.querySelector('[class*="border-b-bar"]')?.className ?? ''
    expect(indicatorOf(selected[0])).toContain('scale-x-100')
    for (const entry of tabs.filter((candidate) => candidate !== selected[0])) {
      expect(indicatorOf(entry)).toContain('scale-x-0')
    }

    await act(async () => {
      selected[0].dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }))
    })

    const nowSelected = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .filter((entry) => entry.getAttribute('aria-selected') === 'true')
    expect(nowSelected).toHaveLength(1)
    expect(nowSelected[0].textContent).toContain('Join')
    // Focus stays on the tab. Each panel autofocuses its first field, which is
    // right when the modal opens or a tab is picked outright, but arrowing
    // across a roving tablist must let the person keep exploring rather than
    // dropping them into a text box they never chose.
    expect(document.activeElement).toBe(nowSelected[0])
  })

  it('gives the access choices a focus indicator of their own', async () => {
    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Canyon Raiders"]',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Next')
        ?.click()
    })

    const choices = [...document.body.querySelectorAll<HTMLInputElement>(
      'input[name="community-access"]',
    )]
    expect(choices).toHaveLength(2)
    for (const choice of choices) {
      // The radio is visually hidden, so the card it lives in has to draw the ring.
      expect(choice.closest('label')?.className).toContain(
        'has-[input:focus-visible]:outline-focus',
      )
    }
  })

  it('searches the signed-in account service by default and keeps other directories advanced', async () => {
    const onTabChange = vi.fn()
    bridgeMocks.searchCommunityDirectory.mockResolvedValue([
      {
        id: '!canyon:mesh.example.org',
        alias: '#canyon:mesh.example.org',
        name: 'Canyon Raiders',
        description: 'Weeknight raids',
        avatarUrl: null,
        memberCount: 42,
        joinRule: 'public',
      },
    ])
    await act(async () => {
      root.render(
        <CreateCommunityModal
          embedded
          isOpen
          activeTab="discover"
          onTabChange={onTabChange}
          onClose={() => {}}
        />,
      )
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).toContain('Search public communities')
    // Honest about the source: unlisted communities are excluded, and the
    // service that answers the search is named.
    expect(document.body.textContent).toContain('so unlisted communities do not appear')
    expect(document.body.textContent).toContain('published by mesh.example.org')
    expect(document.body.textContent).toContain('Advanced: use another directory')

    const search = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Search')
    // The search is unreachable until there is something to search for, but it
    // never demands a directory address first.
    expect(search?.disabled).toBe(true)

    const queryInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Community name or topic"]',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(queryInput, 'raiders')
      queryInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(search?.disabled).toBe(false)

    await act(async () => {
      search?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridgeMocks.searchCommunityDirectory).toHaveBeenCalledWith('raiders', undefined)
    expect(document.body.textContent).toContain('Canyon Raiders')
    expect(document.body.textContent).toContain('Use an invitation')
    expect(document.body.textContent).toContain('Create a community')

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Use an invitation')
        ?.click()
    })
    expect(onTabChange).toHaveBeenCalledWith('join')

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Create a community')
        ?.click()
    })
    expect(onTabChange).toHaveBeenCalledWith('create')
  })

  it('sends an explicit advanced directory address as a service name', async () => {
    await act(async () => {
      root.render(
        <CreateCommunityModal embedded isOpen activeTab="discover" onClose={() => {}} />,
      )
    })

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    const serverInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="directory.example.org"]',
    )
    const queryInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Community name or topic"]',
    )
    await act(async () => {
      setValue?.call(serverInput, 'directory.example.org')
      serverInput?.dispatchEvent(new Event('input', { bubbles: true }))
      setValue?.call(queryInput, 'raiders')
      queryInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(document.body.textContent).toContain('published by directory.example.org')

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Search')
        ?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridgeMocks.searchCommunityDirectory).toHaveBeenCalledWith(
      'raiders',
      'directory.example.org',
    )
    expect(document.body.textContent).toContain(
      'No listed community matched that search.',
    )
  })

  it('keeps the dialog open and exposes a retryable error when creation fails', async () => {
    bridgeMocks.createCommunity.mockRejectedValueOnce(new Error('Homeserver unavailable'))

    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })

    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Canyon Raiders"]',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const next = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Next')
    await act(async () => next?.click())

    const create = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Create community')
    await act(async () => {
      create?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('finishes a partial community idempotently without duplicating completed rooms', async () => {
    const rooms: Array<{
      id: string
      communityId: string
      name: string
      channelType: 'text'
      unreadCount: number
    }> = []
    let clipsAttempt = 0
    bridgeMocks.getChannels.mockImplementation(async () => [...rooms])
    bridgeMocks.createChannel.mockImplementation(async (
      communityId: string,
      name: string,
    ) => {
      if (name === 'clips-and-builds' && clipsAttempt++ === 0) {
        throw new Error('room service unavailable')
      }
      const created = {
        id: `!${name}:example.org`,
        communityId,
        name,
        topic: '',
        channelType: 'text' as const,
        unreadCount: 0,
      }
      rooms.push(created)
      return created
    })

    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Canyon Raiders"]',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Next')
        ?.click()
    })
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Create community')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain('Community created. Some rooms still need attention.')
    expect(bridgeMocks.createCommunity).toHaveBeenCalledTimes(1)
    expect(bridgeMocks.createChannel).toHaveBeenCalledWith(
      '!server:example.org',
      'general',
      'text',
    )

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Finish setup')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(bridgeMocks.createCommunity).toHaveBeenCalledTimes(1)
    expect(bridgeMocks.createChannel.mock.calls.filter((call) => call[1] === 'general')).toHaveLength(1)
    expect(bridgeMocks.createChannel.mock.calls.filter((call) => call[1] === 'clips-and-builds')).toHaveLength(2)
    expect(rooms.map((room) => room.name).sort()).toEqual(['clips-and-builds', 'general', 'playtest-notes'])
  })

  it('does not treat Enter inside the description textarea as Next', async () => {
    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Canyon Raiders"]',
    )
    const description = document.body.querySelector<HTMLTextAreaElement>(
      '#create-community-description',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
      description?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(document.body.textContent).toContain('Name and image')
    expect(document.body.textContent).not.toContain('Access and starter rooms')
  })

  it('bounds community details and blocks overlong values with accessible guidance', async () => {
    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })

    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Canyon Raiders"]',
    )
    const description = document.body.querySelector<HTMLTextAreaElement>(
      '#create-community-description',
    )
    expect(nameInput?.maxLength).toBe(COMMUNITY_NAME_MAX_LENGTH)
    expect(description?.maxLength).toBe(COMMUNITY_DESCRIPTION_MAX_LENGTH)
    expect(nameInput?.getAttribute('aria-describedby')).toBeTruthy()
    expect(description?.getAttribute('aria-describedby')).toBe(
      'create-community-description-supporting',
    )
    expect(document.body.textContent).toContain(
      `${COMMUNITY_NAME_MAX_LENGTH} characters remaining.`,
    )
    expect(document.body.textContent).toContain(
      `${COMMUNITY_DESCRIPTION_MAX_LENGTH} characters remaining.`,
    )

    await act(async () => {
      const setInputValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setInputValue?.call(nameInput, 'n'.repeat(COMMUNITY_NAME_MAX_LENGTH + 1))
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
      const setTextareaValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set
      setTextareaValue?.call(
        description,
        'd'.repeat(COMMUNITY_DESCRIPTION_MAX_LENGTH + 1),
      )
      description?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(nameInput?.getAttribute('aria-invalid')).toBe('true')
    expect(description?.getAttribute('aria-invalid')).toBe('true')
    expect(document.body.textContent).toContain(
      `Community name must be ${COMMUNITY_NAME_MAX_LENGTH} characters or fewer.`,
    )
    expect(document.body.textContent).toContain(
      `Description must be ${COMMUNITY_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
    )
    const next = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Next')
    expect(next?.disabled).toBe(true)
    expect(bridgeMocks.createCommunity).not.toHaveBeenCalled()
  })

  it('retries refresh after creation without recreating the community or starter rooms', async () => {
    const rooms: Array<{
      id: string
      communityId: string
      name: string
      channelType: 'text'
      unreadCount: number
    }> = []
    let listAttempt = 0
    bridgeMocks.getChannels.mockImplementation(async () => {
      listAttempt += 1
      if (listAttempt === 2) throw new Error('refresh timed out')
      return [...rooms]
    })
    bridgeMocks.createChannel.mockImplementation(async (communityId: string, name: string) => {
      const created = {
        id: `!${name}:example.org`,
        communityId,
        name,
        topic: '',
        channelType: 'text' as const,
        unreadCount: 0,
      }
      rooms.push(created)
      return created
    })

    await act(async () => {
      root.render(<CreateCommunityModal isOpen onClose={() => {}} />)
    })
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Canyon Raiders"]',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(nameInput, 'Design Club')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Next')
        ?.click()
    })
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Create community')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('Finish setup')

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Finish setup')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(bridgeMocks.createCommunity).toHaveBeenCalledTimes(1)
    expect(bridgeMocks.createChannel).toHaveBeenCalledTimes(3)
  })

  it('reviews a standard Matrix community invitation before joining', async () => {
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <CreateCommunityModal
          isOpen
          onClose={onClose}
          initialTab="join"
          initialInvite="mesh://join?v=3&kind=matrix&room=!server:example.org&via=example.org"
        />,
      )
    })
    const review = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Review invitation')
    await act(async () => review?.click())
    expect(bridgeMocks.joinOrRequestCommunity).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Destination ready to review')
    const join = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Continue with current account')
    await act(async () => {
      join?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridgeMocks.joinOrRequestCommunity).toHaveBeenCalledWith(
      'mesh://join?v=3&kind=matrix&room=!server:example.org&via=example.org',
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps invalid invitation input editable and never attempts a join', async () => {
    await act(async () => {
      root.render(
        <CreateCommunityModal
          embedded
          isOpen
          activeTab="join"
          initialInvite="not an invitation"
          onClose={() => {}}
        />,
      )
    })
    const review = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Review invitation')
    await act(async () => review?.click())

    expect(document.body.querySelector<HTMLInputElement>('input')?.value).toBe('not an invitation')
    expect(document.body.textContent).toContain('Check the invitation link or code')
    expect(bridgeMocks.joinOrRequestCommunity).not.toHaveBeenCalled()
  })
})
