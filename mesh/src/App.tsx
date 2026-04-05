import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { OnboardingFlow } from './components/onboarding/OnboardingFlow'
import { AppLayout } from './components/layout/AppLayout'
import { ToastContainer } from './components/ui/Toast'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { useIdentityStore } from './store/identity'
import { useCommunityStore } from './store/communities'
import { useChannelStore } from './store/channels'
import { useNetworkStore } from './store/network'
import * as bridge from './lib/bridge'
import { Spinner } from './components/ui/Spinner'
import { variants } from './lib/motion'
import type { Identity } from './types/ipc'

const BOOTSTRAP_STEPS = {
  connecting: { label: 'Connecting to the DHT', progress: 28 },
  syncing: { label: 'Resolving nearby peers with mDNS', progress: 62 },
  finalizing: { label: 'Finalizing your local mesh state', progress: 88 },
  ready: { label: 'Mesh connection ready', progress: 100 },
} as const

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

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

export default function App() {
  const { identity, isLoading, setIdentity, setLoading } = useIdentityStore()
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const setCommunities = useCommunityStore((s) => s.setCommunities)
  const upsertCommunity = useCommunityStore((s) => s.upsertCommunity)
  const setActiveCommunity = useCommunityStore((s) => s.setActiveCommunity)
  const setChannels = useChannelStore((s) => s.setChannels)
  const setNetworkStatus = useNetworkStore((s) => s.setStatus)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const isTauriRuntime = bridge.isTauriRuntime()

  useEffect(() => {
    if (!isTauriRuntime) {
      setShowOnboarding(true)
      setLoading(false)
      return
    }

    const init = async () => {
      try {
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
    if (!isTauriRuntime) {
      return
    }

    if (!activeCommunityId) {
      setChannels([])
      return
    }

    let alive = true

    const loadChannels = async () => {
      try {
        const channels = await bridge.getChannels(activeCommunityId)
        if (alive) {
          setChannels(channels)
        }
      } catch (err) {
        console.error('Failed to load channels:', err)
      }
    }

    void loadChannels()

    return () => {
      alive = false
    }
  }, [activeCommunityId, isTauriRuntime, setChannels])

  useEffect(() => {
    if (!isTauriRuntime) {
      setNetworkStatus({
        state: 'connecting',
        peerCount: 0,
        averageLatency: 0,
      })
      return
    }

    const unlisten = bridge.onNetworkStatus((status) => {
      setNetworkStatus(mapNetworkState(status))
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [isTauriRuntime, setNetworkStatus])

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
        {showOnboarding || !identity ? (
          <ErrorBoundary level="app">
          <motion.div
            key="onboarding"
            variants={variants.screen}
            initial="initial"
            animate="animate"
            exit="exit"
            className="h-full"
          >
            <OnboardingFlow
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
              }}
            />
          </motion.div>
          </ErrorBoundary>
        ) : (
          <ErrorBoundary level="app">
          <motion.div
            key="app"
            variants={variants.screen}
            initial="initial"
            animate="animate"
            exit="exit"
            className="h-full"
          >
            <AppLayout />
          </motion.div>
          </ErrorBoundary>
        )}
      </AnimatePresence>
      <ToastContainer />
    </>
  )
}
