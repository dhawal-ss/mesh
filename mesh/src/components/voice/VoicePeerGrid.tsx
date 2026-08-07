import { motion } from 'framer-motion'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { transitions } from '../../lib/motion'
import { recordVoiceAudible } from '../../lib/voice-activation'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useIdentityStore } from '../../store/identity'
import { useVoiceStore } from '../../store/voice'
import type { Peer } from '../../types/ipc'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'

type PreviewPeer = Peer & { designPreviewImageUrl?: string }
const VOICE_ROSTER_COMPACT_QUERY = '(max-width: 1099px)'

function previewImageFor(peer: Peer): string | undefined {
  return import.meta.env.DEV ? (peer as PreviewPeer).designPreviewImageUrl : undefined
}

export function VoicePeerGrid({
  channelName,
  reconnecting = false,
  rosterOpen = false,
  onCloseRoster,
  onParticipantVolume,
}: {
  channelName: string
  reconnecting?: boolean
  rosterOpen?: boolean
  onCloseRoster?: () => void
  onParticipantVolume?: (identity: string, volume: number) => void
}) {
  const peers = useVoiceStore((state) => state.peers)
  const sessionSnapshot = useVoiceStore((state) => state.sessionSnapshot)
  const localPublicKey = useVoiceStore((state) => state.localPublicKey)
  const identity = useIdentityStore((state) => state.identity)
  const rosterDrawerRef = useRef<HTMLElement>(null)
  const compactRoster = useMediaQuery(VOICE_ROSTER_COMPACT_QUERY)
  const rosterDrawerOpen = rosterOpen && compactRoster

  const visiblePeers = useMemo<Peer[]>(() => {
    const sessionPeers = peers.length > 0
      ? peers
      : sessionSnapshot?.members.map((member) => ({
          publicKey: member.publicKey,
          peerId: member.peerId ?? member.publicKey,
          displayName: member.displayName?.trim() || 'Player',
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
    const effectiveLocalKey = localPublicKey ?? identity?.publicKey ?? null
    const hasLocal = effectiveLocalKey
      ? sessionPeers.some((peer) => peer.publicKey === effectiveLocalKey || peer.isSelf)
      : false
    const withLocal = !hasLocal && identity && effectiveLocalKey
      ? [{
          publicKey: effectiveLocalKey,
          peerId: effectiveLocalKey,
          displayName: identity.displayName || 'You',
          avatarColor: identity.avatarColor || 'var(--avatar-sand)',
          latency: 0,
          connectionState: 'connected' as const,
          isSelf: true,
          isLocal: true,
          speaking: false,
        }, ...sessionPeers]
      : sessionPeers

    return [...withLocal].sort((left, right) => {
      if (Boolean(left.speaking) !== Boolean(right.speaking)) return left.speaking ? -1 : 1
      if (Boolean(left.isSelf) !== Boolean(right.isSelf)) return left.isSelf ? -1 : 1
      return left.displayName.localeCompare(right.displayName)
    })
  }, [identity, localPublicKey, peers, sessionSnapshot])

  const featuredPeer = visiblePeers.find((peer) => (
    Boolean(peer.screenShareStream)
    || Boolean(peer.cameraStream)
    || Boolean(previewImageFor(peer))
  ))
  const activeSpeaker = visiblePeers.find((peer) => peer.speaking) ?? visiblePeers[0]

  useEffect(() => {
    if (!rosterDrawerOpen) return
    const drawer = rosterDrawerRef.current
    if (!drawer) return
    const focusableSelector = [
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const focusable = () => [...drawer.querySelectorAll<HTMLElement>(focusableSelector)]
    ;(focusable()[0] ?? drawer).focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onCloseRoster?.()
        return
      }
      if (event.key !== 'Tab') return
      const controls = focusable()
      if (controls.length === 0) {
        event.preventDefault()
        drawer.focus()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCloseRoster, rosterDrawerOpen])

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-surface-canvas">
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-3 sm:p-4"
        aria-label={`${channelName} party focus`}
      >
        {reconnecting ? (
          <div className="mb-3 flex flex-none items-center gap-2 border border-status-warning/40 bg-status-warning/5 px-3 py-2 text-xs text-status-warning" role="status">
            <Icon name="refresh" size="sm" aria-hidden="true" />
            <span>
              <strong>Reconnecting to {channelName}.</strong> Messages still work while voice reconnects.
            </span>
          </div>
        ) : null}

        {featuredPeer ? (
          <VoiceMediaStage peer={featuredPeer} />
        ) : (
          <PartyFocus channelName={channelName} activeSpeaker={activeSpeaker} count={visiblePeers.length} />
        )}

        <div className="mt-3 flex flex-none items-center justify-between border-t border-border-subtle pt-3 min-[1100px]:hidden">
          <span className="text-xs text-content-muted">
            {visiblePeers.length} {visiblePeers.length === 1 ? 'player' : 'players'} in party
          </span>
        </div>
      </section>

      <PartyRoster
        channelName={channelName}
        peers={visiblePeers}
        reconnecting={reconnecting}
        onParticipantVolume={onParticipantVolume}
        className="hidden w-72 flex-none min-[1100px]:flex"
      />

      {rosterDrawerOpen ? (
        <>
          <button
            type="button"
            className="absolute inset-0 z-overlay bg-overlay/70 min-[1100px]:hidden"
            aria-label="Close party roster"
            onClick={onCloseRoster}
          />
          <PartyRoster
            id="mesh-voice-roster-drawer"
            containerRef={rosterDrawerRef}
            channelName={channelName}
            peers={visiblePeers}
            reconnecting={reconnecting}
            onParticipantVolume={onParticipantVolume}
            onClose={onCloseRoster}
            modal
            className="absolute inset-y-0 right-0 z-modal flex w-72 max-w-full min-[1100px]:hidden"
          />
        </>
      ) : null}
    </div>
  )
}

function VoiceMediaStage({ peer }: { peer: Peer }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const visibleVideo = peer.screenShareStream ?? peer.cameraStream
  const previewImage = previewImageFor(peer)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = visibleVideo ?? null
  }, [visibleVideo])

  return (
    <motion.figure
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transitions.enter}
      className="relative mx-auto flex aspect-video min-h-0 w-full max-w-6xl flex-none overflow-hidden border border-border-emphasis bg-surface-sunken"
      aria-label={`${peer.displayName}${peer.screenShareStream || previewImage ? ' screen share' : ' camera'}`}
    >
      {previewImage ? (
        <img
          src={previewImage}
          alt={`${peer.displayName} shared game view`}
          className="h-full w-full object-cover"
        />
      ) : (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={peer.isSelf}
          className={`h-full w-full ${peer.screenShareStream ? 'object-contain' : 'object-cover'}`}
        />
      )}
      <figcaption className="absolute inset-x-0 bottom-0 flex items-end justify-between bg-overlay/80 px-4 py-3 text-content-on-media-overlay">
        <span>
          <span className="block text-sm font-semibold">{peer.displayName}</span>
          <span className="block text-caption text-content-on-media-overlay/80">
            {peer.screenShareStream || previewImage ? 'Sharing the game' : 'Camera on'}
          </span>
        </span>
        {peer.speaking ? (
          <span className="border-l border-status-success pl-3 text-caption font-semibold text-status-success">
            Speaking
          </span>
        ) : null}
      </figcaption>
    </motion.figure>
  )
}

function PartyFocus({
  channelName,
  activeSpeaker,
  count,
}: {
  channelName: string
  activeSpeaker?: Peer
  count: number
}) {
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col items-center justify-center border-y border-border-subtle px-6 py-10 text-center">
      {activeSpeaker ? (
        <>
          <span className={`border p-1 ${activeSpeaker.speaking ? 'border-status-success' : 'border-border-emphasis'}`}>
            <Avatar color={activeSpeaker.avatarColor} size={80} name={activeSpeaker.displayName} />
          </span>
          <p className="mt-5 text-caption font-semibold uppercase tracking-eyebrow text-accent">
            {activeSpeaker.speaking ? 'Party focus' : 'Party ready'}
          </p>
          <h2 className="mt-2 text-lg font-semibold text-content">
            {activeSpeaker.speaking ? `${activeSpeaker.displayName} is talking` : channelName}
          </h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-content-secondary">
            {count === 1
              ? 'You are first in. Keep messages open while the rest of the party drops in.'
              : `${count} players are here. Share a game or turn on a camera when the party wants a visual.`}
          </p>
        </>
      ) : (
        <>
          <Icon name="volume" size="lg" className="text-accent" aria-hidden="true" />
          <h2 className="mt-4 text-lg font-semibold text-content">Party ready</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-content-secondary">
            You are first in {channelName}. Messages remain one action away while friends join.
          </p>
        </>
      )}
    </div>
  )
}

function PartyRoster({
  channelName,
  peers,
  reconnecting,
  onParticipantVolume,
  onClose,
  className,
  id,
  containerRef,
  modal = false,
}: {
  channelName: string
  peers: Peer[]
  reconnecting: boolean
  onParticipantVolume?: (identity: string, volume: number) => void
  onClose?: () => void
  className: string
  id?: string
  containerRef?: RefObject<HTMLElement | null>
  modal?: boolean
}) {
  return (
    <aside
      ref={containerRef}
      id={id}
      className={`${className} min-h-0 flex-col border-l border-border-subtle bg-surface-base`}
      aria-label={`People in ${channelName}`}
      role={modal ? 'dialog' : undefined}
      aria-modal={modal || undefined}
      tabIndex={modal ? -1 : undefined}
    >
      <header className="flex h-14 flex-none items-center justify-between border-b border-border-subtle px-4">
        <span>
          <span className="block text-sm font-semibold text-content">In the party</span>
          <span className="block text-caption text-content-muted">
            {peers.length} {peers.length === 1 ? 'player' : 'players'}
          </span>
        </span>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center text-content-muted hover:bg-surface-hover hover:text-content"
            aria-label="Close party roster"
          >
            <Icon name="x" size="sm" />
          </button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {peers.map((peer) => (
          <PartyParticipant
            key={peer.publicKey}
            peer={peer}
            reconnecting={reconnecting}
            onParticipantVolume={onParticipantVolume}
          />
        ))}
      </div>
    </aside>
  )
}

function PartyParticipant({
  peer,
  reconnecting,
  onParticipantVolume,
}: {
  peer: Peer
  reconnecting: boolean
  onParticipantVolume?: (identity: string, volume: number) => void
}) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const screenAudioRef = useRef<HTMLAudioElement>(null)
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const isMuted = useVoiceStore((state) => state.isMuted)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)
  const volume = useVoiceStore((state) => state.participantVolumes[peer.publicKey] ?? 1)
  const setParticipantVolume = useVoiceStore((state) => state.setParticipantVolume)
  const muted = Boolean(peer.isSelf && isMuted)
  const speaking = Boolean(peer.speaking && !muted && !reconnecting)
  const state = reconnecting
    ? 'reconnecting'
    : muted
      ? 'muted'
      : speaking
        ? 'speaking'
        : peer.isSelf
          ? 'you'
          : 'listening'
  const accessibleState = [peer.isSelf ? 'you' : null, muted ? 'muted' : null, speaking ? 'speaking' : null]
    .filter(Boolean)
    .join(', ') || state

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

  const recordAudiblePlayback = () => {
    if (peer.isSelf || isDeafened || !currentChannelId) return
    recordVoiceAudible(currentChannelId)
  }

  return (
    <div
      className={`group border-b border-border-subtle px-4 py-3 ${speaking ? 'border-l border-l-status-success bg-surface-hover' : ''}`}
      aria-label={`${peer.displayName}, ${accessibleState}`}
    >
      <audio ref={audioRef} autoPlay muted={isDeafened || peer.isSelf} onPlaying={recordAudiblePlayback} />
      <audio ref={screenAudioRef} autoPlay muted={isDeafened || peer.isSelf} onPlaying={recordAudiblePlayback} />
      <div className="flex items-center gap-3">
        <span className={`border p-0.5 ${speaking ? 'border-status-success' : 'border-transparent'}`}>
          <Avatar color={peer.avatarColor} size={40} name={peer.displayName} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-content">
            {peer.displayName}{peer.isSelf ? ' (you)' : ''}
          </span>
          <span className={`block text-caption capitalize ${speaking ? 'text-status-success' : 'text-content-muted'}`}>
            {state}
          </span>
        </span>
        {muted ? <Icon name="micOff" size="sm" className="text-status-warning" aria-hidden="true" /> : null}
      </div>
      {!peer.isSelf ? (
        <label className="mesh-participant-volume mt-2 flex items-center gap-2 text-caption text-content-muted opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <span>Volume</span>
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
            className="min-w-0 flex-1 accent-accent"
          />
          <span className="w-8 text-right">{Math.round(volume * 100)}%</span>
        </label>
      ) : null}
    </div>
  )
}
