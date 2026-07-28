import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useVoiceEngine } from '../../hooks/useVoiceEngine'
import { useVoiceStore } from '../../store/voice'
import { transitions, variants } from '../../lib/motion'
import { VoicePeerGrid } from './VoicePeerGrid'
import { VoiceControls } from './VoiceControls'
import { Icon } from '../ui/Icon'
import { voiceConnectionLabel } from '../../lib/voice-runtime'

export function VoiceView({ channelId, channelName }: { channelId: string; channelName: string }) {
  const {
    connectionWarning,
    relayChanged,
    voiceService,
    matrixVoiceReady,
    matrixUnavailableReason,
    devices,
    stats,
    switchInputDevice,
    switchOutputDevice,
    setParticipantVolume,
    toggleCamera,
    toggleScreenShare,
  } = useVoiceEngine()
  const sessionSnapshot = useVoiceStore((state) => state.sessionSnapshot)
  const peers = useVoiceStore((state) => state.peers)
  const connectionState = useVoiceStore((state) => state.connectionState)
  const connectionLabel = voiceConnectionLabel(connectionState)
  const memberCount = sessionSnapshot?.memberCount ?? peers.length
  const relayLabel = sessionSnapshot?.relay.relayCandidatePublicKey
    ? sessionSnapshot.relay.relayCandidatePublicKey.slice(0, 8)
    : voiceService.provider === 'matrix-rtc'
      ? 'LiveKit'
      : 'mesh'
  const [showRelayToast, setShowRelayToast] = useState(false)

  useEffect(() => {
    if (!relayChanged) return
    const showTimer = setTimeout(() => setShowRelayToast(true), 0)
    const hideTimer = setTimeout(() => setShowRelayToast(false), 4000)
    return () => {
      clearTimeout(showTimer)
      clearTimeout(hideTimer)
    }
  }, [relayChanged])

  if (voiceService.provider === 'matrix-rtc' && !matrixVoiceReady) {
    const statusLabel =
      voiceService.availability === 'invalid-configuration'
        ? 'Needs setup'
        : voiceService.availability === 'client-unavailable'
          ? 'Safety check'
          : 'Unavailable'

    return (
      <div className="flex h-full w-full flex-col bg-bg-primary">
        <div className="flex h-12 items-center gap-2 border-b border-border-subtle px-4">
          <Icon name="volume" className="text-muted" />
          <span className="text-sm font-semibold text-primary">{channelName}</span>
          <span className="ml-auto rounded-full bg-status-warning/10 px-2 py-1 text-meta text-yellow">
            {statusLabel}
          </span>
        </div>

        <div className="flex flex-1 items-center justify-center p-6">
          <section
            className="w-full max-w-lg rounded-xl border border-border bg-bg-secondary p-6 text-center"
            aria-labelledby="calling-unavailable-title"
          >
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-bg-modifier-hover">
              <Icon name="triangleAlert" className="text-muted" />
            </div>
            <h2 id="calling-unavailable-title" className="text-lg font-semibold text-primary">
              Calling is not ready yet
            </h2>
            <p className="mt-2 text-sm leading-6 text-secondary">
              {matrixUnavailableReason ??
                'Mesh keeps calling off until it can protect the whole conversation. Messaging still works normally.'}
            </p>
            <div className="mt-5 grid gap-2 text-left text-xs sm:grid-cols-2">
              <VoiceReadinessItem label="Calling service" value={statusLabel} />
              <VoiceReadinessItem
                label="Private audio and video"
                value={voiceService.mediaE2eeVerified ? 'Ready' : 'Not verified'}
                warning={!voiceService.mediaE2eeVerified}
              />
            </div>
            <p className="mt-4 text-xs text-muted">
              Your microphone, camera, and screen stay off until every safety check passes.
            </p>
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-bg-primary">
      <AnimatePresence>
        {connectionWarning && (
          <motion.div
            initial={{ y: -4, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -4, opacity: 0 }}
            className="flex items-center gap-2 border-b border-status-warning/30 bg-status-warning/10 px-4 py-2 text-xs text-yellow"
          >
            <Icon name="triangleAlert" size="xs" className="flex-shrink-0" />
            <span>Call quality needs attention.</span>
            <details className="ml-auto">
              <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue">
                Details
              </summary>
              <span className="mt-1 block max-w-md break-words text-meta">
                {connectionWarning}
              </span>
            </details>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showRelayToast && (
          <motion.div
            variants={variants.toast}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute left-1/2 top-14 z-dropdown -translate-x-1/2 rounded-md border border-status-info/30 bg-status-info/20 px-3 py-1.5 text-xs text-blue"
          >
            Relay peer changed — rebuilding connections
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        initial={{ y: -4, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={transitions.enter}
        className="flex h-12 items-center justify-between border-b border-border-subtle px-4"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2">
          <Icon name="volume" className="flex-shrink-0 text-muted" />
          <span className="text-sm font-semibold text-primary">{channelName}</span>
          <span
            className={`rounded-full px-2 py-1 text-meta font-medium ${
              connectionState === 'connected'
                ? 'bg-green/10 text-green'
                : connectionState === 'disconnected' || connectionState === 'degraded'
                  ? 'bg-status-warning/10 text-yellow'
                  : 'bg-bg-modifier-hover text-secondary'
            }`}
          >
            {connectionLabel}
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-meta text-muted">
          {stats.latencyMs !== null && (
            <span className="rounded-md bg-bg-modifier-hover px-2 py-1">
              {stats.quality} · {stats.latencyMs}ms
            </span>
          )}
          <span className="rounded-md bg-bg-modifier-hover px-2 py-1">{connectionState}</span>
          <span className="member-count rounded-md bg-bg-modifier-hover px-2 py-1">{memberCount} people</span>
          <span className="rounded-md bg-bg-modifier-hover px-2 py-1">{relayLabel}</span>
          <span className="rounded-md bg-bg-modifier-hover px-2 py-1">{channelId.slice(0, 8)}</span>
        </div>
      </motion.div>

      <motion.div
        className="flex flex-1 flex-col items-center justify-center overflow-hidden p-8"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.enter}
      >
        <VoicePeerGrid onParticipantVolume={setParticipantVolume} />
      </motion.div>

      <div className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2">
        <VoiceControls
          devices={devices}
          onInputDeviceChange={switchInputDevice}
          onOutputDeviceChange={switchOutputDevice}
          onCameraChange={toggleCamera}
          onScreenShareChange={toggleScreenShare}
        />
      </div>
    </div>
  )
}

function VoiceReadinessItem({
  label,
  value,
  warning = false,
}: {
  label: string
  value: string
  warning?: boolean
}) {
  return (
    <div className="rounded-md bg-bg-primary px-3 py-2">
      <div className="text-caption uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 font-medium ${warning ? 'text-yellow' : 'text-primary'}`}>{value}</div>
    </div>
  )
}
