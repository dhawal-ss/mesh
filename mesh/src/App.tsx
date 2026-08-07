import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { AnimatePresence, motion } from './lib/lazy-motion'
import { OnboardingFlow } from './components/onboarding/OnboardingFlow'
import { showToast, ToastContainer } from './components/ui/Toast'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { useIdentityStore } from './store/identity'
import { useCommunityStore } from './store/communities'
import { useChannelStore } from './store/channels'
import { useNetworkStore } from './store/network'
import { refreshMatrixPreferences, useSettingsStore } from './store/settings'
import * as bridge from './lib/bridge'
import { variants } from './lib/motion'
import { AsyncStatus } from './components/ui/AsyncStatus'
import { Button } from './components/ui/Button'
import { matrixIdentity, matrixProfileIdentity } from './lib/matrixIdentity'
import type { Community, Identity } from './types/ipc'
import { registerPoll } from './lib/scheduler'
import { useShellStore } from './store/shell'
import { beginInvitationActivation } from './lib/invitation-activation'
import { clearRendererAccountState } from './lib/account-transition'
import { mapSettledWithConcurrency } from './lib/concurrency'

const AppLayout = lazy(() =>
  import('./components/layout/AppLayout').then((module) => ({
    default: module.AppLayout,
  })),
)
const BOOTSTRAP_STEPS = {
  connecting: { label: 'Connecting to the DHT', progress: 28 },
  syncing: { label: 'Resolving nearby peers with mDNS', progress: 62 },
  finalizing: { label: 'Finalizing your local mesh state', progress: 88 },
  ready: { label: 'Mesh connection ready', progress: 100 },
} as const

const MATRIX_BOOTSTRAP_STEPS = {
  connecting: { label: 'Connecting to Mesh', progress: 28 },
  syncing: { label: 'Getting your conversations', progress: 62 },
  finalizing: { label: 'Restoring recent messages', progress: 88 },
  ready: { label: 'Your conversations are ready', progress: 100 },
} as const

const MATRIX_STATUS_POLL_INTERVAL_MS = 5_000

type BootstrapIssue = {
  kind: 'startup' | 'communities'
  blockedCount: number
}

type CommunityLoadNotice = {
  blockedCount: number
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

async function loadMatrixIdentity(
  userId: string | null,
  isTauriRuntime: boolean,
): Promise<Identity | null> {
  const fallback = matrixIdentity(userId)
  if (!fallback || !isTauriRuntime) return fallback

  try {
    return matrixProfileIdentity(await bridge.matrixGetProfile())
  } catch (error) {
    // A profile server outage should not lock a signed-in user out of Mesh.
    // Editing remains explicit and will surface the server error in Settings.
    console.warn('Could not load Matrix profile; using the account ID fallback.', error)
    return fallback
  }
}

function isProfileComplete(identity: Identity | null) {
  return Boolean(identity?.displayName.trim()) && Boolean(identity?.avatarColor.trim())
}

function mapNetworkState(status: {
  connected: boolean
  peerCount: number
  averageLatency: number
  usingRelay: boolean
}) {
  return {
    state: status.connected ? 'connected' : status.usingRelay ? 'degraded' : 'connecting',
    peerCount: status.peerCount,
    averageLatency: status.averageLatency,
  } as const
}

function mapMatrixNetworkState(authenticated: boolean, syncRunning: boolean) {
  return {
    state: !authenticated ? 'connecting' : syncRunning ? 'connected' : 'disconnected',
    peerCount: 0,
    averageLatency: 0,
  } as const
}

function ColdStartStatus({
  invitationName,
  onRecovery,
}: {
  invitationName?: string | null
  onRecovery: () => void
}) {
  const [delayed, setDelayed] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setDelayed(true), 8_000)
    return () => window.clearTimeout(timer)
  }, [])

  const destination = invitationName?.trim()
  return (
    <AsyncStatus
      title={delayed
        ? 'Mesh is taking longer to open'
        : destination
          ? `Opening invitation to ${destination}`
          : 'Opening Mesh'}
      detail={delayed
        ? 'Try again, or open sign-in and recovery if this keeps happening.'
        : destination
          ? 'Keeping this destination ready while Mesh checks access.'
          : 'Restoring your rooms and settings.'}
      actions={delayed ? (
        <>
          <Button onClick={() => window.location.reload()}>Try again</Button>
          <Button variant="secondary" onClick={onRecovery}>Sign-in and recovery</Button>
          <Button variant="ghost" onClick={() => window.close()}>Close Mesh</Button>
        </>
      ) : undefined}
    />
  )
}

function BootstrapRecovery({
  issue,
  retrying,
  onRetry,
  onOpenSignInRecovery,
}: {
  issue: BootstrapIssue
  retrying: boolean
  onRetry: () => void
  onOpenSignInRecovery?: () => void
}) {
  const blockedLabel = `${issue.blockedCount} communit${issue.blockedCount === 1 ? 'y' : 'ies'}`
  const title = issue.kind === 'startup'
    ? "Mesh couldn't open your saved account"
    : issue.blockedCount > 0
      ? 'Some communities need attention'
      : "Mesh couldn't load your communities"
  const detail = issue.kind === 'startup'
    ? 'Your saved account has not been replaced. Try again, or open sign-in and recovery if this keeps happening.'
    : issue.blockedCount > 0
      ? `Mesh kept ${blockedLabel} hidden because it could not open ${issue.blockedCount === 1 ? 'it' : 'them'} safely. Your account and service choice have not changed.`
      : 'Your account is still signed in. Check your connection and try again; your account service and communities remain separate.'

  return (
    <AsyncStatus
      title={title}
      detail={detail}
      assertive
      actions={(
        <>
          <Button disabled={retrying} onClick={onRetry}>
            {retrying ? 'Trying again…' : 'Try again'}
          </Button>
          {onOpenSignInRecovery ? (
            <Button variant="secondary" disabled={retrying} onClick={onOpenSignInRecovery}>
              Open sign-in and recovery
            </Button>
          ) : null}
        </>
      )}
    />
  )
}

function CommunityLoadBanner({
  notice,
  retrying,
  onRetry,
}: {
  notice: CommunityLoadNotice
  retrying: boolean
  onRetry: () => void
}) {
  const label = `${notice.blockedCount} communit${notice.blockedCount === 1 ? 'y' : 'ies'}`
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-status-warning/30 bg-status-warning/10 px-4 py-2 text-xs text-content"
    >
      <span>
        Mesh could not open {label} safely. Your account and service choice have not changed.
      </span>
      <Button variant="ghost" size="sm" disabled={retrying} onClick={onRetry}>
        {retrying ? 'Trying again…' : 'Try again'}
      </Button>
    </div>
  )
}

export default function App() {
  const isTauriRuntime = bridge.isTauriRuntime()
  const identity = useIdentityStore((state) => state.identity)
  const isLoading = useIdentityStore((state) => state.isLoading)
  const setIdentity = useIdentityStore((state) => state.setIdentity)
  const setLoading = useIdentityStore((state) => state.setLoading)
  const clearIdentity = useIdentityStore((state) => state.clear)
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const communityIdsKey = useCommunityStore((s) => s.communityOrder.join('\u0000'))
  const setCommunities = useCommunityStore((s) => s.setCommunities)
  const upsertCommunity = useCommunityStore((s) => s.upsertCommunity)
  const setChannels = useChannelStore((s) => s.setChannels)
  const replaceCommunityChannels = useChannelStore((s) => s.replaceCommunityChannels)
  const setCommunityRefresh = useChannelStore((s) => s.setCommunityRefresh)
  const channelRefreshRequests = useChannelStore((s) => s.refreshRequests)
  const channelRefreshRequestsKey = Object.entries(channelRefreshRequests)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, attempt]) => `${id}:${attempt}`)
    .join('\u0000')
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const setNetworkStatus = useNetworkStore((s) => s.setStatus)
  const activateBackupAccount = useSettingsStore((s) => s.activateBackupAccount)
  const scheduleBackupReminder = useSettingsStore((s) => s.scheduleBackupReminder)
  const pendingInvitation = useShellStore((state) => state.pendingInvitation)
  const setPendingInvitation = useShellStore((state) => state.setPendingInvitation)
  const [showOnboarding, setShowOnboarding] = useState(!isTauriRuntime)
  const [backendStatus, setBackendStatus] = useState<bridge.BackendStatus | null>(null)
  const [bootstrapIssue, setBootstrapIssue] = useState<BootstrapIssue | null>(null)
  const [bootstrapRetrying, setBootstrapRetrying] = useState(false)
  const [communityLoadNotice, setCommunityLoadNotice] = useState<CommunityLoadNotice | null>(null)
  const [communityNoticeRetrying, setCommunityNoticeRetrying] = useState(false)
  const [initializationAttempt, setInitializationAttempt] = useState(0)
  const pendingInvitationEpochRef = useRef(0)

  const applyCommunityListing = useCallback((listing: bridge.EntityListResult<Community>) => {
    setCommunities(listing.entities)
    const blockedCount = listing.blockedEntities.length
    setCommunityLoadNotice(
      blockedCount > 0 && listing.entities.length > 0 ? { blockedCount } : null,
    )
    return {
      blockedCount,
      allBlocked: blockedCount > 0 && listing.entities.length === 0,
    }
  }, [setCommunities])

  useEffect(() => {
    if (!isTauriRuntime) return
    const openExternalLink = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest<HTMLAnchorElement>('a[target="_blank"][href]')
      if (!anchor) return
      event.preventDefault()
      void bridge.openExternalUrl(anchor.href).catch((error) => {
        console.error('Could not open external link:', error)
        showToast('Mesh could not open that secure link. Copy it and review the address.', 'error')
      })
    }
    document.addEventListener('click', openExternalLink, true)
    return () => document.removeEventListener('click', openExternalLink, true)
  }, [isTauriRuntime])

  useEffect(() => {
    if (!isTauriRuntime) return
    let active = true
    const epoch = ++pendingInvitationEpochRef.current
    void bridge
      .peekPendingInvitation()
      .then((pending) => {
        if (active && pendingInvitationEpochRef.current === epoch) {
          setPendingInvitation(pending)
        }
      })
      .catch((error) => {
        if (active && pendingInvitationEpochRef.current === epoch) {
          console.warn('Could not inspect the pending invitation:', error)
        }
      })
    return () => {
      active = false
    }
  }, [isTauriRuntime, setPendingInvitation])

  useEffect(() => {
    if (!isTauriRuntime) return
    let active = true
    let unlisten: (() => void) | undefined

    void listen('mesh-pending-invitation-ready', () => {
      if (!active) return
      const epoch = ++pendingInvitationEpochRef.current
      void bridge.peekPendingInvitation()
        .then((pending) => {
          if (!active || pendingInvitationEpochRef.current !== epoch) return
          setPendingInvitation(pending)
          if (pending) {
            showToast('Community invitation saved securely and ready to review.', 'success')
          }
        })
        .catch((error) => {
          if (!active || pendingInvitationEpochRef.current !== epoch) return
          console.warn('Could not inspect the saved community invitation:', error)
          showToast(
            'Mesh saved the invitation, but could not show its details yet. Try opening it again.',
            'error',
          )
        })
    })
      .then((cleanup) => {
        if (active) unlisten = cleanup
        else cleanup()
      })
      .catch((error) => {
        if (active) console.error('Could not listen for saved community invitations:', error)
      })

    return () => {
      active = false
      unlisten?.()
    }
  }, [isTauriRuntime, setPendingInvitation])

  useEffect(() => {
    if (!pendingInvitation) return
    beginInvitationActivation(pendingInvitation.handle, pendingInvitation.storedAt)
  }, [pendingInvitation])

  useEffect(() => {
    let active = true
    if (!isTauriRuntime) {
      void bridge.getBackendStatus().then((status) => {
        if (!active) return
        setBackendStatus(status)
        setBootstrapIssue(null)
        setLoading(false)
      })
      return () => {
        active = false
      }
    }

    const init = async () => {
      let phase: BootstrapIssue['kind'] = 'startup'
      try {
        const nextBackendStatus = await bridge.getBackendStatus()
        if (!active) return
        setBackendStatus(nextBackendStatus)

        if (nextBackendStatus.kind === 'matrix') {
          if (nextBackendStatus.authenticated) {
            activateBackupAccount(nextBackendStatus.userId)
            const signedInIdentity = await loadMatrixIdentity(
              nextBackendStatus.userId,
              isTauriRuntime,
            )
            if (!active) return
            phase = 'communities'
            const listing = await bridge.getCommunitiesResult()
            if (!active) return
            const listingState = applyCommunityListing(listing)
            if (listingState.allBlocked) {
              setBootstrapIssue({
                kind: 'communities',
                blockedCount: listingState.blockedCount,
              })
              setLoading(false)
              return
            }
            if (signedInIdentity) {
              setIdentity(signedInIdentity)
            }
          }
          setBootstrapIssue(null)
          setShowOnboarding(!nextBackendStatus.authenticated)
          setLoading(false)
          return
        }

        const existingIdentity = await bridge.getIdentity()
        if (!active) return
        if (!existingIdentity) {
          setShowOnboarding(true)
          setLoading(false)
          return
        }

        phase = 'communities'
        const listing = await bridge.getCommunitiesResult()
        if (!active) return
        const listingState = applyCommunityListing(listing)
        if (listingState.allBlocked) {
          setBootstrapIssue({
            kind: 'communities',
            blockedCount: listingState.blockedCount,
          })
          setLoading(false)
          return
        }
        setIdentity(existingIdentity)
        setBootstrapIssue(null)
        setShowOnboarding(!isProfileComplete(existingIdentity))
      } catch (err) {
        if (!active) return
        console.error('Init error:', err)
        setBootstrapIssue({ kind: phase, blockedCount: 0 })
        setLoading(false)
      }
    }

    void init()
    return () => {
      active = false
    }
  }, [
    activateBackupAccount,
    applyCommunityListing,
    initializationAttempt,
    isTauriRuntime,
    setIdentity,
    setLoading,
  ])

  const retryCommunityBootstrap = useCallback(async () => {
    setBootstrapRetrying(true)
    try {
      const listing = await bridge.getCommunitiesResult()
      const listingState = applyCommunityListing(listing)
      if (listingState.allBlocked) {
        setBootstrapIssue({
          kind: 'communities',
          blockedCount: listingState.blockedCount,
        })
        return
      }
      setBootstrapIssue(null)
      setShowOnboarding(false)
    } catch (error) {
      console.error('Failed to retry the community list:', error)
      setBootstrapIssue({ kind: 'communities', blockedCount: 0 })
    } finally {
      setBootstrapRetrying(false)
      setLoading(false)
    }
  }, [applyCommunityListing, setLoading])

  const openSignInRecovery = useCallback(() => {
    const previousAccountId = backendStatus?.userId ?? null
    clearRendererAccountState(previousAccountId)
    clearIdentity()
    setBackendStatus((current) => current ? {
      ...current,
      authenticated: false,
      userId: null,
      deviceId: null,
      syncRunning: false,
      sessionE2eeReady: false,
    } : null)
    setBootstrapIssue(null)
    setShowOnboarding(true)
    setLoading(false)
  }, [backendStatus?.userId, clearIdentity, setLoading])

  const completeMatrixOnboarding = useCallback(async () => {
    activateBackupAccount(backendStatus?.userId ?? null)
    setShowOnboarding(false)
    setBootstrapIssue(null)
    setLoading(true)
    try {
      const listing = await bridge.getCommunitiesResult()
      const listingState = applyCommunityListing(listing)
      if (listingState.allBlocked) {
        setBootstrapIssue({
          kind: 'communities',
          blockedCount: listingState.blockedCount,
        })
      }
    } catch (error) {
      console.error('Failed to load communities after onboarding:', error)
      setBootstrapIssue({ kind: 'communities', blockedCount: 0 })
    } finally {
      setLoading(false)
    }
  }, [activateBackupAccount, applyCommunityListing, backendStatus?.userId, setLoading])

  const retryCommunityNotice = useCallback(async () => {
    setCommunityNoticeRetrying(true)
    try {
      const listing = await bridge.getCommunitiesResult()
      const listingState = applyCommunityListing(listing)
      if (listingState.allBlocked) {
        setBootstrapIssue({
          kind: 'communities',
          blockedCount: listingState.blockedCount,
        })
      }
    } catch (error) {
      console.error('Failed to retry hidden communities:', error)
      showToast(
        "Mesh still couldn't open those communities. Check your connection and try again.",
        'error',
      )
    } finally {
      setCommunityNoticeRetrying(false)
    }
  }, [applyCommunityListing])

  const retryBootstrap = useCallback(() => {
    if (bootstrapIssue?.kind === 'startup') {
      setBootstrapIssue(null)
      setLoading(true)
      setInitializationAttempt((attempt) => attempt + 1)
      return
    }
    void retryCommunityBootstrap()
  }, [bootstrapIssue?.kind, retryCommunityBootstrap, setLoading])

  useEffect(() => {
    if (!isTauriRuntime || backendStatus?.kind !== 'matrix') {
      return
    }

    setNetworkStatus(mapMatrixNetworkState(backendStatus.authenticated, backendStatus.syncRunning))
  }, [
    backendStatus?.authenticated,
    backendStatus?.kind,
    backendStatus?.syncRunning,
    isTauriRuntime,
    setNetworkStatus,
  ])

  useEffect(() => {
    if (!isTauriRuntime || backendStatus?.kind !== 'matrix') {
      return
    }

    let alive = true
    const unregisterPoll = registerPoll({
      key: 'matrix-backend-status',
      intervalMs: MATRIX_STATUS_POLL_INTERVAL_MS,
      pauseWhenHidden: true,
      backoffOnError: true,
      run: async () => {
        try {
          const nextStatus = await bridge.getBackendStatus()
          if (alive) {
            setBackendStatus(nextStatus)
          }
        } catch (error) {
          if (alive) {
            setNetworkStatus({
              state: 'disconnected',
              peerCount: 0,
              averageLatency: 0,
            })
            console.warn('Could not refresh connection status; Mesh will retry.', error)
          }
          throw error
        }
      },
    })

    return () => {
      alive = false
      unregisterPoll()
    }
  }, [backendStatus?.kind, isTauriRuntime, setNetworkStatus])

  useEffect(() => {
    const pendingHandle = pendingInvitation?.handle
    if (
      !isTauriRuntime ||
      showOnboarding ||
      backendStatus?.kind !== 'matrix' ||
      !backendStatus.authenticated ||
      !pendingHandle
    ) {
      return
    }
    let active = true
    const epoch = ++pendingInvitationEpochRef.current
    void bridge
      .peekPendingInvitation()
      .then((describedPending) => {
        if (
          active
          && pendingInvitationEpochRef.current === epoch
          && describedPending?.handle === pendingHandle
        ) {
          setPendingInvitation(describedPending)
        }
      })
      .catch((error) => {
        if (active && pendingInvitationEpochRef.current === epoch) {
          console.warn('Could not refresh community invitation details:', error)
        }
      })
    return () => {
      active = false
    }
  }, [
    backendStatus?.authenticated,
    backendStatus?.kind,
    isTauriRuntime,
    pendingInvitation?.handle,
    setPendingInvitation,
    showOnboarding,
  ])

  const clearPendingInvitationForHandle = async (handle: string | undefined) => {
    const epoch = ++pendingInvitationEpochRef.current
    if (isTauriRuntime && handle) await bridge.clearPendingInvitation(handle)
    if (
      pendingInvitationEpochRef.current !== epoch
      || useShellStore.getState().pendingInvitation?.handle !== handle
    ) return
    setPendingInvitation(null)
  }

  useEffect(() => {
    if (!isTauriRuntime) {
      return
    }

    const communityIds = communityIdsKey ? communityIdsKey.split('\u0000') : []
    if (communityIds.length === 0) {
      setChannels([])
      return
    }

    let alive = true

    const prioritizedCommunityIds = activeCommunityId && communityIds.includes(activeCommunityId)
      ? [activeCommunityId, ...communityIds.filter((id) => id !== activeCommunityId)]
      : communityIds

    const repairSelection = () => {
      const state = useChannelStore.getState()
      const selected = state.activeChannelId
        ? state.channelEntities[state.activeChannelId]
        : undefined
      if (selected?.communityId === activeCommunityId) return
      setActiveChannel(
        state.channelOrder.find(
          (channelId) => state.channelEntities[channelId]?.communityId === activeCommunityId,
        ) ?? null,
      )
    }

    // Community navigation is local state and must be repaired immediately.
    // Waiting for the selected community's network refresh can otherwise leave
    // a room from the previous community interactive under the new selection.
    repairSelection()

    const loadCommunity = async (communityId: string) => {
      if (!alive) return
      const state = useChannelStore.getState()
      const current = state.refreshByCommunity[communityId]
      const generation = (current?.generation ?? 0) + 1
      const hasLastGood = state.channels.some((channel) => channel.communityId === communityId)
      setCommunityRefresh(communityId, {
        status: hasLastGood ? 'stale' : 'loading',
        error: null,
        generation,
      })
      try {
        const channels = await bridge.getChannels(communityId)
        if (!alive) return
        const latest = useChannelStore.getState().refreshByCommunity[communityId]
        if (latest?.generation !== generation) return
        replaceCommunityChannels(communityId, channels)
        setCommunityRefresh(communityId, { status: 'loaded', error: null, generation })
        if (communityId === activeCommunityId) repairSelection()
      } catch (error) {
        if (!alive) return
        const latest = useChannelStore.getState().refreshByCommunity[communityId]
        if (latest?.generation !== generation) return
        const stillHasLastGood = useChannelStore.getState().channels.some(
          (channel) => channel.communityId === communityId,
        )
        setCommunityRefresh(communityId, {
          status: stillHasLastGood ? 'stale' : 'failed',
          error,
          generation,
        })
        if (communityId === activeCommunityId) repairSelection()
        console.error(`Failed to refresh rooms for community ${communityId}:`, error)
      }
    }

    void (async () => {
      const [selectedCommunityId, ...remainingCommunityIds] = prioritizedCommunityIds
      if (selectedCommunityId) await loadCommunity(selectedCommunityId)
      if (!alive) return
      await mapSettledWithConcurrency(remainingCommunityIds, 4, loadCommunity, () => alive)
    })()

    return () => {
      alive = false
    }
  }, [
    activeCommunityId,
    channelRefreshRequestsKey,
    communityIdsKey,
    isTauriRuntime,
    replaceCommunityChannels,
    setActiveChannel,
    setChannels,
    setCommunityRefresh,
  ])

  useEffect(() => {
    const userId =
      backendStatus?.kind === 'matrix' && backendStatus.authenticated ? backendStatus.userId : null
    if (!isTauriRuntime || !userId) return

    let alive = true
    const unregisterPoll = registerPoll({
      key: `matrix-preferences:${userId}`,
      intervalMs: 30_000,
      run: async () => {
        try {
          await refreshMatrixPreferences(userId)
        } catch (error) {
          if (alive) console.error('Failed to refresh Matrix preferences:', error)
          throw error
        }
      },
      pauseWhenHidden: true,
      backoffOnError: true,
    })
    return () => {
      alive = false
      unregisterPoll()
    }
  }, [backendStatus?.authenticated, backendStatus?.kind, backendStatus?.userId, isTauriRuntime])

  useEffect(() => {
    if (!isTauriRuntime) {
      setNetworkStatus({
        state: 'connecting',
        peerCount: 0,
        averageLatency: 0,
      })
      return
    }

    if (backendStatus?.kind === 'matrix') {
      return
    }

    const unlisten = bridge.onNetworkStatus((status) => {
      setNetworkStatus(mapNetworkState(status))
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [backendStatus, isTauriRuntime, setNetworkStatus])

  useEffect(() => {
    if (!isTauriRuntime) {
      return
    }

    const unlisten = bridge.onCommunityUpdated((community) => {
      upsertCommunity(community)
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [isTauriRuntime, upsertCommunity])

  if (bootstrapIssue) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-canvas px-4">
        <BootstrapRecovery
          issue={bootstrapIssue}
          retrying={bootstrapRetrying}
          onRetry={retryBootstrap}
          onOpenSignInRecovery={bootstrapIssue.kind === 'startup' ? () => {
            setBootstrapIssue(null)
            setBootstrapRetrying(false)
            setShowOnboarding(true)
            setLoading(false)
          } : undefined}
        />
      </div>
    )
  }

  if (isLoading && !showOnboarding) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-canvas">
        <ColdStartStatus
          invitationName={pendingInvitation?.communityName}
          onRecovery={() => {
            setShowOnboarding(true)
            setLoading(false)
          }}
        />
      </div>
    )
  }

  return (
    <>
      <AnimatePresence mode="wait">
        {showOnboarding || (backendStatus?.kind === 'legacy-p2p' && !identity) ? (
          <ErrorBoundary scope="app">
            <motion.div
              key="onboarding"
              variants={variants.screen}
              initial="initial"
              animate="animate"
              exit="exit"
              className="h-full"
            >
              <OnboardingFlow
                initialPendingInvitation={pendingInvitation}
                onDiscardPendingInvitation={async () => {
                  const handle = pendingInvitation?.handle
                  await clearPendingInvitationForHandle(handle)
                }}
                backendKind={backendStatus?.kind ?? 'matrix'}
                backendAuthenticated={backendStatus?.authenticated ?? false}
                onMatrixCheckUsernameAvailable={async (homeserver, username) => {
                  if (!isTauriRuntime) {
                    return !['admin', 'support', 'taken'].includes(username)
                  }
                  return bridge.matrixCheckUsernameAvailable(homeserver, username)
                }}
                onMatrixRegisterAccount={async (request) => {
                  if (!isTauriRuntime) {
                    const status: bridge.BackendStatus = {
                      kind: 'matrix',
                      capabilities: bridge.getBackendCapabilities(),
                      voiceService: bridge.getVoiceServiceStatus(),
                      authenticated: true,
                      userId: `@${request.username}:preview.mesh`,
                      deviceId: 'PREVIEW',
                      homeserver: 'https://preview.mesh',
                      syncRunning: true,
                      durableHistory: true,
                      supportsE2ee: true,
                      sessionE2eeReady: true,
                      warnings: [],
                    }
                    setBackendStatus(status)
                    const registeredIdentity = await loadMatrixIdentity(status.userId, false)
                    if (registeredIdentity) setIdentity(registeredIdentity)
                    return
                  }
                  const status = await bridge.matrixRegisterAccount(request)
                  activateBackupAccount(status.userId)
                  setBackendStatus(status)
                  const registeredIdentity = await loadMatrixIdentity(status.userId, true)
                  if (registeredIdentity) setIdentity(registeredIdentity)
                }}
                onMatrixLogin={async (request) => {
                  if (!isTauriRuntime) {
                    const status: bridge.BackendStatus = {
                      kind: 'matrix',
                      capabilities: bridge.getBackendCapabilities(),
                      voiceService: bridge.getVoiceServiceStatus(),
                      authenticated: true,
                      userId: '@preview:example.com',
                      deviceId: 'PREVIEW',
                      homeserver: request.homeserver,
                      syncRunning: true,
                      durableHistory: true,
                      supportsE2ee: true,
                      sessionE2eeReady: true,
                      warnings: [],
                    }
                    setBackendStatus(status)
                    const signedInIdentity = await loadMatrixIdentity(status.userId, false)
                    if (signedInIdentity) setIdentity(signedInIdentity)
                    return
                  }
                  const status = await bridge.matrixLogin(request)
                  activateBackupAccount(status.userId)
                  setBackendStatus(status)
                  const signedInIdentity = await loadMatrixIdentity(status.userId, true)
                  if (signedInIdentity) setIdentity(signedInIdentity)
                }}
                onMatrixOidcLogin={async (homeserver) => {
                  const status = await bridge.matrixStartOidcLogin(homeserver)
                  activateBackupAccount(status.userId)
                  setBackendStatus(status)
                  const signedInIdentity = await loadMatrixIdentity(status.userId, true)
                  if (signedInIdentity) setIdentity(signedInIdentity)
                }}
                onMatrixSwitchAccount={async (profileId) => {
                  const status = await bridge.matrixSwitchAccount(profileId)
                  activateBackupAccount(status.userId)
                  setBackendStatus(status)
                  const signedInIdentity = await loadMatrixIdentity(status.userId, true)
                  if (signedInIdentity) setIdentity(signedInIdentity)
                }}
                onBackupSkipped={scheduleBackupReminder}
                initialProfile={identity ?? undefined}
                onGenerateIdentity={async () => {
                  if (!isTauriRuntime) {
                    setIdentity({
                      publicKey: 'preview-local-identity',
                      displayName: '',
                      avatarColor: '',
                    })
                    return
                  }

                  const nextIdentity = await bridge.createIdentity()
                  setIdentity(nextIdentity)
                }}
                onUpdateProfile={async (profile) => {
                  if (!isTauriRuntime) {
                    setIdentity({
                      publicKey: identity?.publicKey ?? 'preview-local-identity',
                      displayName: profile.displayName,
                      avatarColor: profile.avatarColor,
                    })
                    return
                  }

                  const nextIdentity = await bridge.updateProfile(
                    profile.displayName,
                    profile.avatarColor,
                  )
                  setIdentity(nextIdentity)
                }}
                onBootstrap={async (update) => {
                  if (backendStatus?.kind === 'matrix') {
                    update({
                      phase: 'connecting',
                      ...MATRIX_BOOTSTRAP_STEPS.connecting,
                    })
                    if (!isTauriRuntime) {
                      await wait(450)
                      update({
                        phase: 'syncing',
                        ...MATRIX_BOOTSTRAP_STEPS.syncing,
                      })
                      await wait(450)
                      update({
                        phase: 'ready',
                        ...MATRIX_BOOTSTRAP_STEPS.ready,
                      })
                      return
                    }

                    update({
                      phase: 'syncing',
                      ...MATRIX_BOOTSTRAP_STEPS.syncing,
                    })
                    // Matrix login/session restoration already completes an initial sync
                    // before starting the continuous background sync loop. Starting a
                    // second sync here can contend with that loop and leave onboarding
                    // waiting indefinitely.
                    update({
                      phase: 'finalizing',
                      ...MATRIX_BOOTSTRAP_STEPS.finalizing,
                    })
                    update({ phase: 'ready', ...MATRIX_BOOTSTRAP_STEPS.ready })
                    return
                  }

                  update({
                    phase: 'connecting',
                    ...BOOTSTRAP_STEPS.connecting,
                  })

                  if (!isTauriRuntime) {
                    await wait(700)
                    update({ phase: 'syncing', ...BOOTSTRAP_STEPS.syncing })
                    await wait(850)
                    update({
                      phase: 'finalizing',
                      label: 'Browser preview mode. Use tauri dev for live mesh bootstrap.',
                      progress: BOOTSTRAP_STEPS.finalizing.progress,
                    })
                    await wait(550)
                    update({
                      phase: 'ready',
                      label: 'Preview ready',
                      progress: BOOTSTRAP_STEPS.ready.progress,
                    })
                    return
                  }

                  const unlistenPromise = bridge.onNetworkStatus((status) => {
                    if (status.peerCount > 0) {
                      update({
                        phase: 'syncing',
                        label: `Resolved ${status.peerCount} peer${status.peerCount === 1 ? '' : 's'} on the mesh`,
                        progress: 74,
                      })
                    }
                  })

                  try {
                    await wait(700)
                    update({ phase: 'syncing', ...BOOTSTRAP_STEPS.syncing })

                    await wait(850)
                    const { status } = useNetworkStore.getState()
                    update({
                      phase: 'finalizing',
                      label:
                        status.peerCount > 0
                          ? `Connected to ${status.peerCount} peer${status.peerCount === 1 ? '' : 's'}`
                          : BOOTSTRAP_STEPS.finalizing.label,
                      progress: BOOTSTRAP_STEPS.finalizing.progress,
                    })

                    await wait(550)
                    const latest = useNetworkStore.getState().status
                    update({
                      phase: 'ready',
                      label:
                        latest.peerCount > 0
                          ? BOOTSTRAP_STEPS.ready.label
                          : 'Ready. Nearby peers will appear as they come online.',
                      progress: BOOTSTRAP_STEPS.ready.progress,
                    })
                  } finally {
                    const unlisten = await unlistenPromise
                    unlisten()
                  }
                }}
                onComplete={() => {
                  if (isTauriRuntime && bridge.isMatrixBackend()) {
                    void completeMatrixOnboarding()
                    return
                  }
                  setShowOnboarding(false)
                }}
              />
            </motion.div>
          </ErrorBoundary>
        ) : (
          <ErrorBoundary scope="app">
            <motion.div
              key="app"
              variants={variants.screen}
              initial="initial"
              animate="animate"
              exit="exit"
              className="flex h-full min-h-0 flex-col"
            >
              {communityLoadNotice ? (
                <CommunityLoadBanner
                  notice={communityLoadNotice}
                  retrying={communityNoticeRetrying}
                  onRetry={() => void retryCommunityNotice()}
                />
              ) : null}
              <div className="min-h-0 flex-1">
                <Suspense
                  fallback={
                    <div
                      className="flex h-full flex-col items-center justify-center gap-3 text-center"
                    >
                      <AsyncStatus
                        title={pendingInvitation
                          ? `Opening invitation to ${pendingInvitation.communityName?.trim() || 'your community'}`
                          : 'Bringing in your rooms'}
                        detail={pendingInvitation
                          ? 'Keeping this destination ready while Mesh checks access.'
                          : 'You can keep this window open while Mesh prepares the first view.'}
                      />
                    </div>
                  }
                >
                  <AppLayout onSignInRequired={openSignInRecovery} />
                </Suspense>
              </div>
            </motion.div>
          </ErrorBoundary>
        )}
      </AnimatePresence>
      <ToastContainer />
    </>
  )
}
