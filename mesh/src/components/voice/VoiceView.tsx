import { motion } from 'framer-motion'
import { useVoiceEngine } from '../../hooks/useVoiceEngine'
import { useVoiceStore } from '../../store/voice'
import { transitions } from '../../lib/motion'
import { VoicePeerGrid } from './VoicePeerGrid'
import { VoiceControls } from './VoiceControls'

export function VoiceView({ channelId, channelName }: { channelId: string; channelName: string }) {
  useVoiceEngine()

  const sessionSnapshot = useVoiceStore((state) => state.sessionSnapshot)
  const connectionState = useVoiceStore((state) => state.connectionState)
  const memberCount = sessionSnapshot?.memberCount ?? 0
  const relayLabel = sessionSnapshot?.relay.relayCandidatePublicKey
    ? sessionSnapshot.relay.relayCandidatePublicKey.slice(0, 8)
    : 'mesh'

  return (
    <div className="relative flex h-full w-full flex-col bg-bg-primary">
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
