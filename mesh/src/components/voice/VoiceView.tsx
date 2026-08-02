import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useVoiceEngine } from '../../hooks/useVoiceEngine'
import { useVoiceStore } from '../../store/voice'
import { transitions, variants } from '../../lib/motion'
import { VoicePeerGrid } from './VoicePeerGrid'
import { VoiceControls } from './VoiceControls'
import { Icon } from '../ui/Icon'
import { voiceConnectionLabel } from '../../lib/voice-runtime'
import { StatusDot } from '../ui/StatusDot'

interface VoiceViewProps {
  channelId: string
  channelName: string
  onCheckAgain?: () => void
  onOpenDiagnostics: () => void
  onBackToChat: () => void
}

export function VoiceView({
  channelId,
  channelName,
  onCheckAgain,
  onOpenDiagnostics,
  onBackToChat,
}: VoiceViewProps) {
  const {
    connectionWarning,
    microphonePermission,
    relayChanged,
    voiceService,
    matrixVoiceReady,
    matrixUnavailableReason,
    devices,
    refreshDevices,
    switchInputDevice,
    switchOutputDevice,
    setParticipantVolume,
    toggleCamera,
    toggleScreenShare,
  } = useVoiceEngine()
  const connectionState = useVoiceStore((state) => state.connectionState)
  const connectionLabel = voiceConnectionLabel(connectionState)
  const [showRelayToast, setShowRelayToast] = useState(false)

  /*
   * Retry re-enters the same voice session. This is the same mechanism the
   * Leave control uses, run in reverse, so it does not need new engine surface.
   */
  const currentCommunityId = useVoiceStore((state) => state.currentCommunityId)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)
  const setCurrentVoiceSession = useVoiceStore((state) => state.setCurrentVoiceSession)
  const retryJoin = useCallback(() => {
    const retryChannelId = currentChannelId ?? channelId
    const communityId = currentCommunityId
    setCurrentVoiceSession(null, null)
    // Let the engine tear down before the join effect keys on the new session.
    requestAnimationFrame(() => setCurrentVoiceSession(communityId, retryChannelId))
  }, [channelId, currentChannelId, currentCommunityId, setCurrentVoiceSession])

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
    const blocker = microphonePermission === 'denied'
      ? {
          label: 'Permission',
          explanation: 'Mesh cannot use the microphone until system permission is restored.',
        }
      : voiceService.availability === 'invalid-configuration'
        ? {
            label: 'Service capability',
            explanation: 'This account service has not advertised a complete calling setup.',
          }
        : !voiceService.mediaE2eeVerified
          ? {
              label: 'Verification',
              explanation: 'Mesh has not verified private media for this calling service.',
            }
          : {
              label: 'Device or network',
              explanation: 'The local calling client, device, or network check is not ready.',
            }

    return (
      <div className="flex h-full w-full flex-col bg-surface-canvas">
        <div className="flex h-12 items-center gap-2 border-b border-border-subtle px-4">
          <Icon name="volume" className="text-muted" />
          <span className="text-sm font-semibold text-primary">{channelName}</span>
          <span className="ml-auto font-mono text-meta text-status-warning">
            {statusLabel}
          </span>
        </div>

        <div className="flex flex-1 items-center justify-center p-6">
          <section
            className="w-full max-w-lg rounded-panel border border-border-subtle bg-surface-sidebar p-6 text-center"
            aria-labelledby="calling-unavailable-title"
          >
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-panel border border-border-subtle bg-surface-sunken">
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
              <VoiceReadinessItem label="Current blocker" value={blocker.label} warning />
              <VoiceReadinessItem label="Calling service" value={statusLabel} />
              <VoiceReadinessItem
                label="Private audio and video"
                value={voiceService.mediaE2eeVerified ? 'Ready' : 'Not verified'}
                warning={!voiceService.mediaE2eeVerified}
              />
            </div>
            <p className="mt-4 text-xs text-muted">
              {blocker.explanation} Your microphone, camera, and screen stay off until every safety
              check passes.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  onCheckAgain?.()
                  void refreshDevices(true)
                  retryJoin()
                }}
                className="min-h-11 rounded-control bg-accent px-4 text-sm font-semibold text-content-on-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                Check again
              </button>
              <button
                type="button"
                onClick={onOpenDiagnostics}
                className="min-h-11 rounded-control border border-border px-4 text-sm font-semibold text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                Open call diagnostics
              </button>
              <button
                type="button"
                onClick={onBackToChat}
                className="min-h-11 rounded-control px-4 text-sm font-semibold text-secondary hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                Back to chat
              </button>
            </div>
          </section>
        </div>
      </div>
    )
  }

  return (
      <div className="relative flex h-full w-full flex-col bg-surface-base">
      {/*
        A blocked microphone is a permissions problem with a specific remedy,
        not a call-quality warning. It gets its own banner above the generic one.
      */}
      {microphonePermission === 'denied' && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-status-danger/30 bg-status-danger/5 px-4 py-2 text-xs text-status-danger"
        >
          <Icon name="micOff" size="xs" className="flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            Mesh can’t reach your microphone. Allow microphone access for Mesh in your
            system settings, then try again.
          </span>
          <button
            type="button"
            onClick={() => void refreshDevices(true)}
            className="ml-auto min-h-8 rounded-control px-2 font-semibold underline underline-offset-2 transition-colors hover:bg-status-danger/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            Check again
          </button>
        </div>
      )}

      <AnimatePresence>
        {connectionWarning && (
          <motion.div
            initial={{ y: -4, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -4, opacity: 0 }}
            className="flex items-center gap-2 border-b border-status-warning/30 bg-status-warning/5 px-4 py-2 text-xs text-status-warning"
          >
            <Icon name="triangleAlert" size="xs" className="flex-shrink-0" />
            <span>Call quality needs attention.</span>
            <details className="ml-auto">
              <summary className="flex min-h-8 cursor-pointer items-center rounded-control px-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
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
            className="absolute left-1/2 top-14 z-dropdown -translate-x-1/2 rounded-control border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs text-accent"
          >
            Call connection updated
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
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="volume" className="flex-shrink-0 text-muted" />
          <span className="min-w-0 truncate text-sm font-semibold text-primary">{channelName}</span>
        </div>

        <span
          role="status"
          className={`ml-3 inline-flex flex-shrink-0 items-center gap-1.5 text-caption font-medium ${
            connectionState === 'connected'
              ? 'text-status-success'
              : connectionState === 'disconnected' || connectionState === 'degraded'
                ? 'text-status-warning'
                : 'text-muted'
          }`}
        >
          <StatusDot
            state={
              connectionState === 'reconnecting'
                ? 'connecting'
                : connectionState === 'idle'
                  ? 'disconnected'
                  : connectionState
            }
            label={`Voice: ${connectionLabel}`}
          />
          {connectionLabel}
        </span>
      </motion.div>

      <motion.div
        className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-3 sm:overflow-hidden sm:p-8"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.enter}
      >
        <VoicePeerGrid onParticipantVolume={setParticipantVolume} onRetry={retryJoin} />
      </motion.div>

      <div className="z-sticky w-full flex-shrink-0 border-t border-border-subtle bg-surface-base p-2 sm:absolute sm:bottom-4 sm:left-1/2 sm:w-auto sm:-translate-x-1/2 sm:border-0 sm:bg-transparent sm:p-0 lg:bottom-8">
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
    <div className="rounded-control border border-border-subtle bg-surface-base px-3 py-2">
      <div className="text-caption uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 font-medium ${warning ? 'text-status-warning' : 'text-primary'}`}>{value}</div>
    </div>
  )
}
