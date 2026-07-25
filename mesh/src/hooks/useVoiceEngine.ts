import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VoiceEngine } from '../lib/voice-engine'
import type {
  LiveKitVoiceEngine,
  LiveKitVoiceStats,
  VoiceDevice,
} from '../lib/livekit-voice'
import type {
  MatrixRtcJoinResult,
  MatrixRtcMediaKey,
  MatrixRtcMediaKeyPause,
} from '../lib/bridge'
import {
  getBackendStatusSnapshot,
  getVoiceServiceStatus,
  matrixRtcAckMediaKey,
  matrixRtcAckMediaKeyPause,
  matrixRtcJoin,
  matrixRtcLeave,
  matrixRtcRefreshMembership,
  matrixRtcRenewMediaKeyLease,
  onMatrixRtcMediaKey,
  onMatrixRtcMediaKeyFailure,
  onMatrixRtcMediaKeyPause,
  onVoiceJoin,
  onVoiceLeave,
  onVoiceSession,
  onVoiceSessionEvent,
  onVoiceSignal,
  setDeafened as bridgeSetDeafened,
  setMuted as bridgeSetMuted,
} from '../lib/bridge'
import {
  canStartLegacyVoice,
  canStartMatrixVoice,
  isPushToTalkInteractiveTarget,
  shouldReleasePushToTalk,
  shouldPublishInitialMicrophone,
} from '../lib/voice-runtime'
import { describeError } from '../lib/errors'
import { useVoiceStore } from '../store/voice'

const EMPTY_STATS: LiveKitVoiceStats = {
  latencyMs: null,
  quality: 'unknown',
}

const MAX_PENDING_MEDIA_KEYS = 256
const MAX_PENDING_MEDIA_KEY_PAUSES = 32
const MATRIX_RTC_LEASE_RENEW_INTERVAL_MS = 1_000
const MATRIX_RTC_CONTROL_TIMEOUT_MS = 1_500
const MATRIX_RTC_ACTIVATION_TIMEOUT_MS = 20_000

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function useVoiceEngine() {
  const backendStatus = getBackendStatusSnapshot()
  const voiceService = getVoiceServiceStatus()
  const legacyVoiceReady = canStartLegacyVoice(backendStatus)
  const matrixVoiceReady = canStartMatrixVoice(backendStatus)

  const legacyEngineRef = useRef<VoiceEngine | null>(null)
  const liveKitEngineRef = useRef<LiveKitVoiceEngine | null>(null)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)
  const currentCommunityId = useVoiceStore((state) => state.currentCommunityId)
  const isMuted = useVoiceStore((state) => state.isMuted)
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const inputMode = useVoiceStore((state) => state.inputMode)
  const inputDeviceId = useVoiceStore((state) => state.inputDeviceId)
  const setPushToTalking = useVoiceStore((state) => state.setPushToTalking)
  const setMuted = useVoiceStore((state) => state.setMuted)
  const setSessionSnapshot = useVoiceStore((state) => state.setSessionSnapshot)
  const setConnectionState = useVoiceStore((state) => state.setConnectionState)
  const setPeers = useVoiceStore((state) => state.setPeers)
  const setLocalPublicKey = useVoiceStore((state) => state.setLocalPublicKey)
  const setLocalAudioLevel = useVoiceStore((state) => state.setLocalAudioLevel)
  const setCameraEnabled = useVoiceStore((state) => state.setCameraEnabled)
  const setScreenSharing = useVoiceStore((state) => state.setScreenSharing)
  const upsertPeer = useVoiceStore((state) => state.upsertPeer)
  const removePeer = useVoiceStore((state) => state.removePeer)
  const resetVoiceState = useVoiceStore((state) => state.resetVoiceState)
  const [connectionWarning, setConnectionWarning] = useState<string | null>(null)
  const [relayChanged, setRelayChanged] = useState(0)
  const [devices, setDevices] = useState<VoiceDevice[]>([])
  const [stats, setStats] = useState<LiveKitVoiceStats>(EMPTY_STATS)
  const inputDeviceIdRef = useRef(inputDeviceId)
  const isMutedRef = useRef(isMuted)
  const inputModeRef = useRef(inputMode)
  const pttKeyboardActiveRef = useRef(false)

  useEffect(() => {
    inputDeviceIdRef.current = inputDeviceId
  }, [inputDeviceId])

  useEffect(() => {
    isMutedRef.current = isMuted
  }, [isMuted])

  useEffect(() => {
    inputModeRef.current = inputMode
  }, [inputMode])

  const refreshDevices = useCallback(async (requestPermissions = false) => {
    const engine = liveKitEngineRef.current
    if (!engine) return
    try {
      setDevices(await engine.getDevices(requestPermissions))
    } catch (error) {
      const description = describeError(error, { operation: 'list audio devices' })
      setConnectionWarning(`${description.title}. ${description.body}`)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let matrixStatsTimer: ReturnType<typeof setInterval> | null = null
    let matrixMediaKeyUnlisten: (() => void) | null = null
    let matrixMediaKeyFailureUnlisten: (() => void) | null = null
    let matrixMediaKeyPauseUnlisten: (() => void) | null = null
    let matrixLeaseRenewTimer: ReturnType<typeof setInterval> | null = null
    let matrixLeaseCycle = 0
    let matrixLeaseRenewalInFlight = false
    let mediaKeyBufferOverflowed = false
    let mediaKeyPauseBufferOverflowed = false
    let mediaKeyDistributionFailed = false
    const pendingMediaKeys = new Map<string, MatrixRtcMediaKey>()
    const pendingMediaKeyPauses = new Map<string, MatrixRtcMediaKeyPause>()
    const unlistenTasks: Promise<() => void>[] = []

    const bufferMediaKey = (mediaKey: MatrixRtcMediaKey) => {
      const key = `${mediaKey.participantIdentity}:${mediaKey.keyIndex}`
      const existing = pendingMediaKeys.get(key)
      if (existing && existing.sentTs >= mediaKey.sentTs) return
      if (!existing && pendingMediaKeys.size >= MAX_PENDING_MEDIA_KEYS) {
        mediaKeyBufferOverflowed = true
        return
      }
      pendingMediaKeys.set(key, mediaKey)
    }

    const bufferMediaKeyPause = (pause: MatrixRtcMediaKeyPause) => {
      const key = `${pause.sessionId}:${pause.memberId}:${pause.activationId}`
      if (
        !pendingMediaKeyPauses.has(key) &&
        pendingMediaKeyPauses.size >= MAX_PENDING_MEDIA_KEY_PAUSES
      ) {
        mediaKeyPauseBufferOverflowed = true
        return
      }
      pendingMediaKeyPauses.set(key, pause)
    }

    const stopMatrixStats = () => {
      if (matrixStatsTimer !== null) {
        clearInterval(matrixStatsTimer)
        matrixStatsTimer = null
      }
    }

    const stopMatrixLeaseRenewal = () => {
      matrixLeaseCycle += 1
      if (matrixLeaseRenewTimer !== null) {
        clearInterval(matrixLeaseRenewTimer)
        matrixLeaseRenewTimer = null
      }
    }

    const failClosedMatrixMedia = (
      engine: LiveKitVoiceEngine,
      reason: string,
    ) => {
      stopMatrixLeaseRenewal()
      void engine.failClosedMediaEncryption(reason)
    }

    const startMatrixLeaseRenewal = (
      engine: LiveKitVoiceEngine,
      credentials: MatrixRtcJoinResult,
    ) => {
      stopMatrixLeaseRenewal()
      const leaseCycle = matrixLeaseCycle
      matrixLeaseRenewTimer = setInterval(() => {
        if (
          disposed ||
          liveKitEngineRef.current !== engine ||
          matrixLeaseRenewalInFlight ||
          leaseCycle !== matrixLeaseCycle
        ) {
          return
        }

        matrixLeaseRenewalInFlight = true
        const publicationGeneration = engine.publicationGeneration
        void withTimeout(
          matrixRtcRenewMediaKeyLease(
            credentials.roomId,
            credentials.sessionId,
            credentials.memberId,
          ),
          MATRIX_RTC_CONTROL_TIMEOUT_MS,
          'MatrixRTC publication lease renewal timed out',
        ).then((lease) => {
          if (
            disposed ||
            liveKitEngineRef.current !== engine ||
            leaseCycle !== matrixLeaseCycle
          ) {
            return
          }
          if (!engine.updatePublicationLease(lease, publicationGeneration)) {
            throw new Error('MatrixRTC publication lease renewal was stale')
          }
        }).catch(() => {
          if (
            disposed ||
            liveKitEngineRef.current !== engine ||
            leaseCycle !== matrixLeaseCycle
          ) {
            return
          }
          failClosedMatrixMedia(
            engine,
            'Private media publication lease could not be renewed',
          )
        }).finally(() => {
          matrixLeaseRenewalInFlight = false
        })
      }, MATRIX_RTC_LEASE_RENEW_INTERVAL_MS)
    }

    const startMatrixStats = (engine: LiveKitVoiceEngine) => {
      const refreshStats = () => {
        if (disposed || liveKitEngineRef.current !== engine) return
        void engine.getStats().then(setStats).catch(() => setStats(EMPTY_STATS))
      }

      stopMatrixStats()
      refreshStats()
      matrixStatsTimer = setInterval(refreshStats, 5000)
    }

    const destroyLegacyEngine = async () => {
      if (legacyEngineRef.current) {
        await legacyEngineRef.current.destroy().catch((error) => {
          console.error('Failed to destroy voice engine:', error)
        })
        legacyEngineRef.current = null
      }
    }

    const destroyMatrixEngine = async () => {
      stopMatrixStats()
      stopMatrixLeaseRenewal()
      const engine = liveKitEngineRef.current
      if (!engine) return
      const sessionId = engine.sessionId
      liveKitEngineRef.current = null
      await engine.disconnect(false).catch((error) => {
        console.error('Failed to disconnect from calling service:', error)
      })
      if (sessionId && currentChannelId) {
        await matrixRtcLeave(currentChannelId, sessionId).catch((error) => {
          console.error('Failed to clear voice membership:', error)
        })
      }
    }

    if (!currentCommunityId || !currentChannelId) {
      void destroyLegacyEngine()
      void destroyMatrixEngine()
      resetVoiceState()
      return
    }

    if (backendStatus?.kind === 'matrix') {
      void destroyLegacyEngine()
      setSessionSnapshot(null)

      if (!matrixVoiceReady) {
        setConnectionState('disconnected', voiceService.reason ?? 'Calling is unavailable')
        return
      }

      setConnectionState('connecting', null)

      const startMatrixEngine = async () => {
        setConnectionWarning(null)
        setStats(EMPTY_STATS)
        const { LiveKitVoiceEngine } = await import('../lib/livekit-voice')
        if (disposed) return

        const engine = new LiveKitVoiceEngine({
          onConnectionState: (state, reason) => setConnectionState(state, reason),
          onPeers: setPeers,
          onLocalMediaState: ({ cameraEnabled, screenShareEnabled }) => {
            setCameraEnabled(cameraEnabled)
            setScreenSharing(screenShareEnabled)
          },
          onLocalAudioLevel: setLocalAudioLevel,
          onDevicesChanged: () => void refreshDevices(),
          onWarning: setConnectionWarning,
          onError: (error) => {
            const description = describeError(error, { operation: 'use an audio device' })
            setConnectionWarning(`${description.title}. ${description.body}`)
          },
          onEncryptionFailure: (reason, sessionId) => {
            stopMatrixStats()
            stopMatrixLeaseRenewal()
            pendingMediaKeys.clear()
            pendingMediaKeyPauses.clear()
            matrixMediaKeyUnlisten?.()
            matrixMediaKeyUnlisten = null
            matrixMediaKeyFailureUnlisten?.()
            matrixMediaKeyFailureUnlisten = null
            matrixMediaKeyPauseUnlisten?.()
            matrixMediaKeyPauseUnlisten = null
            setConnectionWarning(reason)
            setCameraEnabled(false)
            setScreenSharing(false)
            setMuted(true)
            void (async () => {
              let membershipReleased = !sessionId
              if (sessionId) {
                try {
                  await matrixRtcLeave(currentChannelId, sessionId)
                  membershipReleased = true
                } catch {
                  // Keep the engine's retained session id for effect cleanup to retry.
                }
              }
              if (membershipReleased) {
                await engine.disconnect(false).catch(() => {})
                if (liveKitEngineRef.current === engine) {
                  liveKitEngineRef.current = null
                }
              }
            })()
          },
        })
        liveKitEngineRef.current = engine

        let credentials: MatrixRtcJoinResult | undefined
        const handlePublisherPause = (pause: MatrixRtcMediaKeyPause) => {
          const pauseOperation = engine.pausePublisherForActivation(pause)
          if (engine.activePublisherActivationId === pause.activationId) {
            stopMatrixLeaseRenewal()
          }

          void pauseOperation.then(async (result) => {
            if (result !== 'paused') return
            if (
              disposed ||
              !credentials ||
              liveKitEngineRef.current !== engine
            ) {
              throw new Error('MatrixRTC publisher activation is no longer current')
            }

            const candidate = await withTimeout(
              matrixRtcAckMediaKeyPause(
                pause.roomId,
                pause.sessionId,
                pause.memberId,
                pause.activationId,
              ),
              MATRIX_RTC_ACTIVATION_TIMEOUT_MS,
              'MatrixRTC publisher pause acknowledgement timed out',
            )
            await engine.installLocalActivationKey(pause, candidate)
            await withTimeout(
              matrixRtcAckMediaKey(
                pause.roomId,
                pause.sessionId,
                pause.memberId,
                pause.activationId,
                candidate.keyIndex,
                candidate.sentTs,
              ),
              MATRIX_RTC_ACTIVATION_TIMEOUT_MS,
              'MatrixRTC publisher key acknowledgement timed out',
            )

            const publicationGeneration = engine.publicationGeneration
            const lease = await withTimeout(
              matrixRtcRenewMediaKeyLease(
                pause.roomId,
                pause.sessionId,
                pause.memberId,
              ),
              MATRIX_RTC_CONTROL_TIMEOUT_MS,
              'MatrixRTC publication lease renewal timed out',
            )
            if (
              !engine.updatePublicationLease(
                lease,
                publicationGeneration,
                pause.activationId,
              )
            ) {
              throw new Error('MatrixRTC publisher activation lease was stale')
            }
            if (!await engine.resumePublisherAfterActivation(pause.activationId)) {
              throw new Error('MatrixRTC publisher activation could not resume')
            }
            startMatrixLeaseRenewal(engine, credentials)
          }).catch(() => {
            if (disposed || liveKitEngineRef.current !== engine) return
            failClosedMatrixMedia(
              engine,
              'Private media key activation failed',
            )
          })
        }

        try {
          matrixMediaKeyUnlisten = await onMatrixRtcMediaKey((mediaKey) => {
            if (mediaKey.roomId !== currentChannelId || disposed) return
            if (
              mediaKey.sessionId !== null ||
              mediaKey.activationId !== null
            ) {
              mediaKeyDistributionFailed = true
              failClosedMatrixMedia(
                engine,
                'A private media key update had invalid activation metadata',
              )
              return
            }
            if (!engine.canApplyMediaKeys) {
              bufferMediaKey(mediaKey)
              return
            }
            void engine.applyMediaKey(mediaKey).catch(() => {
              void engine.failClosedMediaEncryption(
                'A private media key update could not be applied',
              )
            })
          })
          matrixMediaKeyFailureUnlisten = await onMatrixRtcMediaKeyFailure(
            (failure) => {
              if (failure.roomId !== currentChannelId || disposed) return
              mediaKeyDistributionFailed = true
              pendingMediaKeys.clear()
              void engine.failClosedMediaEncryption(
                'Private media key distribution failed',
              )
            },
          )
          matrixMediaKeyPauseUnlisten = await onMatrixRtcMediaKeyPause(
            (pause) => {
              if (pause.roomId !== currentChannelId || disposed) return
              if (!credentials) {
                bufferMediaKeyPause(pause)
                return
              }
              if (
                pause.sessionId !== credentials.sessionId ||
                pause.memberId !== credentials.memberId
              ) {
                return
              }
              if (engine.sessionId !== pause.sessionId) {
                bufferMediaKeyPause(pause)
                return
              }
              handlePublisherPause(pause)
            },
          )
          if (disposed) {
            matrixMediaKeyUnlisten()
            matrixMediaKeyUnlisten = null
            matrixMediaKeyFailureUnlisten()
            matrixMediaKeyFailureUnlisten = null
            matrixMediaKeyPauseUnlisten()
            matrixMediaKeyPauseUnlisten = null
            return
          }

          credentials = await matrixRtcJoin(currentChannelId)
          if (disposed) {
            await matrixRtcLeave(currentChannelId, credentials.sessionId)
            credentials = undefined
            return
          }
          if (
            !credentials.mediaE2eeVerified ||
            mediaKeyBufferOverflowed ||
            mediaKeyPauseBufferOverflowed ||
            mediaKeyDistributionFailed
          ) {
            await matrixRtcLeave(currentChannelId, credentials.sessionId)
            credentials = undefined
            throw new Error('Private media encryption is not verified for this calling service')
          }
          const hasCurrentPendingPause = [...pendingMediaKeyPauses.values()].some(
            (pause) =>
              pause.sessionId === credentials?.sessionId &&
              pause.memberId === credentials?.memberId,
          )
          pendingMediaKeyPauses.clear()
          if (hasCurrentPendingPause) {
            await matrixRtcLeave(currentChannelId, credentials.sessionId)
            credentials = undefined
            throw new Error('A publisher-key rotation interrupted voice startup')
          }

          setLocalPublicKey(credentials.participantIdentity)
          const bufferedMediaKeys = [...pendingMediaKeys.values()]
          const remoteMediaKeys = bufferedMediaKeys.filter(
            (mediaKey) =>
              mediaKey.participantIdentity !== credentials?.participantIdentity,
          )
          pendingMediaKeys.clear()
          const initialLease = await withTimeout(
            matrixRtcRenewMediaKeyLease(
              credentials.roomId,
              credentials.sessionId,
              credentials.memberId,
            ),
            MATRIX_RTC_CONTROL_TIMEOUT_MS,
            'MatrixRTC publication lease acquisition timed out',
          )
          if (
            [...pendingMediaKeyPauses.values()].some(
              (pause) =>
                pause.sessionId === credentials?.sessionId &&
                pause.memberId === credentials?.memberId,
            )
          ) {
            pendingMediaKeyPauses.clear()
            await matrixRtcLeave(currentChannelId, credentials.sessionId)
            credentials = undefined
            throw new Error('A publisher-key rotation interrupted voice startup')
          }
          await engine.connect(
            credentials,
            inputDeviceIdRef.current,
            shouldPublishInitialMicrophone(isMutedRef.current, inputModeRef.current),
            credentials.mediaKey,
            remoteMediaKeys,
            initialLease,
          )
          for (const mediaKey of pendingMediaKeys.values()) {
            if (
              mediaKey.participantIdentity === credentials.participantIdentity
            ) {
              throw new Error(
                'A local publisher key arrived outside the activation protocol',
              )
            }
            await engine.applyMediaKey(mediaKey)
          }
          pendingMediaKeys.clear()
          if (disposed) return
          startMatrixLeaseRenewal(engine, credentials)
          startMatrixStats(engine)
          await refreshDevices(true)
        } catch (error) {
          console.error('Failed to start MatrixRTC voice:', error)
          stopMatrixLeaseRenewal()
          pendingMediaKeys.clear()
          pendingMediaKeyPauses.clear()
          matrixMediaKeyUnlisten?.()
          matrixMediaKeyUnlisten = null
          matrixMediaKeyFailureUnlisten?.()
          matrixMediaKeyFailureUnlisten = null
          matrixMediaKeyPauseUnlisten?.()
          matrixMediaKeyPauseUnlisten = null
          const sessionId = engine.sessionId ?? credentials?.sessionId
          let membershipReleased = !sessionId
          if (sessionId) {
            try {
              await matrixRtcLeave(currentChannelId, sessionId)
              membershipReleased = true
            } catch (leaveError) {
              console.error('Failed to clear voice membership after join failure:', leaveError)
            }
          }
          if (membershipReleased) {
            await engine.disconnect(false).catch((disconnectError) => {
              console.error('Failed to clean up calling service after join failure:', disconnectError)
            })
            if (liveKitEngineRef.current === engine) {
              liveKitEngineRef.current = null
            }
          }
          const description = describeError(error, { operation: 'start voice' })
          setConnectionState('disconnected', `${description.title}. ${description.body}`)
        }
      }

      void startMatrixEngine()

      return () => {
        disposed = true
        stopMatrixLeaseRenewal()
        pendingMediaKeys.clear()
        pendingMediaKeyPauses.clear()
        matrixMediaKeyUnlisten?.()
        matrixMediaKeyUnlisten = null
        matrixMediaKeyFailureUnlisten?.()
        matrixMediaKeyFailureUnlisten = null
        matrixMediaKeyPauseUnlisten?.()
        matrixMediaKeyPauseUnlisten = null
        void destroyMatrixEngine()
      }
    }

    if (!legacyVoiceReady) {
      setSessionSnapshot(null)
      setConnectionState('disconnected', voiceService.reason ?? 'Calling is unavailable')
      return
    }

    setConnectionState('connecting', null)
    setSessionSnapshot(null)

    const startLegacyEngine = async () => {
      const { VoiceEngine } = await import('../lib/voice-engine')
      if (disposed) return

      const engine = new VoiceEngine(currentCommunityId, currentChannelId, {
        onSessionSnapshot: setSessionSnapshot,
        onPeerUpsert: upsertPeer,
        onPeerRemove: removePeer,
        onConnectionState: (state, reason) => {
          if (!reason || state === 'connected') {
            setConnectionState(state, null)
            return
          }
          const description = describeError(reason, { operation: 'connect voice' })
          setConnectionState(state, `${description.title}. ${description.body}`)
        },
        onError: (message) => {
          console.error('Voice engine error:', message)
          const description = describeError(message, { operation: 'connect voice' })
          setConnectionState('disconnected', `${description.title}. ${description.body}`)
        },
        onRelayChanged: () => setRelayChanged((previous) => previous + 1),
        onConnectionWarning: setConnectionWarning,
      })

      legacyEngineRef.current = engine
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
      unlistenTasks.push(...listeners)

      await engine.start().catch((error) => {
        console.error('Failed to start voice engine:', error)
        const description = describeError(error, { operation: 'start voice' })
        setConnectionState('disconnected', `${description.title}. ${description.body}`)
      })
    }

    void startLegacyEngine()

    return () => {
      disposed = true
      void destroyLegacyEngine()
      void Promise.all(unlistenTasks).then((cleanups) => {
        for (const unlisten of cleanups) unlisten()
      })
    }
  }, [
    backendStatus?.kind,
    currentChannelId,
    currentCommunityId,
    legacyVoiceReady,
    matrixVoiceReady,
    refreshDevices,
    removePeer,
    resetVoiceState,
    setConnectionState,
    setCameraEnabled,
    setLocalAudioLevel,
    setLocalPublicKey,
    setMuted,
    setPeers,
    setScreenSharing,
    setSessionSnapshot,
    upsertPeer,
    voiceService.reason,
  ])

  useEffect(() => {
    if (liveKitEngineRef.current) {
      void liveKitEngineRef.current.setMuted(isMuted).catch((error) => {
        console.error('Failed to update microphone state:', error)
      })
      return
    }
    if (!legacyVoiceReady) return
    legacyEngineRef.current?.setMuted(isMuted)
    void bridgeSetMuted(isMuted).catch((error) => {
      console.error('Failed to sync mute state with backend:', error)
    })
  }, [isMuted, legacyVoiceReady])

  useEffect(() => {
    if (liveKitEngineRef.current) {
      liveKitEngineRef.current.setDeafened(isDeafened)
      return
    }
    if (!legacyVoiceReady) return
    void bridgeSetDeafened(isDeafened).catch((error) => {
      console.error('Failed to sync deafen state with backend:', error)
    })
  }, [isDeafened, legacyVoiceReady])

  useEffect(() => {
    if (inputMode !== 'push-to-talk') return

    const setTalking = (talking: boolean) => {
      setPushToTalking(talking)
      setMuted(!talking)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== 'Space' ||
        event.repeat ||
        isPushToTalkInteractiveTarget(event.target)
      ) return
      event.preventDefault()
      pttKeyboardActiveRef.current = true
      setTalking(true)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (!shouldReleasePushToTalk(event.code, pttKeyboardActiveRef.current)) return
      event.preventDefault()
      pttKeyboardActiveRef.current = false
      setTalking(false)
    }
    const onBlur = () => {
      if (!pttKeyboardActiveRef.current) return
      pttKeyboardActiveRef.current = false
      setTalking(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      pttKeyboardActiveRef.current = false
      setTalking(false)
    }
  }, [inputMode, setMuted, setPushToTalking])

  useEffect(() => {
    const onFocus = () => {
      const engine = liveKitEngineRef.current
      if (!engine?.sessionId || !currentChannelId) return
      void matrixRtcRefreshMembership(currentChannelId, engine.sessionId).catch((error) => {
        console.error('Failed to refresh voice membership:', error)
      })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [currentChannelId])

  const switchInputDevice = useCallback(async (deviceId: string) => {
    const switched = await liveKitEngineRef.current?.switchInputDevice(deviceId)
    if (!switched) throw new Error('The microphone could not be selected')
  }, [])

  const switchOutputDevice = useCallback(async (deviceId: string) => {
    const switched = await liveKitEngineRef.current?.switchOutputDevice(deviceId)
    if (!switched) throw new Error('This system does not support choosing a speaker')
  }, [])

  const setParticipantVolume = useCallback((identity: string, volume: number) => {
    liveKitEngineRef.current?.setParticipantVolume(identity, volume)
  }, [])

  const toggleCamera = useCallback(async (enabled: boolean) => {
    await liveKitEngineRef.current?.setCameraEnabled(enabled)
    setCameraEnabled(enabled)
  }, [setCameraEnabled])

  const toggleScreenShare = useCallback(async (enabled: boolean) => {
    await liveKitEngineRef.current?.setScreenShareEnabled(enabled)
    setScreenSharing(enabled)
  }, [setScreenSharing])

  const matrixUnavailableReason = useMemo(() => {
    if (backendStatus?.kind !== 'matrix' || matrixVoiceReady) return null
    if (!voiceService.mediaE2eeVerified) {
      return 'Private media encryption has not passed verification, so Mesh will not start the microphone.'
    }
    return voiceService.reason ?? 'Calling is unavailable.'
  }, [backendStatus?.kind, matrixVoiceReady, voiceService.mediaE2eeVerified, voiceService.reason])

  return {
    connectionWarning,
    relayChanged,
    voiceService,
    matrixVoiceReady,
    matrixUnavailableReason,
    devices,
    stats,
    refreshDevices,
    switchInputDevice,
    switchOutputDevice,
    setParticipantVolume,
    toggleCamera,
    toggleScreenShare,
  }
}
