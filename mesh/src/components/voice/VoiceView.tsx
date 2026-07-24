import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useVoiceEngine } from '../../hooks/useVoiceEngine'
import { useVoiceStore } from '../../store/voice'
import { transitions } from '../../lib/motion'
import { VoicePeerGrid } from './VoicePeerGrid'
import { VoiceControls } from './VoiceControls'

export function VoiceView({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { engine, connectionWarning, relayChanged, voiceService } = useVoiceEngine()

  const sessionSnapshot = useVoiceStore((state) => state.sessionSnapshot)
  const connectionState = useVoiceStore((state) => state.connectionState)
  const memberCount = sessionSnapshot?.memberCount ?? 0
  const relayLabel = sessionSnapshot?.relay.relayCandidatePublicKey
    ? sessionSnapshot.relay.relayCandidatePublicKey.slice(0, 8)
    : 'mesh'

  // Connection quality stats
  const [connStats, setConnStats] = useState<{ type: string; rtt: number } | null>(null)

  // Relay failover toast
  const [showRelayToast, setShowRelayToast] = useState(false)

  useEffect(() => {
    if (!engine) return
    const interval = setInterval(async () => {
      const stats = await engine.getConnectionStats()
      if (stats) {
        setConnStats({ type: stats.type, rtt: Math.round(stats.roundTripTime) })
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [engine])

  // Show a brief toast when relay failover occurs
  useEffect(() => {
    if (relayChanged) {
      setShowRelayToast(true)
      const timer = setTimeout(() => setShowRelayToast(false), 4000)
      return () => clearTimeout(timer)
    }
  }, [relayChanged])

  if (voiceService.provider === 'matrix-rtc' && voiceService.availability !== 'ready') {
    const statusLabel =
      voiceService.availability === 'invalid-configuration'
        ? 'Configuration error'
        : voiceService.availability === 'client-unavailable'
          ? 'Client integration pending'
          : 'Not configured'

    return (
      <div className="flex h-full w-full flex-col bg-bg-primary">
        <div className="flex h-12 items-center gap-2 border-b border-black/30 px-4 shadow-elevation-low">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-muted">
            <path d="M12 3a1 1 0 0 0-1-1h-1.06a1 1 0 0 0-.7.28L5.71 5.71A1 1 0 0 1 5 6H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2a1 1 0 0 1 .7.29l3.54 3.54a1 1 0 0 0 .7.28H11a1 1 0 0 0 1-1V3Z" />
          </svg>
          <span className="text-sm font-semibold text-primary">{channelName}</span>
          <span className="ml-auto rounded-full bg-yellow-500/10 px-2 py-1 text-[11px] text-yellow">
            {statusLabel}
          </span>
        </div>

        <div className="flex flex-1 items-center justify-center p-6">
          <section
            className="w-full max-w-lg rounded-xl border border-border bg-bg-secondary p-6 text-center shadow-elevation-low"
            aria-labelledby="matrixrtc-title"
          >
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-bg-modifier-hover text-xl">
              🔒
            </div>
            <h2 id="matrixrtc-title" className="text-lg font-semibold text-primary">
              MatrixRTC calling is not ready
            </h2>
            <p className="mt-2 text-sm leading-6 text-secondary">
              Mesh will not fall back to its experimental peer-to-peer calling engine for a
              Matrix account.
            </p>
            <div className="mt-5 grid gap-2 text-left text-xs sm:grid-cols-2">
              <VoiceReadinessItem label="Provider" value="MatrixRTC + LiveKit" />
              <VoiceReadinessItem label="Service" value={statusLabel} />
              <VoiceReadinessItem
                label="Media E2EE"
                value={voiceService.mediaE2eeVerified ? 'Verified' : 'Not verified'}
                warning={!voiceService.mediaE2eeVerified}
              />
              <VoiceReadinessItem label="Legacy fallback" value="Blocked" />
            </div>
            {voiceService.reason && (
              <p className="mt-4 rounded-md bg-bg-primary px-3 py-2 text-left text-xs leading-5 text-muted">
                {voiceService.reason}
              </p>
            )}
            <p className="mt-4 text-xs text-muted">
              Operators can review endpoint validation in System Diagnostics.
            </p>
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-bg-primary">
      {/* Connection warning banner */}
      <AnimatePresence>
        {connectionWarning && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex items-center gap-2 border-b border-yellow-600/30 bg-yellow-500/10 px-4 py-2 text-xs text-yellow-300"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
              <path d="M12 2L1 21h22L12 2zm0 4l7.53 13H4.47L12 6zm-1 5v4h2v-4h-2zm0 6v2h2v-2h-2z" />
            </svg>
            <span>{connectionWarning}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Relay failover toast */}
      <AnimatePresence>
        {showRelayToast && (
          <motion.div
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -20, opacity: 0 }}
            className="absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-md bg-blue-500/20 border border-blue-500/30 px-3 py-1.5 text-xs text-blue-300"
          >
            Relay peer changed -- rebuilding connections
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        initial={{ y: -4, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={transitions.panelSpring}
        className="flex h-12 items-center justify-between border-b border-black/30 px-4 shadow-elevation-low"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-muted flex-shrink-0">
            <path d="M12 3a1 1 0 0 0-1-1h-1.06a1 1 0 0 0-.7.28L5.71 5.71A1 1 0 0 1 5 6H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2a1 1 0 0 1 .7.29l3.54 3.54a1 1 0 0 0 .7.28H11a1 1 0 0 0 1-1V3Z" />
          </svg>
          <span className="text-sm font-semibold text-primary">{channelName}</span>
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          {connStats && (
            <span className="rounded-md bg-bg-modifier-hover px-2 py-1">
              {connStats.type === 'relay' ? 'Relay' : 'Direct'} · {connStats.rtt}ms
            </span>
          )}
          <span className="rounded-md bg-bg-modifier-hover px-2 py-1">{connectionState}</span>
          <span className="rounded-md bg-bg-modifier-hover px-2 py-1">{memberCount} peers</span>
          <span className="rounded-md bg-bg-modifier-hover px-2 py-1">{relayLabel}</span>
          <span className="rounded-md bg-bg-modifier-hover px-2 py-1">{channelId.slice(0, 8)}</span>
        </div>
      </motion.div>

      <motion.div
        className="flex flex-1 flex-col items-center justify-center overflow-hidden p-8"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.panelSpring}
      >
        <VoicePeerGrid />
      </motion.div>

      <div className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2">
        <VoiceControls />
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
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 font-medium ${warning ? 'text-yellow' : 'text-primary'}`}>{value}</div>
    </div>
  )
}
