import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef } from 'react'
import { useVoiceStore } from '../../store/voice'
import { transitions } from '../../lib/motion'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import type { Peer } from '../../types/ipc'

export function VoicePeerGrid({
  onParticipantVolume,
  onRetry,
}: {
  onParticipantVolume?: (identity: string, volume: number) => void
  onRetry?: () => void
}) {
  const peers = useVoiceStore((state) => state.peers)
  const sessionSnapshot = useVoiceStore((state) => state.sessionSnapshot)
  const connectionState = useVoiceStore((state) => state.connectionState)
  const lastReconnectReason = useVoiceStore((state) => state.lastReconnectReason)

  const visiblePeers = useMemo(() => {
    if (peers.length > 0) {
      return [...peers].sort((left, right) => {
        if (left.isSelf && !right.isSelf) return -1
        if (!left.isSelf && right.isSelf) return 1
        return left.publicKey.localeCompare(right.publicKey)
      })
    }

    return sessionSnapshot?.members.map((member) => ({
      publicKey: member.publicKey,
      peerId: member.peerId ?? member.publicKey,
      displayName: member.displayName ?? member.publicKey.slice(0, 6),
      avatarColor: member.avatarColor ?? 'var(--avatar-sand)',
      latency: member.latency ?? 0,
      stream: member.stream,
      role: member.isRelay ? ('relay' as const) : ('member' as const),
      connectionState: member.connectionState ?? 'connecting',
      joinedAt: member.joinedAt,
      lastSeenAt: member.lastSeenAt,
      isSelf: member.isLocal,
      isLocal: member.isLocal,
      isRelay: member.isRelay,
      speaking: member.speaking ?? false,
    })) ?? []
  }, [peers, sessionSnapshot])

  if (visiblePeers.length === 0) {
    /*
     * This branch used to render "Joining the call…" unconditionally, so a
     * failed join spun forever: the engine had already set connectionState to
     * 'disconnected' with a reason, but the reason was only rendered inside
     * sr-only text in VoiceControls. Sighted users saw a permanent spinner with
     * no cause and no way to retry.
     */
    if (connectionState === 'disconnected') {
      return (
        <div
          className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
          role="alert"
        >
          <Icon name="phoneOff" size="lg" className="text-status-danger" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-content">Couldn’t join the call</p>
            <p className="max-w-content-error text-xs text-content-muted">
              {lastReconnectReason ?? 'The call could not be reached. Check your connection and try again.'}
            </p>
          </div>
          {onRetry && (
            <Button onClick={onRetry} variant="secondary">
              Try again
            </Button>
          )}
        </div>
      )
    }

    if (connectionState === 'reconnecting') {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted" role="status">
          <Icon name="loader" size="lg" className="animate-spin" aria-hidden="true" />
          <p className="text-sm">Reconnecting…</p>
          {lastReconnectReason && (
            <p className="max-w-content-error text-center text-xs text-content-muted">
              {lastReconnectReason}
            </p>
          )}
        </div>
      )
    }

    return (
      <div className="flex h-full flex-col items-center justify-center text-muted animate-pulse-soft" role="status">
        <p className="text-sm">Joining the call…</p>
      </div>
    )
  }

  const cols = visiblePeers.length <= 2 ? 1 : visiblePeers.length <= 4 ? 2 : 3

  return (
    <div
      className="mesh-voice-peer-grid grid h-full w-full max-w-4xl auto-rows-voice place-items-stretch gap-6 p-4"
      data-design-token-exception="Dynamic voice participant count determines the grid column count."
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      }}
    >
      <AnimatePresence mode="popLayout">
        {visiblePeers.map((peer) => (
          <VoicePeerTile
            key={peer.publicKey}
            peer={peer}
            onParticipantVolume={onParticipantVolume}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}

function VoicePeerTile({
  peer,
  onParticipantVolume,
}: {
  peer: Peer
  onParticipantVolume?: (identity: string, volume: number) => void
}) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const screenAudioRef = useRef<HTMLAudioElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const isMuted = useVoiceStore((state) => state.isMuted)
  const volume = useVoiceStore((state) => state.participantVolumes[peer.publicKey] ?? 1)
  const setParticipantVolume = useVoiceStore((state) => state.setParticipantVolume)
  const visibleVideo = peer.screenShareStream ?? peer.cameraStream

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.srcObject = peer.stream ?? null
      audioRef.current.volume = Math.min(1, volume)
    }
    if (screenAudioRef.current) {
      screenAudioRef.current.srcObject = peer.screenShareAudioStream ?? null
      screenAudioRef.current.volume = Math.min(1, volume)
    }
  }, [peer.screenShareAudioStream, peer.stream, volume])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = visibleVideo ?? null
    }
  }, [visibleVideo])

  const participantState = peer.isSelf
    ? isMuted
      ? 'Muted'
      : 'You'
    : peer.connectionState === 'reconnecting'
      ? 'Reconnecting'
      : peer.connectionState === 'connecting'
        ? 'Connecting'
        : peer.connectionState === 'disconnected'
          ? 'Offline'
          : peer.speaking
            ? 'Speaking'
            : null

  return (
    <motion.div
      layout
      initial={{ scale: 0.95, opacity: 0, y: 8 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.95, opacity: 0, y: 8 }}
      transition={transitions.move}
      aria-label={`${peer.displayName}, ${participantState ?? 'in call'}`}
      className={`group relative flex min-h-voice-tile flex-col overflow-hidden rounded-panel bg-transparent transition-shadow ${
        visibleVideo && peer.speaking ? 'ring-2 ring-accent' : ''
      }`}
    >
      <audio ref={audioRef} autoPlay muted={isDeafened || peer.isSelf} />
      <audio ref={screenAudioRef} autoPlay muted={isDeafened || peer.isSelf} />

      <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden p-6 text-center">
        {visibleVideo ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={peer.isSelf}
            aria-label={`${peer.displayName}${peer.screenShareStream ? ' screen share' : ' camera'}`}
            className={`absolute inset-0 h-full w-full bg-surface-canvas ${
              peer.screenShareStream ? 'object-contain' : 'object-cover'
            }`}
          />
        ) : (
          <div
            className={`flex h-20 w-20 items-center justify-center rounded-full text-lg font-semibold text-content-on-avatar ${
              peer.speaking ? 'ring-2 ring-accent' : ''
            }`}
            data-design-token-exception="Member-selected avatar color is stored profile data."
            style={{ backgroundColor: peer.avatarColor }}
          >
            {peer.displayName.slice(0, 1).toUpperCase()}
          </div>
        )}

        <div className={`z-10 mt-4 space-y-1 ${visibleVideo ? 'rounded-control bg-overlay/80 px-3 py-2 text-content-on-media-overlay' : ''}`}>
          <span className={`font-medium ${visibleVideo ? 'text-content-on-media-overlay' : 'text-primary'}`}>
            {peer.displayName}
          </span>
          {participantState && (
            <p
              className={`text-xs ${
                peer.speaking
                  ? 'text-accent'
                  : visibleVideo
                    ? 'text-content-on-media-overlay/80'
                    : 'text-muted'
              }`}
            >
              {participantState}
            </p>
          )}
        </div>

        {!peer.isSelf && (
          <label className="mesh-participant-volume absolute bottom-3 right-3 z-10 flex items-center gap-2 rounded-control bg-overlay/80 px-2 py-1 text-meta text-content-on-media-overlay opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            Volume
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              value={Math.round(volume * 100)}
              onChange={(event) => {
                const next = Number(event.target.value) / 100
                setParticipantVolume(peer.publicKey, next)
                onParticipantVolume?.(peer.publicKey, next)
              }}
              aria-label={`${peer.displayName} local volume`}
              className="w-24 accent-accent"
            />
            <span className="w-8 text-right">{Math.round(volume * 100)}%</span>
          </label>
        )}
      </div>
    </motion.div>
  )
}
