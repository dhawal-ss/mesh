import { useCallback, useEffect, useRef, useState } from 'react'
import { useVoiceEngine } from '../../hooks/useVoiceEngine'
import { playInterfaceSound } from '../../lib/interface-sounds'
import {
  resolveVoiceLifecycle,
  VOICE_FAILURE_THRESHOLD_MS,
  VOICE_RECONNECT_GRACE_MS,
  type VoiceLifecycleState,
} from '../../lib/voice-lifecycle'
import { voiceConnectionLabel } from '../../lib/voice-runtime'
import { useVoiceStore } from '../../store/voice'
import type { VoiceConnectionState } from '../../types/ipc'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { AsyncStatus } from '../ui/AsyncStatus'
import { VoiceControls } from './VoiceControls'
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
    setParticipantVolume,
    toggleCamera,
    toggleScreenShare,
  } = useVoiceEngine()
  const connectionState = useVoiceStore((state) => state.connectionState)
  const currentCommunityId = useVoiceStore((state) => state.currentCommunityId)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)
  const peers = useVoiceStore((state) => state.peers)
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
  const connectedOccupancy = ['connected', 'reconnect-grace', 'reconnecting'].includes(lifecycle)
    ? peers.length + 1
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
        onBackToChat={onBackToChat}
      />
    )
  }

  return (
    <section className="relative flex h-full min-h-0 w-full flex-col bg-surface-canvas" aria-labelledby="mesh-voice-heading">
      <header className="flex h-14 flex-none items-center gap-3 border-b border-border-subtle bg-surface-base px-4">
        <Icon name="volume" size="sm" className="flex-none text-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <h1
            id="mesh-voice-heading"
            className="truncate text-sm font-semibold text-content outline-none"
            data-mesh-route-heading
            tabIndex={-1}
          >
            {channelName} voice
          </h1>
          <span className="block truncate text-caption text-content-muted">
            {connectedOccupancy > 0
              ? `${connectedOccupancy} in party`
              : voiceLifecycleLabel(lifecycle, channelName)}
          </span>
        </span>
        <button
          ref={rosterButtonRef}
          type="button"
          onClick={() => setRosterOpen(true)}
          className="flex min-h-10 items-center gap-2 px-2 text-xs font-semibold text-content-secondary hover:bg-surface-hover hover:text-content min-[1100px]:hidden"
          aria-controls="mesh-voice-roster-drawer"
          aria-expanded={rosterOpen}
          aria-label="Open party roster"
        >
          <Icon name="users" size="sm" />
          <span className="hidden sm:inline">People</span>
        </button>
        <button
          type="button"
          onClick={onBackToChat}
          className="flex min-h-10 items-center gap-2 border border-border-subtle px-3 text-xs font-semibold text-content-secondary hover:bg-surface-hover hover:text-content"
        >
          <Icon name="messageCircle" size="sm" />
          Open messages
        </button>
      </header>

      {microphonePermission === 'denied' ? (
        <div className="flex flex-none items-center gap-2 border-b border-status-danger/40 bg-status-danger/5 px-4 py-2 text-xs text-status-danger" role="alert">
          <Icon name="micOff" size="sm" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            Mesh cannot use your microphone. Allow microphone access in system settings, then check again.
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
        <div className="flex flex-none items-center gap-2 border-b border-status-warning/40 bg-status-warning/5 px-4 py-2 text-xs text-status-warning" role="status">
          <Icon name="triangleAlert" size="sm" aria-hidden="true" />
          <span>Party audio needs attention. Messages still work.</span>
        </div>
      ) : null}

      {lifecycle === 'requesting' ? (
        <VoiceProgressState
          title={`Joining ${channelName}`}
          detail="Saving your place in the party while voice connects."
          actionLabel="Cancel"
          onAction={leaveVoice}
        />
      ) : lifecycle === 'failed' ? (
        <VoiceFailureState channelName={channelName} onRetry={retryJoin} onLeave={leaveVoice} />
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

      <div className="flex-none border-t border-border-subtle bg-surface-base px-3 py-2">
        <VoiceControls
          devices={devices}
          roomName={channelName}
          leaving={leaving}
          onOpenMessages={onBackToChat}
          onLeave={leaveVoice}
          onInputDeviceChange={switchInputDevice}
          onOutputDeviceChange={switchOutputDevice}
          onCameraChange={toggleCamera}
          onScreenShareChange={toggleScreenShare}
        />
      </div>
    </section>
  )
}

function VoiceUnavailable({
  channelName,
  onBackToChat,
}: {
  channelName: string
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
          {channelName} voice
        </h1>
        <span className="ml-auto text-caption text-content-muted">Unavailable</span>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="w-full max-w-lg border-y border-border-subtle px-6 py-10 text-center">
          <Icon name="phoneOff" size="lg" className="mx-auto text-content-muted" aria-hidden="true" />
          <h2 className="mt-5 text-lg font-semibold text-content">Voice is not available for this room</h2>
          <p className="mt-2 text-sm leading-6 text-content-secondary">You can keep using messages.</p>
          <Button className="mt-6" onClick={onBackToChat}>
            Back to messages
          </Button>
        </div>
      </div>
    </section>
  )
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
  channelName,
  onRetry,
  onLeave,
}: {
  channelName: string
  onRetry: () => void
  onLeave: () => void
}) {
  const reason = useVoiceStore((state) => state.lastReconnectReason)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center" role="alert">
      <Icon name="phoneOff" size="lg" className="text-status-danger" aria-hidden="true" />
      <h2 className="mt-4 text-base font-semibold text-content">Voice could not connect</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-content-secondary">
        {reason || `Try ${channelName} again, or leave voice and keep using messages.`}
      </p>
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
