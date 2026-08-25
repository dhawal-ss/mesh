import { useCallback, useEffect, useRef, useState } from 'react'
import { useVoiceEngineController } from './VoiceEngineProvider'
import { playInterfaceSound } from '../../lib/interface-sounds'
import {
  resolveVoiceLifecycle,
  VOICE_FAILURE_THRESHOLD_MS,
  VOICE_RECONNECT_GRACE_MS,
  type VoiceLifecycleState,
} from '../../lib/voice-lifecycle'
import { resolveVoiceStatusIndicator, voiceConnectionLabel, type VoiceStatusIndicator } from '../../lib/voice-runtime'
import { useVoiceStore } from '../../store/voice'
import type { VoiceDevice } from '../../lib/voice-runtime-types'
import type { VoiceConnectionState, VoiceServiceStatus } from '../../types/ipc'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { AsyncStatus } from '../ui/AsyncStatus'
import { VoiceControls } from './VoiceControls'
import { AmbientNote, Eyebrow } from '../ui/QuietStructure'
import { VoicePeerGrid } from './VoicePeerGrid'

interface VoiceViewProps {
  channelId: string
  channelName: string
  onBackToChat: () => void
}

export function VoiceView({
  channelId,
  channelName,
  onBackToChat,
}: VoiceViewProps) {
  const {
    connectionWarning,
    microphonePermission,
    voiceService,
    matrixVoiceReady,
    devices,
    refreshDevices,
    switchInputDevice,
    switchOutputDevice,
    switchCameraDevice,
    updateAudioProcessing,
    setParticipantVolume,
    toggleCamera,
    toggleScreenSharing,
    stats,
  } = useVoiceEngineController()
  const connectionState = useVoiceStore((state) => state.connectionState)
  const currentCommunityId = useVoiceStore((state) => state.currentCommunityId)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)
  const peers = useVoiceStore((state) => state.peers)
  const isMuted = useVoiceStore((state) => state.isMuted)
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const setCurrentVoiceSession = useVoiceStore((state) => state.setCurrentVoiceSession)
  const setMuted = useVoiceStore((state) => state.setMuted)
  const setCameraEnabled = useVoiceStore((state) => state.setCameraEnabled)
  const setScreenSharing = useVoiceStore((state) => state.setScreenSharing)
  const [leaving, setLeaving] = useState(false)
  const [rosterOpen, setRosterOpen] = useState(false)
  const rosterButtonRef = useRef<HTMLButtonElement>(null)
  const previousConnectionState = useRef(connectionState)
  const reconnectStartedAt = useRef<number | null>(null)
  const previewVoice = import.meta.env.DEV
    && typeof document !== 'undefined'
    && document.documentElement.dataset.meshSimulateVoice === 'true'
  const capabilityAvailable = previewVoice || (
    voiceService.provider === 'matrix-rtc'
      ? matrixVoiceReady
      : voiceService.availability === 'ready'
  )
  const lifecycle = useVoiceLifecycle(
    connectionState,
    Boolean(currentCommunityId && currentChannelId),
    capabilityAvailable,
    leaving,
  )
  const localParticipantAlreadyIncluded = peers.some((peer) => peer.isSelf || peer.isLocal)
  const connectedOccupancy = ['connected', 'reconnect-grace', 'reconnecting'].includes(lifecycle)
    ? peers.length + (localParticipantAlreadyIncluded ? 0 : 1)
    : 0

  useEffect(() => {
    const previous = previousConnectionState.current
    if (connectionState === 'reconnecting' && previous !== 'reconnecting') {
      reconnectStartedAt.current = Date.now()
    }
    if (connectionState === 'connected') {
      if (previous === 'connecting') void playInterfaceSound('voice-self-join')
      if (
        previous === 'reconnecting'
        && reconnectStartedAt.current !== null
        && Date.now() - reconnectStartedAt.current >= 3_000
      ) {
        void playInterfaceSound('connection-recovered', {
          disruptionDurationMs: Date.now() - reconnectStartedAt.current,
        })
      }
      reconnectStartedAt.current = null
    }
    if (connectionState === 'disconnected' || connectionState === 'idle') {
      reconnectStartedAt.current = null
    }
    previousConnectionState.current = connectionState
  }, [connectionState])

  const retryJoin = useCallback(() => {
    const retryChannelId = currentChannelId ?? channelId
    const communityId = currentCommunityId
    if (!communityId) return
    setCurrentVoiceSession(null, null)
    requestAnimationFrame(() => setCurrentVoiceSession(communityId, retryChannelId))
  }, [channelId, currentChannelId, currentCommunityId, setCurrentVoiceSession])

  const leaveVoice = useCallback(() => {
    if (leaving) return
    setLeaving(true)
    setMuted(true)
    setCameraEnabled(false)
    setScreenSharing(false)
    setCurrentVoiceSession(null, null)
    void playInterfaceSound('voice-self-leave')
    requestAnimationFrame(onBackToChat)
  }, [leaving, onBackToChat, setCameraEnabled, setCurrentVoiceSession, setMuted, setScreenSharing])

  if (lifecycle === 'unavailable' || lifecycle === 'idle') {
    return (
      <VoiceUnavailable
        channelName={channelName}
        detail={voiceUnavailableDetail(voiceService)}
        onBackToChat={onBackToChat}
      />
    )
  }

  return (
    <section
      className="relative flex h-full min-h-0 w-full flex-col bg-surface-canvas"
      aria-labelledby="mesh-voice-heading"
      data-voice-join-latency-ms={stats.joinLatencyMs ?? undefined}
      data-voice-round-trip-ms={stats.roundTripTimeMs ?? undefined}
      data-voice-jitter-ms={stats.jitterMs ?? undefined}
      data-voice-packet-loss-percent={stats.packetLossPercent ?? undefined}
    >
      <header className="mesh-conversation-title-header flex flex-none flex-col gap-1.5 border-b border-rule border-border-structural">
        <span className="min-w-0 flex-1">
          <Eyebrow className="block truncate">
            {connectedOccupancy > 0
              ? `Voice room · ${connectedOccupancy} in call`
              : `Voice room · ${voiceLifecycleLabel(lifecycle, channelName)}`}
          </Eyebrow>
          <h1
            id="mesh-voice-heading"
            className="mt-1 truncate text-screen font-semibold text-content-primary outline-none"
            data-mesh-route-heading
            tabIndex={-1}
          >
            {channelName}
            <span className="sr-only"> voice room</span>
          </h1>
          {(() => {
            const indicator = resolveVoiceStatusIndicator({
              lifecycle,
              microphonePermission,
              isMuted,
              isDeafened,
              quality: stats.quality,
            })
            return (
              <span
                className={`mt-0.5 flex w-fit items-center gap-1 border-l-2 py-0.5 pl-1.5 text-caption ${voiceStatusToneClass(indicator.tone)}`}
                data-voice-status={indicator.tone}
                aria-label={`Call status: ${indicator.label}`}
              >
                <Icon name={indicator.icon} size="xs" aria-hidden="true" />
                {indicator.label}
              </span>
            )
          })()}
        </span>
        <button
          ref={rosterButtonRef}
          type="button"
          onClick={() => setRosterOpen(true)}
          className="flex min-h-10 items-center gap-2 px-2 text-xs font-semibold text-content-secondary hover:bg-surface-hover hover:text-content voice-wide:hidden"
          aria-controls="mesh-voice-roster-drawer"
          aria-expanded={rosterOpen}
          aria-label="Open people list"
        >
          <Icon name="users" size="sm" />
          <span className="hidden sm:inline">People</span>
        </button>
        <button
          type="button"
          onClick={onBackToChat}
          className="flex min-h-10 items-center gap-2 border border-border-subtle px-3 text-xs font-semibold text-content-secondary hover:bg-surface-hover hover:text-content"
          aria-label={`Open messages from ${channelName}`}
        >
          <Icon name="messageCircle" size="sm" />
          <span className="hidden voice-message:inline">Open messages</span>
        </button>
      </header>

      {microphonePermission === 'denied' ? (
        <div className="flex flex-none items-center gap-2 border-b border-container-danger-line bg-container-danger px-4 py-2 text-xs text-status-danger" role="alert">
          <Icon name="micOff" size="sm" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            Mesh cannot use your microphone. Allow access in system settings.
          </span>
          <button
            type="button"
            onClick={() => void refreshDevices(true)}
            className="min-h-9 px-2 font-semibold underline underline-offset-2"
          >
            Check again
          </button>
        </div>
      ) : null}

      {connectionWarning ? (
        <div className="flex flex-none items-center gap-2 border-b border-container-warning-line bg-container-warning px-4 py-2 text-xs text-status-warning" role="status">
          <Icon name="triangleAlert" size="sm" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <strong>Call audio needs attention.</strong> {connectionWarning}
          </span>
        </div>
      ) : null}

      {lifecycle === 'requesting' && microphonePermission === 'denied' ? (
        <VoicePreJoinDeviceCheck
          channelName={channelName}
          devices={devices}
          onRecheck={() => void refreshDevices(true)}
          onLeave={leaveVoice}
        />
      ) : lifecycle === 'requesting' ? (
        <VoiceProgressState
          title={`Joining ${channelName}`}
          detail="Keeping your place while voice connects."
          actionLabel="Cancel"
          onAction={leaveVoice}
        />
      ) : lifecycle === 'failed' ? (
        <VoiceFailureState onRetry={retryJoin} onLeave={leaveVoice} />
      ) : lifecycle === 'leaving' ? (
        <VoiceProgressState
          title={`Leaving ${channelName}`}
          detail="Your microphone and shared media are stopping now."
        />
      ) : (
        <VoicePeerGrid
          channelName={channelName}
          reconnecting={lifecycle === 'reconnecting'}
          rosterOpen={rosterOpen}
          onCloseRoster={() => {
            setRosterOpen(false)
            requestAnimationFrame(() => rosterButtonRef.current?.focus())
          }}
          onParticipantVolume={setParticipantVolume}
        />
      )}

      <div className="flex-none bg-surface-base">
        <VoiceControls
          devices={devices}
          roomName={channelName}
          leaving={leaving}
          onOpenMessages={onBackToChat}
          onLeave={leaveVoice}
          onInputDeviceChange={switchInputDevice}
          onOutputDeviceChange={switchOutputDevice}
          onCameraDeviceChange={switchCameraDevice}
          onAudioProcessingChange={updateAudioProcessing}
          onCameraChange={toggleCamera}
          onScreenShareChange={toggleScreenSharing}
        />
      </div>

      {/*
        The voice room's one ambient line. Media does not go through a Mesh
        server, and that is the single fact this screen owes a person who is
        wondering where their microphone is going.
      */}
      <AmbientNote>Media relayed peer to peer</AmbientNote>
    </section>
  )
}

function VoiceUnavailable({
  channelName,
  detail,
  onBackToChat,
}: {
  channelName: string
  detail: string
  onBackToChat: () => void
}) {
  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-surface-canvas" aria-labelledby="mesh-voice-heading">
      <header className="flex h-14 flex-none items-center gap-3 border-b border-border-subtle bg-surface-base px-4">
        <Icon name="volume" size="sm" className="text-content-muted" aria-hidden="true" />
        <h1
          id="mesh-voice-heading"
          className="truncate text-sm font-semibold text-content outline-none"
          data-mesh-route-heading
          tabIndex={-1}
        >
          {channelName}
          <span aria-hidden="true" className="hidden sm:inline"> voice</span>
          <span className="sr-only"> voice room</span>
        </h1>
        <span className="ml-auto text-caption text-content-muted">Unavailable</span>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="w-full max-w-lg border-y border-border-subtle px-6 py-10 text-center">
          <Icon name="phoneOff" size="lg" className="mx-auto text-content-muted" aria-hidden="true" />
          <h2 className="mt-5 text-lg font-semibold text-content">Voice is unavailable</h2>
          <p className="mt-2 text-sm text-content-secondary">{detail}</p>
          <Button className="mt-6" onClick={onBackToChat}>
            Back to messages
          </Button>
        </div>
      </div>
    </section>
  )
}

function voiceUnavailableDetail(service: VoiceServiceStatus): string {
  if (service.provider !== 'matrix-rtc') {
    return 'Voice is temporarily unavailable.'
  }
  if (service.availability === 'client-unavailable') {
    return 'This version of Mesh cannot start voice.'
  }
  if (service.availability === 'not-configured') {
    return 'Calling is not available for this account.'
  }
  if (!service.mediaE2eeReady) {
    return 'Mesh could not verify private call protection, so it kept your microphone and speakers off.'
  }
  return 'Voice is temporarily unavailable for this community.'
}

function VoiceProgressState({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string
  detail: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <AsyncStatus
        title={title}
        detail={detail}
        actions={actionLabel && onAction ? (
          <Button variant="secondary" onClick={onAction}>{actionLabel}</Button>
        ) : undefined}
      />
    </div>
  )
}

function VoiceFailureState({
  onRetry,
  onLeave,
}: {
  onRetry: () => void
  onLeave: () => void
}) {
  const reason = useVoiceStore((state) => state.lastReconnectReason)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center" role="alert">
      <Icon name="phoneOff" size="lg" className="text-status-danger" aria-hidden="true" />
      <h2 className="mt-4 text-base font-semibold text-content">Voice could not connect</h2>
      {reason ? (
        <p className="mt-2 max-w-md text-sm text-content-secondary">{reason}</p>
      ) : null}
      <div className="mt-5 flex gap-2">
        <Button onClick={onRetry}>Try again</Button>
        <Button variant="secondary" onClick={onLeave}>Leave voice</Button>
      </div>
    </div>
  )
}

function useVoiceLifecycle(
  connectionState: VoiceConnectionState,
  hasOwnedSession: boolean,
  capabilityAvailable: boolean,
  leaving: boolean,
): VoiceLifecycleState {
  const [timing, setTiming] = useState<{
    connectionState: VoiceConnectionState
    elapsedMs: number
  }>({ connectionState, elapsedMs: 0 })

  useEffect(() => {
    const timers = [window.setTimeout(() => {
      setTiming({ connectionState, elapsedMs: 0 })
    }, 0)]
    if (!hasOwnedSession || !capabilityAvailable || leaving) {
      return () => timers.forEach(window.clearTimeout)
    }
    const thresholds = connectionState === 'reconnecting'
      ? [VOICE_RECONNECT_GRACE_MS, VOICE_FAILURE_THRESHOLD_MS]
      : connectionState === 'connecting' || connectionState === 'idle'
        ? [VOICE_FAILURE_THRESHOLD_MS]
        : []
    timers.push(...thresholds.map((threshold) => window.setTimeout(() => {
        setTiming((current) => current.connectionState === connectionState
          ? { ...current, elapsedMs: threshold }
          : current)
      }, threshold)))
    return () => timers.forEach(window.clearTimeout)
  }, [capabilityAvailable, connectionState, hasOwnedSession, leaving])

  return resolveVoiceLifecycle({
    hasOwnedSession,
    capabilityAvailable,
    connectionState,
    stateElapsedMs: timing.connectionState === connectionState ? timing.elapsedMs : 0,
    leaving,
  })
}

function voiceLifecycleLabel(state: VoiceLifecycleState, channelName: string): string {
  switch (state) {
    case 'requesting':
      return `Joining ${channelName}`
    case 'reconnect-grace':
    case 'connected':
      return 'Voice connected'
    case 'reconnecting':
      return `Reconnecting to ${channelName}`
    case 'failed':
      return 'Voice could not connect'
    case 'leaving':
      return `Leaving ${channelName}`
    default:
      return voiceConnectionLabel('idle')
  }
}

function voiceStatusToneClass(tone: VoiceStatusIndicator['tone']): string {
  switch (tone) {
    case 'success':
      return 'text-status-success border-l-status-success'
    case 'warning':
      return 'text-status-warning border-l-status-warning'
    case 'danger':
      return 'text-status-danger border-l-status-danger'
    default:
      // Connected but unmeasured, or a neutral transition (joining/leaving/
      // muted): stay neutral rather than implying a colour-coded state we
      // have not actually measured.
      return 'text-content-secondary border-l-border-subtle'
  }
}

function VoicePreJoinDeviceCheck({
  channelName,
  devices,
  onRecheck,
  onLeave,
}: {
  channelName: string
  devices: VoiceDevice[]
  onRecheck: () => void
  onLeave: () => void
}) {
  const hasSpeaker = devices.some((device) => device.kind === 'audiooutput')
  const cameraDevice = devices.find((device) => device.kind === 'videoinput')
  const cameraStatus = !cameraDevice
    ? 'No camera detected'
    : cameraDevice.label
      ? 'Ready'
      : 'Permission not yet requested'

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center" role="alert">
      <Icon name="micOff" size="lg" className="text-status-danger" aria-hidden="true" />
      <div>
        <h2 className="text-base font-semibold text-content">Microphone blocked</h2>
        <p className="mt-2 max-w-md text-sm text-content-secondary">
          {channelName} is connecting without one. Allow access in system settings.
        </p>
      </div>
      <dl className="grid w-full max-w-xs grid-cols-device-check gap-x-3 gap-y-1 text-left text-xs text-content-secondary">
        <dt className="font-medium text-content">Speaker</dt>
        <dd>{hasSpeaker ? 'Ready' : 'No speaker detected'}</dd>
        <dt className="font-medium text-content">Camera</dt>
        <dd>{cameraStatus}</dd>
      </dl>
      <div className="flex gap-2">
        <Button onClick={onRecheck}>Check again</Button>
        <Button variant="secondary" onClick={onLeave}>Back to messages</Button>
      </div>
    </div>
  )
}
