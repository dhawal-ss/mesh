import { useEffect, useRef, useState } from 'react'
import type { VoiceEngine } from '../lib/voice-engine'
import {
  getBackendStatusSnapshot,
  getVoiceServiceStatus,
  onVoiceJoin,
  onVoiceLeave,
  onVoiceSession,
  onVoiceSessionEvent,
  onVoiceSignal,
  setDeafened as bridgeSetDeafened,
  setMuted as bridgeSetMuted,
} from '../lib/bridge'
import { canStartLegacyVoice } from '../lib/voice-runtime'
import { useVoiceStore } from '../store/voice'

export function useVoiceEngine() {
  const voiceService = getVoiceServiceStatus()
  const legacyVoiceReady = canStartLegacyVoice(getBackendStatusSnapshot())
  const engineRef = useRef<VoiceEngine | null>(null)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)
  const currentCommunityId = useVoiceStore((state) => state.currentCommunityId)
  const isMuted = useVoiceStore((state) => state.isMuted)
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const setSessionSnapshot = useVoiceStore((state) => state.setSessionSnapshot)
  const setConnectionState = useVoiceStore((state) => state.setConnectionState)
  const upsertPeer = useVoiceStore((state) => state.upsertPeer)
  const removePeer = useVoiceStore((state) => state.removePeer)
  const resetVoiceState = useVoiceStore((state) => state.resetVoiceState)
  const [connectionWarning, setConnectionWarning] = useState<string | null>(null)
  const [relayChanged, setRelayChanged] = useState(0)

  useEffect(() => {
    let disposed = false
    const unlistenTasks: Promise<() => void>[] = []

    const destroyEngine = async () => {
      if (engineRef.current) {
        await engineRef.current.destroy().catch((error) => {
          console.error('Failed to destroy voice engine:', error)
        })
        engineRef.current = null
      }
    }

    if (!currentCommunityId || !currentChannelId) {
      void destroyEngine()
      resetVoiceState()
      return
    }

    if (!legacyVoiceReady) {
      void destroyEngine()
      setSessionSnapshot(null)
      setConnectionState('disconnected', voiceService.reason ?? 'Calling is unavailable')
      return
    }

    setConnectionState('connecting', null)
    setSessionSnapshot(null)

    const startEngine = async () => {
      const { VoiceEngine } = await import('../lib/voice-engine')
      if (disposed) {
        return
      }

      const engine = new VoiceEngine(currentCommunityId ?? '', currentChannelId, {
        onSessionSnapshot: (snapshot) => {
          setSessionSnapshot(snapshot)
        },
        onPeerUpsert: (peer) => {
          upsertPeer(peer)
        },
        onPeerRemove: (publicKey) => {
          removePeer(publicKey)
        },
        onConnectionState: (state, reason) => {
          setConnectionState(state, reason ?? null)
        },
        onError: (message) => {
          console.error('Voice engine error:', message)
          setConnectionState('disconnected', message)
        },
        onRelayChanged: () => {
          setRelayChanged((prev) => prev + 1)
        },
        onConnectionWarning: (message) => {
          setConnectionWarning(message)
        },
      })

      engineRef.current = engine

      const listeners = [
        onVoiceSession((snapshot) => {
          if (snapshot.communityId === currentCommunityId && snapshot.channelId === currentChannelId) {
            engine.applySessionSnapshot(snapshot)
          }
        }),
        onVoiceSessionEvent((event) => {
          if (event.communityId === currentCommunityId && event.channelId === currentChannelId) {
            engine.applySessionEvent(event)
          }
        }),
        onVoiceSignal((signal) => {
          if (signal.communityId === currentCommunityId && signal.channelId === currentChannelId) {
            engine.handleVoiceSignal(signal)
          }
        }),
        onVoiceJoin((data) => {
          if (data.communityId === currentCommunityId && data.channelId === currentChannelId) {
            engine.handleLegacyJoin(data)
          }
        }),
        onVoiceLeave((data) => {
          if (data.communityId === currentCommunityId && data.channelId === currentChannelId) {
            engine.handleLegacyLeave(data)
          }
        }),
      ]

      for (const listener of listeners) {
        unlistenTasks.push(listener)
      }

      await engine.start().catch((error) => {
        console.error('Failed to start voice engine:', error)
        setConnectionState('disconnected', error instanceof Error ? error.message : 'Failed to start voice engine')
      })
    }

    void startEngine()

    return () => {
      disposed = true
      void destroyEngine()
      void Promise.all(unlistenTasks).then((cleanups) => {
        for (const unlisten of cleanups) {
          unlisten()
        }
      })
    }
  }, [
    currentChannelId,
    currentCommunityId,
    legacyVoiceReady,
    removePeer,
    resetVoiceState,
    setConnectionState,
    setSessionSnapshot,
    upsertPeer,
    voiceService.reason,
  ])

  useEffect(() => {
    if (!legacyVoiceReady) return
    if (engineRef.current) {
      engineRef.current.setMuted(isMuted)
    }

    void bridgeSetMuted(isMuted).catch((error) => {
      console.error('Failed to sync mute state with backend:', error)
    })
  }, [isMuted, legacyVoiceReady])

  useEffect(() => {
    if (!legacyVoiceReady) return
    void bridgeSetDeafened(isDeafened).catch((error) => {
      console.error('Failed to sync deafen state with backend:', error)
    })
  }, [isDeafened, legacyVoiceReady])

  return { engine: engineRef.current, connectionWarning, relayChanged, voiceService }
}
