import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef } from 'react'
import { useVoiceStore } from '../../store/voice'
import { transitions } from '../../lib/motion'
import type { Peer } from '../../types/ipc'

export function VoicePeerGrid({
  onParticipantVolume,
}: {
  onParticipantVolume?: (identity: string, volume: number) => void
}) {
  const peers = useVoiceStore((state) => state.peers)
  const sessionSnapshot = useVoiceStore((state) => state.sessionSnapshot)

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
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted animate-pulse-soft">
        <p className="text-lg">Waiting for the voice session to initialize...</p>
      </div>
    )
  }

  const cols = visiblePeers.length <= 2 ? 1 : visiblePeers.length <= 4 ? 2 : 3

  return (
    <div
      className="grid h-full w-full max-w-5xl auto-rows-voice place-items-stretch gap-4 p-4"
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

  const statusLabel =
    peer.isSelf ? 'You' : peer.connectionState === 'reconnecting' ? 'Reconnecting' : peer.connectionState === 'connecting' ? 'Connecting' : peer.connectionState === 'disconnected' ? 'Offline' : peer.isRelay ? 'Relay' : 'Member'

  return (
    <motion.div
      layout
      initial={{ scale: 0.95, opacity: 0, y: 8 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.95, opacity: 0, y: 8 }}
      transition={transitions.enter}
      className={`group relative flex min-h-voice-tile flex-col overflow-hidden rounded-lg bg-bg-secondary transition-shadow ${
        peer.speaking ? 'ring-2 ring-green shadow-overlay' : ''
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
            className={`absolute inset-0 h-full w-full bg-bg-primary ${
              peer.screenShareStream ? 'object-contain' : 'object-cover'
            }`}
          />
        ) : (
          <div
            className={`flex h-20 w-20 items-center justify-center rounded-full text-lg font-semibold text-content-on-status shadow-overlay ${
              peer.speaking ? 'ring-4 ring-green/40' : ''
            }`}
            data-design-token-exception="Member-selected avatar color is stored profile data."
            style={{ backgroundColor: peer.avatarColor }}
          >
            {peer.displayName.slice(0, 1).toUpperCase()}
          </div>
        )}

        <div className={`z-10 mt-4 space-y-1 ${visibleVideo ? 'rounded-md bg-overlay/80 px-3 py-2' : ''}`}>
          <div className="flex items-center justify-center gap-2">
            <span className="font-medium text-primary">{peer.displayName}</span>
            {peer.isRelay ? (
              <span className="rounded-md bg-bg-modifier-hover px-2 py-0.5 text-caption uppercase tracking-wide text-muted">
                Relay
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted">{statusLabel}</p>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5 text-meta text-muted">
          <span className="rounded-md bg-bg-modifier-hover px-2 py-1">
            {peer.connectionState ?? 'connected'}
          </span>
          <span className="rounded-md bg-bg-modifier-hover px-2 py-1">
            {peer.latency > 0 ? `${peer.latency} ms` : 'live'}
          </span>
          {peer.speaking ? (
            <span className="rounded-md bg-green/10 px-2 py-1 text-green">
              Speaking
            </span>
          ) : null}
          {peer.isSelf ? (
            <span className="rounded-md bg-bg-modifier-hover px-2 py-1">
              Local
            </span>
          ) : null}
        </div>

        {!peer.isSelf && (
          <label className="absolute bottom-3 right-3 z-10 flex items-center gap-2 rounded-md bg-overlay/80 px-2 py-1 text-meta text-secondary opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
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
              className="w-24 accent-green"
            />
            <span className="w-8 text-right">{Math.round(volume * 100)}%</span>
          </label>
        )}
      </div>
    </motion.div>
  )
}
