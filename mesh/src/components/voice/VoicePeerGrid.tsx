import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef } from 'react'
import { useVoiceStore } from '../../store/voice'
import { transitions } from '../../lib/motion'
import type { Peer } from '../../types/ipc'

export function VoicePeerGrid() {
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
      avatarColor: member.avatarColor ?? '#c8b89a',
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
      className="grid h-full w-full max-w-5xl place-items-stretch gap-4 p-4"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: 'minmax(220px, 1fr)',
      }}
    >
      <AnimatePresence mode="popLayout">
        {visiblePeers.map((peer) => (
          <VoicePeerTile key={peer.publicKey} peer={peer} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function VoicePeerTile({ peer }: { peer: Peer }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const isDeafened = useVoiceStore((state) => state.isDeafened)

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.srcObject = peer.stream ?? null
    }
  }, [peer.stream])

  const statusLabel =
    peer.isSelf ? 'You' : peer.connectionState === 'reconnecting' ? 'Reconnecting' : peer.connectionState === 'connecting' ? 'Connecting' : peer.connectionState === 'disconnected' ? 'Offline' : peer.isRelay ? 'Relay' : 'Member'

  return (
    <motion.div
      layout
      initial={{ scale: 0.95, opacity: 0, y: 8 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.95, opacity: 0, y: 8 }}
      transition={transitions.panelSpring}
      className="group relative flex min-h-[220px] flex-col overflow-hidden rounded-lg bg-bg-secondary"
    >
      <audio ref={audioRef} autoPlay muted={isDeafened} />

      <div className="relative flex flex-1 flex-col items-center justify-center p-6 text-center">
        <div
          className="flex h-20 w-20 items-center justify-center rounded-full text-3xl font-semibold text-white shadow-elevation-high"
          style={{ backgroundColor: peer.avatarColor }}
        >
          {peer.displayName.slice(0, 1).toUpperCase()}
        </div>

        <div className="mt-4 space-y-1">
          <div className="flex items-center justify-center gap-2">
            <span className="font-medium text-primary">{peer.displayName}</span>
            {peer.isRelay ? (
              <span className="rounded-md bg-bg-modifier-hover px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                Relay
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted">{statusLabel}</p>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5 text-[11px] text-muted">
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
      </div>
    </motion.div>
  )
}
