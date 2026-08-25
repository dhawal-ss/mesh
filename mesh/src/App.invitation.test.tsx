import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Community, PendingInvitationMetadata } from './types/ipc'
import type { OnboardingFlowProps } from './components/onboarding/types'

type OnboardingHarnessProps = OnboardingFlowProps

const eventHarness = vi.hoisted(() => ({
  invitationReady: null as null | (() => void),
  onboardingProps: null as OnboardingHarnessProps | null,
  handlersByEvent: new Map<string, (event?: { payload?: unknown }) => void>(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (message?: { payload?: unknown }) => void) => {
    eventHarness.handlersByEvent.set(event, handler)
    eventHarness.invitationReady = handler
    return () => {
      if (eventHarness.invitationReady === handler) eventHarness.invitationReady = null
      if (eventHarness.handlersByEvent.get(event) === handler) {
        eventHarness.handlersByEvent.delete(event)
      }
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

vi.mock('./components/settings/DiagnosticsPanel', () => ({
  DiagnosticsPanel: ({ open }: { open: boolean }) => open ? <div>Connection check panel</div> : null,
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

import { isTauri } from '@tauri-apps/api/core'
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
    avatarUrl: null,
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
    topic: '',
    channelType: 'text',
    unreadCount: 0,
    joined: true,
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
    eventHarness.handlersByEvent.clear()
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
    vi.spyOn(bridge, 'ensureBackendStarted').mockResolvedValue({ phase: 'ready', issue: null })
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

  it('refreshes the community rail when Matrix reports a membership change', async () => {
    // matrix.rs never emits `community:updated`, so without this listener the
    // rail kept whatever bootstrap fetched: a space joined or left on another
    // device stayed invisible until restart.
    // test-setup.ts mocks the SDK's isTauri() to false for the whole suite, and
    // bridge.tauriListen returns a no-op subscription when it is. This test is
    // specifically about the subscription, so it opts back in.
    vi.mocked(isTauri).mockReturnValue(true)
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'peekPendingInvitation').mockResolvedValue(null)
    const listing = vi.spyOn(bridge, 'getCommunitiesResult').mockResolvedValue({
      entities: [community('space-1')],
      blockedEntities: [],
    })

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
    })

    const notify = eventHarness.handlersByEvent.get('matrix:communities-changed')
    expect(notify).toBeTypeOf('function')

    const before = listing.mock.calls.length
    await act(async () => {
      // Membership events arrive in bursts; one refetch should cover the burst.
      // The bridge wraps handlers as (message) => handler(message.payload), so
      // the harness holds the wrapper and has to be handed the event envelope.
      notify?.({ payload: undefined })
      notify?.({ payload: undefined })
      notify?.({ payload: undefined })
      await new Promise((resolve) => setTimeout(resolve, 300))
      await flushAsyncWork()
    })

    expect(listing.mock.calls.length).toBe(before + 1)
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

  it('keeps an invitation that arrives while an unrelated discard is in flight', async () => {
    // The mirror of the case above: the peek starts first and resolves last.
    // A shared counter bumped by the discard rejected this result, so the
    // newly saved invitation stayed durable natively and invisible in the UI,
    // with no path back: the mount peek had already run and the refresh effect
    // is gated on a pending handle the discard had just cleared.
    const olderInvitation = invitation('invite-a', 'Garden Club')
    const newerInvitation = invitation('invite-b', 'Book Club')
    const eventPeek = deferred<PendingInvitationMetadata | null>()
    const clearOlder = deferred<void>()
    vi.spyOn(bridge, 'peekPendingInvitation')
      .mockResolvedValueOnce(olderInvitation)
      .mockReturnValueOnce(eventPeek.promise)
    vi.spyOn(bridge, 'clearPendingInvitation').mockReturnValue(clearOlder.promise)

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
      await flushAsyncWork()
    })
    expect(eventHarness.onboardingProps?.initialPendingInvitation).toEqual(olderInvitation)

    // A second invitation link arrives, so the listener starts its peek.
    await act(async () => {
      eventHarness.invitationReady?.()
      await Promise.resolve()
    })

    let discard!: Promise<void>
    await act(async () => {
      discard = eventHarness.onboardingProps?.onDiscardPendingInvitation?.() ?? Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      eventPeek.resolve(newerInvitation)
      await flushAsyncWork()
    })
    expect(useShellStore.getState().pendingInvitation).toEqual(newerInvitation)

    await act(async () => {
      clearOlder.resolve()
      await discard
      await flushAsyncWork()
    })
    expect(useShellStore.getState().pendingInvitation).toEqual(newerInvitation)
    expect(eventHarness.onboardingProps?.initialPendingInvitation).toEqual(newerInvitation)
  })

  it('applies a discard even when a same-handle refresh bumps the peek sequence mid-clear', async () => {
    const pendingInvite = invitation('invite-a', 'Garden Club')
    const clearPending = deferred<void>()
    vi.spyOn(bridge, 'peekPendingInvitation')
      .mockResolvedValueOnce(pendingInvite)
      .mockResolvedValueOnce(pendingInvite)
    vi.spyOn(bridge, 'clearPendingInvitation').mockReturnValue(clearPending.promise)

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
      await flushAsyncWork()
    })
    expect(eventHarness.onboardingProps?.initialPendingInvitation).toEqual(pendingInvite)

    let discard!: Promise<void>
    await act(async () => {
      discard = eventHarness.onboardingProps?.onDiscardPendingInvitation?.() ?? Promise.resolve()
      await Promise.resolve()
    })
    // A refresh for the SAME invitation resolves while the discard is still
    // awaiting the backend clear. It must not resurrect the discarded handle,
    // and it must not cancel the clear either.
    await act(async () => {
      eventHarness.invitationReady?.()
      await flushAsyncWork()
    })
    expect(useShellStore.getState().pendingInvitation).toEqual(pendingInvite)

    await act(async () => {
      clearPending.resolve()
      await discard
    })
    // The discard is authoritative: the cleared invitation must leave the UI,
    // even though a concurrent same-handle refresh ran mid-clear. Guarding the
    // clear on the peek sequence would strand it on screen after the backend
    // clear had already removed it.
    expect(useShellStore.getState().pendingInvitation).toBeNull()
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
    expect(container.textContent).toContain('open sign-in and recovery if this keeps happening')
    expect(container.textContent).toContain('Try again')
    expect(container.textContent).toContain('Open connection check')
    expect(container.textContent).not.toContain('Onboarding')
    expect(eventHarness.onboardingProps).toBeNull()
  })

  it('shows a durable connection recovery state without treating the user as signed out', async () => {
    vi.spyOn(bridge, 'peekPendingInvitation').mockResolvedValue(null)
    vi.mocked(bridge.ensureBackendStarted).mockResolvedValue({
      phase: 'recoverable-failure',
      issue: 'connection-unavailable',
    })

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(container.textContent).toContain("Mesh couldn't restore your saved account offline")
    expect(container.textContent).toContain('Check your connection and try again')
    expect(bridge.getBackendStatus).not.toHaveBeenCalled()

    const diagnostics = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Open connection check')
    await act(async () => {
      diagnostics?.click()
      await flushAsyncWork()
    })
    expect(container.textContent).toContain('Connection check panel')
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
    vi.spyOn(bridge, 'getChannelsResult').mockResolvedValue({ entities: [], blockedEntities: [] })

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
    expect(bridge.ensureBackendStarted).toHaveBeenCalledWith(true)
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
    expect(container.textContent).toContain('Check your connection and try again')
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
    vi.spyOn(bridge, 'getChannelsResult').mockResolvedValue({ entities: [], blockedEntities: [] })

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(container.textContent).toContain('Mesh could not open 1 community safely')
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

  it('still opens the app when every community is quarantined', async () => {
    // The person who hits this has one community and it failed to open. Walling
    // off the whole shell took their direct messages, settings, sign-out, and the
    // ability to join anything else with it, none of which need a community.
    vi.spyOn(bridge, 'peekPendingInvitation').mockResolvedValue(null)
    vi.mocked(bridge.getBackendStatus).mockResolvedValue(authenticatedMatrixStatus())
    vi.spyOn(bridge, 'matrixGetProfile').mockResolvedValue({
      userId: '@alice:friends.example',
      displayName: 'Alice',
      avatarUrl: null,
    })
    vi.spyOn(bridge, 'getCommunitiesResult').mockResolvedValue({
      entities: [],
      blockedEntities: [{
        entityId: '!unsafe:friends.example',
        entityKind: 'community',
        reason: 'unencrypted',
      }],
    })
    vi.spyOn(bridge, 'getChannelsResult').mockResolvedValue({ entities: [], blockedEntities: [] })

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
      await flushAsyncWork()
    })

    expect(container.textContent).toContain('App layout')
    expect(container.textContent).toContain('Mesh could not open 1 community safely')
    // The banner now says what to do about it, without naming the protocol fact.
    expect(container.textContent).toContain('An owner has to turn protection on')
    expect(container.textContent).not.toContain('unencrypted')
    expect(container.textContent).not.toContain('!unsafe:friends.example')
    expect(container.textContent).not.toContain('Some communities need attention')
  })

  it('offers sign-in and connection check when the community list itself fails', async () => {
    vi.spyOn(bridge, 'peekPendingInvitation').mockResolvedValue(null)
    vi.mocked(bridge.getBackendStatus).mockResolvedValue(authenticatedMatrixStatus())
    vi.spyOn(bridge, 'matrixGetProfile').mockResolvedValue({
      userId: '@alice:friends.example',
      displayName: 'Alice',
      avatarUrl: null,
    })
    vi.spyOn(bridge, 'getCommunitiesResult').mockRejectedValue(new Error('listing unavailable'))
    vi.spyOn(bridge, 'getChannelsResult').mockResolvedValue({ entities: [], blockedEntities: [] })

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
      await flushAsyncWork()
    })

    const labels = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .map((button) => button.textContent?.trim())
    expect(labels).toContain('Try again')
    // Retrying the call that just failed cannot be the only way out.
    expect(labels).toContain('Open sign-in and recovery')
  })

  it('repairs a cross-community active room before the selected refresh finishes', async () => {
    const alpha = community('community-alpha')
    const beta = community('community-beta')
    const alphaRoom = channel('room-alpha', alpha.id)
    const betaRoom = channel('room-beta', beta.id)
    const betaRefresh = deferred<bridge.EntityListResult<Channel>>()
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
    const getChannels = vi.spyOn(bridge, 'getChannelsResult').mockReturnValue(betaRefresh.promise)

    await act(async () => {
      root.render(<App />)
      await flushAsyncWork()
    })

    expect(getChannels).toHaveBeenCalledWith(beta.id)
    expect(useChannelStore.getState().activeChannelId).toBe(betaRoom.id)
  })
})
