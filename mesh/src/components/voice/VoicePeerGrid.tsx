import { motion } from '../../lib/lazy-motion'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { motionOffsets, transitions } from '../../lib/motion'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useIdentityStore } from '../../store/identity'
import { useCallPeers, useVoiceStore } from '../../store/voice'
import type { Peer } from '../../types/ipc'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'

type PreviewPeer = Peer & { designPreviewCameraImageUrl?: string }
const VOICE_ROSTER_COMPACT_QUERY = '(max-width: 1099px)'

function previewImageFor(peer: Peer): string | undefined {
  return import.meta.env.DEV ? (peer as PreviewPeer).designPreviewCameraImageUrl : undefined
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
  const peers = useCallPeers()
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
    Boolean(peer.cameraStream)
    || Boolean(previewImageFor(peer))
  ))
  const screenSharingPeers = visiblePeers.filter((peer) => Boolean(peer.screenShareStream))
  const activeSpeaker = visiblePeers.find((peer) => peer.speaking) ?? visiblePeers[0]
  const showParticipantGrid = visiblePeers.length >= 2 && visiblePeers.length <= 8

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
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-surface">
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-3 sm:p-4"
        aria-label={`${channelName} call`}
      >
        {reconnecting ? (
          <div className="mb-3 flex flex-none items-center gap-2 border border-marker-container-line bg-marker-container px-3 py-2 text-body-sm text-marker" role="status">
            <Icon name="refresh" size="sm" aria-hidden="true" />
            <span>
              <strong>Reconnecting to {channelName}.</strong>
            </span>
          </div>
        ) : null}

        {screenSharingPeers.length > 0 ? (
          <ScreenShareStage peers={screenSharingPeers} />
        ) : showParticipantGrid ? (
          <VoiceParticipantGrid peers={visiblePeers} reconnecting={reconnecting} />
        ) : featuredPeer ? (
          <VoiceMediaStage peer={featuredPeer} />
        ) : (
          <PartyFocus channelName={channelName} activeSpeaker={activeSpeaker} count={visiblePeers.length} />
        )}

        <div className="mt-3 flex flex-none items-center justify-between border-t border-outline-variant pt-3 voice-wide:hidden">
          <span className="text-body-sm text-on-surface-variant">
            {visiblePeers.length} {visiblePeers.length === 1 ? 'person' : 'people'} in call
          </span>
        </div>
      </section>

      <PartyRoster
        channelName={channelName}
        peers={visiblePeers}
        reconnecting={reconnecting}
        onParticipantVolume={onParticipantVolume}
        className="hidden w-72 flex-none voice-wide:flex"
      />

      {rosterDrawerOpen ? (
        <>
          <button
            type="button"
            className="absolute inset-0 z-overlay bg-surface-scrim voice-wide:hidden"
            aria-label="Close people list"
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
            className="absolute inset-y-0 right-0 z-modal flex w-72 max-w-full voice-wide:hidden"
          />
        </>
      ) : null}
    </div>
  )
}

function ScreenShareStage({ peers }: { peers: Peer[] }) {
  return (
    <div
      className={`grid min-h-0 flex-1 gap-2 ${peers.length > 1 ? 'lg:grid-cols-2' : 'grid-cols-1'}`}
      data-screen-share-count={peers.length}
      aria-label={peers.length === 1 ? 'Shared screen' : `${peers.length} shared screens`}
    >
      {peers.map((peer) => (
        <VoiceMediaStage key={peer.publicKey} peer={peer} source="screen-share" />
      ))}
    </div>
  )
}

function VoiceParticipantGrid({
  peers,
  reconnecting,
}: {
  peers: Peer[]
  reconnecting: boolean
}) {
  const threeParticipants = peers.length === 3
  const gridColumns = peers.length <= 4
    ? 'sm:grid-cols-2'
    : peers.length <= 6
      ? 'sm:grid-cols-2 lg:grid-cols-3'
      : 'sm:grid-cols-2 lg:grid-cols-4'

  return (
    <div
      className={`mesh-call-grid grid min-h-0 flex-1 grid-cols-1 gap-2 ${gridColumns}`}
      data-participant-count={peers.length}
      aria-label={`${peers.length} call participants`}
    >
      {peers.map((peer, index) => (
        <VoiceParticipantTile
          key={peer.publicKey}
          peer={peer}
          reconnecting={reconnecting}
          featured={threeParticipants && index === 0}
        />
      ))}
    </div>
  )
}

function VoiceParticipantTile({
  peer,
  reconnecting,
  featured,
}: {
  peer: Peer
  reconnecting: boolean
  featured: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const localMuted = useVoiceStore((state) => state.isMuted)
  const muted = peer.isSelf ? localMuted : Boolean(peer.muted)
  const speaking = Boolean(peer.speaking && !muted && !reconnecting)
  const visibleVideo = peer.cameraStream
  const previewImage = previewImageFor(peer)
  const state = reconnecting
    ? 'reconnecting'
    : muted
      ? 'muted'
      : speaking
        ? 'speaking'
        : 'listening'

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = visibleVideo ?? null
  }, [visibleVideo])

  return (
    /* The leading edge is always the bar, so a tile's media and caption cannot
       jog sideways the instant somebody starts talking; only the colour moves.
       The caption below names the same state, so colour is never the only cue. */
    <motion.figure
      initial={{ opacity: 0, y: motionOffsets.panel }}
      animate={{ opacity: 1, y: 0 }}
      transition={transitions.enter}
      className={`mesh-call-tile relative flex min-h-0 overflow-hidden rounded-xl bg-surface-container-high ${featured ? 'sm:col-span-2' : ''} `}
      data-speaking={speaking ? 'true' : undefined}
      aria-label={`${peer.displayName} call tile, ${peer.isSelf ? 'you, ' : ''}${state}`}
    >
      {/*
        The trust rail, reused as a speaking rail. Same 2px column, same three
        tones: green when this peer holds the floor, vermilion when muted, the
        structural hairline when idle. A person who has learned the mark in the
        timeline already knows how to read it here.
      */}
      <span
        aria-hidden="true"
        data-trust={speaking ? 'ok' : muted ? 'suspect' : 'idle'}
        className="mesh-trust-rail absolute inset-y-0 left-0 z-sticky w-trust-rail"
      />
      {previewImage ? (
        <img
          src={previewImage}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : visibleVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={peer.isSelf}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex min-h-full w-full items-center justify-center">
          <Avatar
            color={peer.avatarColor}
            size={80}
            name={peer.displayName}
            imageUrl={peer.avatarUrl}
          />
        </span>
      )}
      {/*
        A gradient scrim rather than a flat wash. A solid bar across the bottom
        of every tile is a second surface; a gradient is the media dimming into
        the ground it already sits on.
      */}
      <figcaption className="mesh-media-scrim absolute inset-x-0 bottom-0 px-3 pb-2 pt-6 text-on-media-overlay">
        <span className="min-w-0">
          <span className="block truncate text-title-md font-semibold">
            {peer.displayName}{peer.isSelf ? ' (you)' : ''}
          </span>
          <span className={`flex items-center gap-1 text-label-sm ${speaking ? 'text-primary' : 'text-on-media-overlay'}`}>
            {muted ? <Icon name="micOff" size="xs" aria-hidden="true" /> : null}
            {previewImage || visibleVideo ? `Camera on · ${state}` : state}
          </span>
        </span>
      </figcaption>
    </motion.figure>
  )
}

function VoiceMediaStage({
  peer,
  source = 'camera',
}: {
  peer: Peer
  source?: 'camera' | 'screen-share'
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const screenSharing = source === 'screen-share'
  const visibleVideo = screenSharing ? peer.screenShareStream : peer.cameraStream
  const previewImage = screenSharing ? undefined : previewImageFor(peer)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = visibleVideo ?? null
  }, [visibleVideo])

  return (
    <motion.figure
      initial={{ opacity: 0, y: motionOffsets.panel }}
      animate={{ opacity: 1, y: 0 }}
      transition={transitions.enter}
      className="relative mx-auto flex aspect-video min-h-0 w-full max-w-6xl flex-none overflow-hidden border border-outline bg-surface-container-lowest"
      aria-label={`${peer.displayName} ${screenSharing ? 'screen share' : 'camera'}`}
    >
      {previewImage ? (
        <img
          src={previewImage}
          alt={`${peer.displayName} camera preview`}
          className="h-full w-full object-cover"
        />
      ) : (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={peer.isSelf}
          className={`h-full w-full ${screenSharing ? 'object-contain' : 'object-cover'}`}
        />
      )}
      <figcaption className="mesh-media-scrim absolute inset-x-0 bottom-0 flex items-end justify-between px-4 pb-3 pt-8 text-on-media-overlay">
        <span>
          <span className="block text-title-md font-semibold">{peer.displayName}</span>
          <span className="flex items-center gap-1 text-label-sm text-on-media-overlay">
            {screenSharing ? <Icon name="screenShare" size="xs" aria-hidden="true" /> : null}
            {screenSharing ? 'Sharing screen' : 'Camera on'}
          </span>
        </span>
        {peer.speaking ? (
          <span className="border-l border-trust border-primary pl-3 text-label-md font-semibold text-primary">
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
    <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col items-center justify-center border-y border-outline-variant px-6 py-10 text-center">
      {activeSpeaker ? (
        <>
          <span className={`border p-1 ${activeSpeaker.speaking ? 'border-primary' : 'border-outline'}`}>
            <Avatar
              color={activeSpeaker.avatarColor}
              size={80}
              name={activeSpeaker.displayName}
              imageUrl={activeSpeaker.avatarUrl}
            />
          </span>
          <p className="mt-5 text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">
            {activeSpeaker.speaking ? 'Speaking' : 'Call ready'}
          </p>
          <h2 className="mt-2 text-headline-md font-semibold text-on-surface">
            {activeSpeaker.speaking ? `${activeSpeaker.displayName} is talking` : channelName}
          </h2>
          <p className="mt-2 max-w-md text-body-md text-on-surface-variant">
            {count === 1
              ? 'You are first in.'
              : `${count} people are here.`}
          </p>
        </>
      ) : (
        <>
          <Icon name="volume" size="lg" className="text-primary" aria-hidden="true" />
          <h2 className="mt-4 text-headline-md font-semibold text-on-surface">Call ready</h2>
          <p className="mt-2 max-w-md text-body-md text-on-surface-variant">
            You are first in {channelName}.
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
      className={`${className} min-h-0 flex-col border-l border-outline-variant bg-surface`}
      aria-label={`People in ${channelName}`}
      role={modal ? 'dialog' : undefined}
      aria-modal={modal || undefined}
      tabIndex={modal ? -1 : undefined}
    >
      <header className="flex h-14 flex-none items-center justify-between border-b border-outline-variant px-4">
        <span>
          <span className="block text-body-md font-semibold text-on-surface">In the call</span>
          <span className="block text-label-sm text-on-surface-variant">
            {peers.length} {peers.length === 1 ? 'person' : 'people'}
          </span>
        </span>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            aria-label="Close people list"
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
  const isMuted = useVoiceStore((state) => state.isMuted)
  const volume = useVoiceStore((state) => state.participantVolumes[peer.publicKey] ?? 1)
  const setParticipantVolume = useVoiceStore((state) => state.setParticipantVolume)
  const muted = peer.isSelf ? isMuted : Boolean(peer.muted)
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
  const sharingScreen = Boolean(peer.screenShareStream)
  const accessibleState = [peer.isSelf ? 'you' : null, muted ? 'muted' : null, speaking ? 'speaking' : null, sharingScreen ? 'sharing screen' : null]
    .filter(Boolean)
    .join(', ') || state

  return (
    /* The bar gutter is reserved on every row, so a row does not indent itself
       by its own bar width the moment its occupant starts talking. */
    <div
      className="group flex gap-3 border-b border-rule border-outline-variant px-shell-gutter py-3"
      aria-label={`${peer.displayName}, ${accessibleState}`}
    >
      {/*
        The same 2px column as the timeline, reading the same three tones:
        green when this peer holds the floor, vermilion when muted, the
        structural hairline when idle.
      */}
      <span
        aria-hidden="true"
        data-trust={speaking ? 'ok' : muted ? 'suspect' : 'idle'}
        className="mesh-trust-rail w-trust-rail flex-none self-stretch"
      />
      <div className="min-w-0 flex-1">
      <div className="flex items-center gap-3">
        <Avatar
          color={peer.avatarColor}
          size={26}
          name={peer.displayName}
          imageUrl={peer.avatarUrl}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-title-md font-semibold text-on-surface">
            {peer.displayName}{peer.isSelf ? ' (you)' : ''}
          </span>
          <span className={`flex items-center gap-1 text-label-sm ${speaking ? 'text-primary' : 'text-on-surface-variant'}`}>
            {sharingScreen ? <Icon name="screenShare" size="xs" aria-hidden="true" /> : null}
            {sharingScreen ? `sharing screen · ${state}` : state}
          </span>
        </span>
        {muted ? <Icon name="micOff" size="sm" className="text-marker" aria-hidden="true" /> : null}
      </div>
      {!peer.isSelf ? (
        /* Capped at 100: playback runs through the session sink's audio
           elements, whose gain cannot exceed 1.0, so a range above that would
           be a label that climbs while the level stays fixed. Boost needs a
           Web Audio gain graph before the range can honestly widen. */
        <label className="mesh-participant-volume mt-2 flex items-center gap-2 text-label-sm text-on-surface-variant opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <span>Volume</span>
          <input
            type="range"
            min={0}
            max={100}
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
          <span className="tnum w-8 text-right">{Math.round(volume * 100)}%</span>
        </label>
      ) : null}
      </div>
    </div>
  )
}
