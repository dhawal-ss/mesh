import { lazy, Suspense, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { OnboardingFlow } from './components/onboarding/OnboardingFlow'
import { ToastContainer } from './components/ui/Toast'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { useIdentityStore } from './store/identity'
import { useCommunityStore } from './store/communities'
import { useChannelStore } from './store/channels'
import { useNetworkStore } from './store/network'
import { refreshMatrixPreferences, useSettingsStore } from './store/settings'
import * as bridge from './lib/bridge'
import { Spinner } from './components/ui/Spinner'
import { variants } from './lib/motion'
import { matrixIdentity, matrixProfileIdentity } from './lib/matrixIdentity'
import type { Identity } from './types/ipc'
import { registerPoll } from './lib/scheduler'

const AppLayout = lazy(() =>
  import('./components/layout/AppLayout').then((module) => ({ default: module.AppLayout })),
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

function mapNetworkState(status: { connected: boolean; peerCount: number; averageLatency: number; usingRelay: boolean }) {
  return {
    state: status.connected
      ? 'connected'
      : status.usingRelay
        ? 'degraded'
        : 'connecting',
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

export default function App() {
  const identity = useIdentityStore((state) => state.identity)
  const isLoading = useIdentityStore((state) => state.isLoading)
  const setIdentity = useIdentityStore((state) => state.setIdentity)
  const setLoading = useIdentityStore((state) => state.setLoading)
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const communityIdsKey = useCommunityStore((s) => s.communityOrder.join('\u0000'))
  const setCommunities = useCommunityStore((s) => s.setCommunities)
  const upsertCommunity = useCommunityStore((s) => s.upsertCommunity)
  const setActiveCommunity = useCommunityStore((s) => s.setActiveCommunity)
  const setChannels = useChannelStore((s) => s.setChannels)
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const setNetworkStatus = useNetworkStore((s) => s.setStatus)
  const setBackupConfigured = useSettingsStore((s) => s.setBackupConfigured)
  const scheduleBackupReminder = useSettingsStore((s) => s.scheduleBackupReminder)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [backendStatus, setBackendStatus] = useState<bridge.BackendStatus | null>(null)
  const isTauriRuntime = bridge.isTauriRuntime()

  useEffect(() => {
    if (!isTauriRuntime) {
      setShowOnboarding(true)
      setLoading(false)
      void bridge.getBackendStatus().then(setBackendStatus)
      return
    }

    const init = async () => {
      try {
        const nextBackendStatus = await bridge.getBackendStatus()
        setBackendStatus(nextBackendStatus)

        if (nextBackendStatus.kind === 'matrix') {
          if (nextBackendStatus.authenticated) {
            const signedInIdentity = await loadMatrixIdentity(
              nextBackendStatus.userId,
              isTauriRuntime,
            )
            if (signedInIdentity) {
              setIdentity(signedInIdentity)
            }
            const communities = await bridge.getCommunities()
            setCommunities(communities)
            setActiveCommunity(communities[0]?.id ?? null)
          }
          setShowOnboarding(!nextBackendStatus.authenticated)
          setLoading(false)
          return
        }

        const existingIdentity = await bridge.getIdentity()
        if (!existingIdentity) {
          setShowOnboarding(true)
          setLoading(false)
          return
        }

        setIdentity(existingIdentity)

        const communities = await bridge.getCommunities()
        setCommunities(communities)

        if (communities.length > 0) {
          setActiveCommunity(communities[0].id)
        }

        setShowOnboarding(!isProfileComplete(existingIdentity))
      } catch (err) {
        console.error('Init error:', err)
        setShowOnboarding(true)
        setLoading(false)
      }
    }

    void init()
  }, [isTauriRuntime, setActiveCommunity, setCommunities, setIdentity, setLoading])

  useEffect(() => {
    if (!isTauriRuntime || backendStatus?.kind !== 'matrix') {
      return
    }

    setNetworkStatus(mapMatrixNetworkState(backendStatus.authenticated, backendStatus.syncRunning))
  }, [backendStatus?.authenticated, backendStatus?.kind, backendStatus?.syncRunning, isTauriRuntime, setNetworkStatus])

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
    if (!isTauriRuntime) {
      return
    }

    const communityIds = communityIdsKey ? communityIdsKey.split('\u0000') : []
    if (communityIds.length === 0) {
      setChannels([])
      return
    }

    let alive = true

    const loadChannels = async () => {
      try {
        const channels = (
          await Promise.all(communityIds.map((communityId) => bridge.getChannels(communityId)))
        ).flat()
        if (alive) {
          setChannels(channels)
          const currentActiveChannelId = useChannelStore.getState().activeChannelId
          const currentActiveChannel = currentActiveChannelId
            ? channels.find((channel) => channel.id === currentActiveChannelId)
            : undefined
          if (currentActiveChannel?.communityId !== activeCommunityId) {
            setActiveChannel(
              channels.find((channel) => channel.communityId === activeCommunityId)?.id ?? null,
            )
          }
        }
      } catch (err) {
        console.error('Failed to load channels:', err)
      }
    }

    void loadChannels()

    return () => {
      alive = false
    }
  }, [
    activeCommunityId,
    communityIdsKey,
    isTauriRuntime,
    setActiveChannel,
    setChannels,
  ])

  useEffect(() => {
    const userId = backendStatus?.kind === 'matrix' && backendStatus.authenticated
      ? backendStatus.userId
      : null
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

  if (isLoading && !showOnboarding) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <div className="flex flex-col items-center gap-3">
          <Spinner size={24} />
          <p className="text-sm text-muted">Loading...</p>
        </div>
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
              backendKind={backendStatus?.kind ?? 'matrix'}
              backendAuthenticated={backendStatus?.authenticated ?? false}
              onMatrixCheckUsernameAvailable={async (username) => {
                if (!isTauriRuntime) {
                  return !['admin', 'support', 'taken'].includes(username)
                }
                return bridge.matrixCheckUsernameAvailable(username)
              }}
              onMatrixRegisterAccount={async (username, password) => {
                if (!isTauriRuntime) {
                  const status: bridge.BackendStatus = {
                    kind: 'matrix',
                    capabilities: bridge.getBackendCapabilities(),
                    voiceService: bridge.getVoiceServiceStatus(),
                    authenticated: true,
                    userId: `@${username}:preview.mesh`,
                    deviceId: 'PREVIEW',
                    homeserver: 'https://preview.mesh',
                    syncRunning: true,
                    durableHistory: true,
                    endToEndEncryption: true,
                    warnings: [],
                  }
                  setBackendStatus(status)
                  const registeredIdentity = await loadMatrixIdentity(status.userId, false)
                  if (registeredIdentity) setIdentity(registeredIdentity)
                  return
                }
                const status = await bridge.matrixRegisterAccount(username, password)
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
                    endToEndEncryption: true,
                    warnings: [],
                  }
                  setBackendStatus(status)
                  const signedInIdentity = await loadMatrixIdentity(status.userId, false)
                  if (signedInIdentity) setIdentity(signedInIdentity)
                  return
                }
                const status = await bridge.matrixLogin(request)
                setBackendStatus(status)
                const signedInIdentity = await loadMatrixIdentity(status.userId, true)
                if (signedInIdentity) setIdentity(signedInIdentity)
              }}
              onMatrixSwitchAccount={async (profileId) => {
                const status = await bridge.matrixSwitchAccount(profileId)
                setBackendStatus(status)
                const signedInIdentity = await loadMatrixIdentity(status.userId, true)
                if (signedInIdentity) setIdentity(signedInIdentity)
              }}
              onCreateBackupCode={async () => {
                if (!isTauriRuntime) {
                  return 'MESH-FROST-LANTERN-HARBOR-COPPER-ORBIT-MEADOW'
                }
                return bridge.matrixEnableRecovery()
              }}
              onBackupConfigured={() => setBackupConfigured(true)}
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

                const nextIdentity = await bridge.updateProfile(profile.displayName, profile.avatarColor)
                setIdentity(nextIdentity)
              }}
              onBootstrap={async (update) => {
                if (backendStatus?.kind === 'matrix') {
                  update({ phase: 'connecting', ...MATRIX_BOOTSTRAP_STEPS.connecting })
                  if (!isTauriRuntime) {
                    await wait(450)
                    update({ phase: 'syncing', ...MATRIX_BOOTSTRAP_STEPS.syncing })
                    await wait(450)
                    update({ phase: 'ready', ...MATRIX_BOOTSTRAP_STEPS.ready })
                    return
                  }

                  update({ phase: 'syncing', ...MATRIX_BOOTSTRAP_STEPS.syncing })
                  // Matrix login/session restoration already completes an initial sync
                  // before starting the continuous background sync loop. Starting a
                  // second sync here can contend with that loop and leave onboarding
                  // waiting indefinitely.
                  update({ phase: 'finalizing', ...MATRIX_BOOTSTRAP_STEPS.finalizing })
                  update({ phase: 'ready', ...MATRIX_BOOTSTRAP_STEPS.ready })
                  return
                }

                update({ phase: 'connecting', ...BOOTSTRAP_STEPS.connecting })

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
                setShowOnboarding(false)
                if (isTauriRuntime && bridge.isMatrixBackend()) {
                  void bridge.getCommunities().then((communities) => {
                    setCommunities(communities)
                    setActiveCommunity(communities[0]?.id ?? null)
                  }).catch((error) => {
                    console.error('Failed to load Matrix communities after onboarding:', error)
                  })
                }
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
            className="h-full"
          >
            <Suspense fallback={<div className="flex h-full items-center justify-center" role="status" aria-label="Loading Mesh"><Spinner /></div>}>
              <AppLayout />
            </Suspense>
          </motion.div>
          </ErrorBoundary>
        )}
      </AnimatePresence>
      <ToastContainer />
    </>
  )
}
