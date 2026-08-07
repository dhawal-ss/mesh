import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingInvitationMetadata } from '../../types/ipc'
import { useCommunityStore } from '../../store/communities'
import { useMeshNavigationStore } from '../../store/navigation'
import { useShellStore } from '../../store/shell'
import * as bridge from '../../lib/bridge'
import {
  InvitationDestinationCard,
  InvitationSurface,
} from './InvitationConfirmation'

vi.mock('../../lib/bridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/bridge')>(),
  joinPendingInvitation: vi.fn(),
  clearPendingInvitation: vi.fn(),
}))

vi.mock('../ui/Toast', () => ({
  showToast: vi.fn(),
}))

describe('InvitationSurface', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    window.localStorage.clear()
    useShellStore.setState({
      pendingInvitation: null,
      foregroundInvitationHandle: null,
    })
    useCommunityStore.setState({
      communityEntities: {},
      communityOrder: [],
      communities: [],
      activeCommunityId: null,
    })
    useMeshNavigationStore.getState().resetForAccountTransition()
    useMeshNavigationStore.getState().initialize('@taylor:example.org')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the destination and optional account-service suggestion factual', async () => {
    const pending = pendingInvitation({
      communityName: 'Garden Party',
      roomOrAlias: '#playtest-notes:garden.example',
      inviterDisplayName: 'Alice',
      joinRule: 'knock',
      communityServiceDisplayName: 'Garden Accounts',
    })

    await act(async () => {
      root.render(<InvitationDestinationCard pending={pending} />)
    })

    expect(container.textContent).toContain('Garden Party')
    expect(container.textContent).toContain('Community')
    expect(container.textContent).not.toContain('playtest notes')
    expect(container.textContent).toContain('Invited byAlice')
    expect(container.textContent).toContain('Approval required')
    expect(container.textContent).toContain('Suggested serviceGarden Accounts')
    const suggestedService = Array.from(container.querySelectorAll('dd'))
      .find((item) => item.textContent === 'Garden Accounts')
    expect(suggestedService?.classList.contains('break-words')).toBe(true)
    expect(suggestedService?.classList.contains('truncate')).toBe(false)
    expect(container.textContent).not.toContain(pending.handle)
  })

  it('joins only after explicit action and routes to the confirmed community', async () => {
    const pending = pendingInvitation({ communityName: 'Lantern Guild' })
    useShellStore.getState().setPendingInvitation(pending)
    vi.mocked(bridge.joinPendingInvitation).mockResolvedValue({
      id: '!lantern:community.example',
      name: 'Lantern Guild',
      description: 'Playtests and late-night runs',
      memberCount: 9,
      role: 'member',
      joinedAt: '2026-08-02T00:00:00.000Z',
    })

    await act(async () => {
      root.render(<InvitationSurface handle={pending.handle} onSignInRequired={() => undefined} />)
    })

    expect(bridge.joinPendingInvitation).not.toHaveBeenCalled()
    expect(container.textContent).toContain('This community can use a different compatible service')

    await act(async () => {
      findButton('Join Lantern Guild').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridge.joinPendingInvitation).toHaveBeenCalledWith(pending.handle)
    expect(useShellStore.getState().pendingInvitation).toBeNull()
    expect(useCommunityStore.getState().activeCommunityId).toBe('!lantern:community.example')
    expect(useMeshNavigationStore.getState().entries.slice(-1)[0]).toEqual({
      kind: 'community',
      communityId: '!lantern:community.example',
    })
  })

  it('keeps the destination visible and offers one retry after a join failure', async () => {
    const pending = pendingInvitation({ communityName: 'Canyon Crew' })
    useShellStore.getState().setPendingInvitation(pending)
    vi.mocked(bridge.joinPendingInvitation).mockRejectedValue(new Error('network down'))

    await act(async () => {
      root.render(<InvitationSurface handle={pending.handle} onSignInRequired={() => undefined} />)
    })
    await act(async () => {
      findButton('Join Canyon Crew').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Invitation destination"]')).not.toBeNull()
    expect(container.textContent).toContain('Canyon Crew')
    expect(findButton('Try again')).toBeTruthy()
    expect(useShellStore.getState().pendingInvitation).toEqual(pending)
  })

  it('leaves an invalid invitation saved and returns home without retrying it', async () => {
    const pending = pendingInvitation({ communityName: 'Canyon Crew' })
    useShellStore.getState().setPendingInvitation(pending)
    vi.mocked(bridge.joinPendingInvitation).mockRejectedValue({
      code: 'community_invite_invalid',
      detail: 'expired invitation',
      retryable: false,
    })

    await act(async () => {
      root.render(<InvitationSurface handle={pending.handle} onSignInRequired={() => undefined} />)
    })
    await act(async () => {
      findButton('Join Canyon Crew').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Invitation unavailable')
    expect(queryButton('Try again')).toBeUndefined()
    expect(queryButton('Save for later')).toBeUndefined()
    expect(findButton('Back to Home')).toBeTruthy()
    expect(bridge.joinPendingInvitation).toHaveBeenCalledTimes(1)
    expect(useShellStore.getState().pendingInvitation).toEqual(pending)

    await act(async () => {
      findButton('Back to Home').click()
    })

    expect(bridge.joinPendingInvitation).toHaveBeenCalledTimes(1)
    expect(useShellStore.getState()).toMatchObject({
      pendingInvitation: pending,
      foregroundInvitationHandle: null,
    })
    expect(useMeshNavigationStore.getState().entries.slice(-1)[0]).toEqual({ kind: 'home' })
  })

  it('routes an expired account session to sign-in without discarding the invitation', async () => {
    const pending = pendingInvitation({ communityName: 'Canyon Crew' })
    const onSignInRequired = vi.fn()
    useShellStore.getState().setPendingInvitation(pending)
    vi.mocked(bridge.joinPendingInvitation).mockRejectedValue({
      code: 'not_authenticated',
      detail: 'session expired',
      retryable: false,
    })

    await act(async () => {
      root.render(
        <InvitationSurface
          handle={pending.handle}
          onSignInRequired={onSignInRequired}
        />,
      )
    })
    await act(async () => {
      findButton('Join Canyon Crew').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(queryButton('Try again')).toBeUndefined()
    expect(findButton('Sign in again')).toBeTruthy()
    await act(async () => {
      findButton('Sign in again').click()
    })

    expect(onSignInRequired).toHaveBeenCalledOnce()
    expect(bridge.joinPendingInvitation).toHaveBeenCalledTimes(1)
    expect(useShellStore.getState().pendingInvitation).toEqual(pending)
  })

  it('saves the invitation without clearing its native-backed destination', async () => {
    const pending = pendingInvitation({ communityName: 'Canyon Crew' })
    useShellStore.getState().setPendingInvitation(pending)

    await act(async () => {
      root.render(<InvitationSurface handle={pending.handle} onSignInRequired={() => undefined} />)
    })
    await act(async () => {
      findButton('Save for later').click()
    })

    expect(useShellStore.getState()).toMatchObject({
      pendingInvitation: pending,
      foregroundInvitationHandle: null,
    })
    expect(useMeshNavigationStore.getState().entries.slice(-1)[0]).toEqual({ kind: 'home' })
  })

  function findButton(label: string): HTMLButtonElement {
    const button = queryButton(label)
    if (!button) throw new Error(`Button not found: ${label}`)
    return button
  }

  function queryButton(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === label)
  }
})

function pendingInvitation(
  overrides: Partial<PendingInvitationMetadata> = {},
): PendingInvitationMetadata {
  return {
    handle: 'pending-1',
    roomOrAlias: '!garden:community.example',
    via: ['community.example'],
    service: 'https://matrix.community.example',
    admissionService: null,
    storedAt: 1_752_000_000_000,
    expiresAt: 1_754_592_000_000,
    ...overrides,
  }
}
