import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Community, PendingInvitationMetadata } from './types/ipc'
import type { OnboardingFlowProps } from './components/onboarding/types'

type OnboardingHarnessProps = OnboardingFlowProps

const eventHarness = vi.hoisted(() => ({
  invitationReady: null as null | (() => void),
  onboardingProps: null as OnboardingHarnessProps | null,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: () => void) => {
    eventHarness.invitationReady = handler
    return () => {
      if (eventHarness.invitationReady === handler) eventHarness.invitationReady = null
    }
  }),
}))

vi.mock('./lib/scheduler', () => ({
  registerPoll: vi.fn(() => () => {}),
}))

vi.mock('./lib/lazy-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}))

vi.mock('./components/onboarding/OnboardingFlow', () => ({
  OnboardingFlow: (props: OnboardingHarnessProps) => {
    eventHarness.onboardingProps = props
    return <div>Onboarding</div>
  },
}))

vi.mock('./components/layout/AppLayout', () => ({
  AppLayout: () => <div>App layout</div>,
}))

vi.mock('./components/onboarding/InvitationConfirmation', () => ({
  InvitationConfirmation: () => <div>Invitation confirmation</div>,
}))

vi.mock('./components/ui/Toast', () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}))

vi.mock('./components/ui/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import App from './App'
import * as bridge from './lib/bridge'
import { useChannelStore } from './store/channels'
import { useCommunityStore } from './store/communities'
import { useIdentityStore } from './store/identity'
import { useShellStore } from './store/shell'
import { useSettingsStore } from './store/settings'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function invitation(handle: string, communityName: string): PendingInvitationMetadata {
  return {
    handle,
    roomOrAlias: null,
    via: ['community.example'],
    service: 'community.example',
    admissionService: null,
    communityName,
    storedAt: 1_786_000_000_000,
    expiresAt: 1_788_592_000_000,
  }
}

function community(id: string): Community {
  return {
    id,
    name: id,
    description: '',
    memberCount: 1,
    role: 'member',
    joinedAt: null,
  }
}

function channel(id: string, communityId: string): Channel {
  return {
    id,
    communityId,
    name: id,
    channelType: 'text',
    unreadCount: 0,
  }
}

function authenticatedMatrixStatus(): bridge.BackendStatus {
  return {
    kind: 'matrix',
    authenticated: true,
    userId: '@alice:friends.example',
    syncRunning: true,
  } as bridge.BackendStatus
}

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('App pending invitation ordering', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    eventHarness.invitationReady = null
    eventHarness.onboardingProps = null
    useIdentityStore.setState({ identity: null, isLoading: false })
    useCommunityStore.setState({
      communityEntities: {},
      communityOrder: [],
      communities: [],
      activeCommunityId: null,
    })
    useChannelStore.setState({
      channelEntities: {},
      channelOrder: [],
      channels: [],
      activeChannelId: null,
      refreshByCommunity: {},
      refreshRequests: {},
    })
    useShellStore.setState({
      pendingInvitation: null,
      foregroundInvitationHandle: null,
    })
    useSettingsStore.setState({
      backup: { configured: false, reminderPending: false, dismissedAt: null },
      backupAccountId: null,
      backupByAccount: {},
    })
    vi.spyOn(bridge, 'isTauriRuntime').mockReturnValue(true)
    vi.spyOn(bridge, 'getBackendStatus').mockResolvedValue({
      kind: 'matrix',
      authenticated: false,
      syncRunning: false,
    } as bridge.BackendStatus)
    vi.spyOn(bridge, 'onNetworkStatus').mockResolvedValue(() => {})
    vi.spyOn(bridge, 'onCommunityUpdated').mockResolvedValue(() => {})
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps an event invitation when the older bootstrap peek resolves last', async () => {
    const bootstrapPeek = deferred<PendingInvitationMetadata | null>()
    const eventPeek = deferred<PendingInvitationMetadata | null>()
    const newerInvitation = invitation('invite-b', 'Book Club')
    vi.spyOn(bridge, 'peekPendingInvitation')
      .mockReturnValueOnce(bootstrapPeek.promise)
      .mockReturnValueOnce(eventPeek.promise)

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
    })
    await act(async () => {
      eventHarness.invitationReady?.()
      eventPeek.resolve(newerInvitation)
      await flushAsyncWork()
    })
    expect(useShellStore.getState().pendingInvitation).toEqual(newerInvitation)

    await act(async () => {
      bootstrapPeek.resolve(null)
      await flushAsyncWork()
    })
    expect(useShellStore.getState().pendingInvitation).toEqual(newerInvitation)
  })

  it('does not clear a newer invitation when an older discard finishes late', async () => {
    const olderInvitation = invitation('invite-a', 'Garden Club')
    const newerInvitation = invitation('invite-b', 'Book Club')
    const clearOlder = deferred<void>()
    vi.spyOn(bridge, 'peekPendingInvitation')
      .mockResolvedValueOnce(olderInvitation)
      .mockResolvedValueOnce(newerInvitation)
    vi.spyOn(bridge, 'clearPendingInvitation').mockReturnValue(clearOlder.promise)

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
      await flushAsyncWork()
    })
    expect(eventHarness.onboardingProps?.initialPendingInvitation).toEqual(olderInvitation)

    let discard!: Promise<void>
    await act(async () => {
      discard = eventHarness.onboardingProps?.onDiscardPendingInvitation?.() ?? Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      eventHarness.invitationReady?.()
      await flushAsyncWork()
    })
    expect(useShellStore.getState().pendingInvitation).toEqual(newerInvitation)

    await act(async () => {
      clearOlder.resolve()
      await discard
    })
    expect(useShellStore.getState().pendingInvitation).toEqual(newerInvitation)
  })

  it('keeps a cold-start backend failure in an actionable recovery state', async () => {
    vi.spyOn(bridge, 'peekPendingInvitation').mockResolvedValue(null)
    vi.mocked(bridge.getBackendStatus).mockRejectedValue(new Error('native backend unavailable'))

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(container.textContent).toContain("Mesh couldn't open your saved account")
    expect(container.textContent).toContain('Your saved account has not been replaced')
    expect(container.textContent).toContain('Try again')
    expect(container.textContent).not.toContain('Onboarding')
    expect(eventHarness.onboardingProps).toBeNull()
  })

  it('recovers the saved account after retrying cold-start initialization', async () => {
    const alpha = community('community-alpha')
    vi.spyOn(bridge, 'peekPendingInvitation').mockResolvedValue(null)
    vi.mocked(bridge.getBackendStatus)
      .mockRejectedValueOnce(new Error('native backend unavailable'))
      .mockResolvedValueOnce(authenticatedMatrixStatus())
    vi.spyOn(bridge, 'matrixGetProfile').mockResolvedValue({
      userId: '@alice:friends.example',
      displayName: 'Alice',
      avatarUrl: null,
    })
    vi.spyOn(bridge, 'getCommunitiesResult').mockResolvedValue({
      entities: [alpha],
      blockedEntities: [],
    })
    vi.spyOn(bridge, 'getChannels').mockResolvedValue([])

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
      await flushAsyncWork()
    })

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Try again')
    expect(retry).toBeTruthy()

    await act(async () => {
      retry?.click()
      await flushAsyncWork()
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(bridge.getBackendStatus).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('App layout')
    expect(container.textContent).not.toContain('Choose your account service')
    expect(useCommunityStore.getState().communities).toEqual([alpha])
    expect(useSettingsStore.getState().backupAccountId).toBe('@alice:friends.example')
  })

  it('keeps a signed-in account out of the empty shell when community loading fails', async () => {
    vi.spyOn(bridge, 'peekPendingInvitation').mockResolvedValue(null)
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'matrixLogin').mockResolvedValue(authenticatedMatrixStatus())
    vi.spyOn(bridge, 'matrixGetProfile').mockResolvedValue({
      userId: '@alice:friends.example',
      displayName: 'Alice',
      avatarUrl: null,
    })
    vi.spyOn(bridge, 'getCommunitiesResult').mockRejectedValue(new Error('community list offline'))

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
    })
    expect(eventHarness.onboardingProps).not.toBeNull()

    await act(async () => {
      await eventHarness.onboardingProps?.onMatrixLogin?.({
        homeserver: 'https://friends.example',
        username: '@alice:friends.example',
        password: 'correct horse battery staple',
      })
      await flushAsyncWork()
    })
    await act(async () => {
      eventHarness.onboardingProps?.onComplete()
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(container.textContent).toContain("Mesh couldn't load your communities")
    expect(container.textContent).toContain('Your account is still signed in')
    expect(container.textContent).not.toContain('App layout')
    expect(container.textContent).not.toContain('Welcome to Mesh')
    expect(useSettingsStore.getState().backupAccountId).toBe('@alice:friends.example')
  })

  it('activates the registered account before onboarding can schedule its reminder', async () => {
    vi.spyOn(bridge, 'peekPendingInvitation').mockResolvedValue(null)
    vi.spyOn(bridge, 'matrixRegisterAccount').mockResolvedValue(authenticatedMatrixStatus())
    vi.spyOn(bridge, 'matrixGetProfile').mockResolvedValue({
      userId: '@alice:friends.example',
      displayName: 'Alice',
      avatarUrl: null,
    })

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
    })
    await act(async () => {
      await eventHarness.onboardingProps?.onMatrixRegisterAccount?.({
        homeserver: 'https://friends.example',
        username: 'alice',
        password: 'correct horse battery staple',
        deviceName: 'Mesh Desktop',
      })
    })

    expect(useSettingsStore.getState().backupAccountId).toBe('@alice:friends.example')
    useSettingsStore.getState().scheduleBackupReminder()
    expect(useSettingsStore.getState().backupByAccount['@alice:friends.example']).toEqual({
      configured: false,
      reminderPending: true,
      dismissedAt: null,
    })
    expect(useSettingsStore.getState().backupByAccount).not.toHaveProperty(
      '__legacy_unscoped__',
    )
  })

  it('reports quarantined communities without exposing raw protocol details', async () => {
    const alpha = community('community-alpha')
    vi.spyOn(bridge, 'peekPendingInvitation').mockResolvedValue(null)
    vi.mocked(bridge.getBackendStatus).mockResolvedValue(authenticatedMatrixStatus())
    vi.spyOn(bridge, 'matrixGetProfile').mockResolvedValue({
      userId: '@alice:friends.example',
      displayName: 'Alice',
      avatarUrl: null,
    })
    vi.spyOn(bridge, 'getCommunitiesResult')
      .mockResolvedValueOnce({
        entities: [alpha],
        blockedEntities: [{
          entityId: '!unsafe:friends.example',
          entityKind: 'community',
          reason: 'unencrypted',
        }],
      })
      .mockResolvedValueOnce({ entities: [alpha], blockedEntities: [] })
    vi.spyOn(bridge, 'getChannels').mockResolvedValue([])

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(container.textContent).toContain('Mesh could not open 1 community safely')
    expect(container.textContent).toContain('Your account and service choice have not changed')
    expect(container.textContent).not.toContain('unencrypted')
    expect(container.textContent).not.toContain('!unsafe:friends.example')
    expect(container.textContent).toContain('App layout')

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Try again')
    await act(async () => {
      retry?.click()
      await flushAsyncWork()
      await flushAsyncWork()
    })
    expect(container.textContent).not.toContain('Mesh could not open 1 community safely')
  })

  it('repairs a cross-community active room before the selected refresh finishes', async () => {
    const alpha = community('community-alpha')
    const beta = community('community-beta')
    const alphaRoom = channel('room-alpha', alpha.id)
    const betaRoom = channel('room-beta', beta.id)
    const betaRefresh = deferred<Channel[]>()
    useCommunityStore.setState({
      communityEntities: { [alpha.id]: alpha, [beta.id]: beta },
      communityOrder: [alpha.id, beta.id],
      communities: [alpha, beta],
      activeCommunityId: beta.id,
    })
    useChannelStore.setState({
      channelEntities: { [alphaRoom.id]: alphaRoom, [betaRoom.id]: betaRoom },
      channelOrder: [alphaRoom.id, betaRoom.id],
      channels: [alphaRoom, betaRoom],
      activeChannelId: alphaRoom.id,
      refreshByCommunity: {},
      refreshRequests: {},
    })
    vi.spyOn(bridge, 'peekPendingInvitation').mockResolvedValue(null)
    const getChannels = vi.spyOn(bridge, 'getChannels').mockReturnValue(betaRefresh.promise)

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
    })

    expect(getChannels).toHaveBeenCalledWith(beta.id)
    expect(useChannelStore.getState().activeChannelId).toBe(betaRoom.id)
  })
})
