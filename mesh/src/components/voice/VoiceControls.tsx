import { motion } from 'framer-motion'
import { useVoiceStore } from '../../store/voice'
import { Tooltip } from '../ui/Tooltip'
import { transitions } from '../../lib/motion'

export function VoiceControls() {
  const {
    isMuted,
    isDeafened,
    setMuted,
    setDeafened,
    setCurrentVoiceSession,
    connectionState,
    sessionSnapshot,
    lastReconnectReason,
  } = useVoiceStore()

  const sessionLabel = sessionSnapshot
    ? sessionSnapshot.relay.relayCandidatePublicKey
      ? `Relay ${sessionSnapshot.relay.relayCandidatePublicKey.slice(0, 6)}`
      : 'Mesh'
    : 'Session idle'

  return (
    <motion.div
      initial={{ y: 20, opacity: 0, filter: 'blur(10px)' }}
      animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
      transition={transitions.panelSpring}
      className="flex items-center gap-4 rounded-lg bg-bg-secondary px-4 py-3 shadow-floating"
    >
      <div className="flex min-w-[140px] flex-col">
        <span className="text-[11px] uppercase tracking-[0.24em] text-muted">{sessionLabel}</span>
        <span className="text-xs text-secondary">
          {connectionState}
          {lastReconnectReason ? ` / ${lastReconnectReason}` : ''}
        </span>
      </div>

      <Tooltip content={isMuted ? 'Unmute' : 'Mute'} side="top">
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={() => setMuted(!isMuted)}
          aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
            isMuted ? 'bg-red text-white' : 'bg-bg-modifier-hover text-primary hover:bg-bg-modifier-active'
          }`}
        >
          {isMuted ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
            </svg>
          )}
        </motion.button>
      </Tooltip>

      <Tooltip content={isDeafened ? 'Undeafen' : 'Deafen'} side="top">
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={() => setDeafened(!isDeafened)}
          aria-label={isDeafened ? 'Undeafen audio' : 'Deafen audio'}
          className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
            isDeafened ? 'bg-red text-white' : 'bg-bg-modifier-hover text-primary hover:bg-bg-modifier-active'
          }`}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
            <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
          </svg>
        </motion.button>
      </Tooltip>

      <div className="mx-1 h-6 w-px bg-border" />

      <Tooltip content="Disconnect" side="top">
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={() => setCurrentVoiceSession(null, null)}
          aria-label="Disconnect from voice channel"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-red text-white transition-opacity hover:opacity-90"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" xmlns="http://www.w3.org/2000/svg">
            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
            <line x1="23" y1="1" x2="1" y2="23" />
          </svg>
        </motion.button>
      </Tooltip>
    </motion.div>
  )
}
