import { useMemo } from 'react'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useVoiceStore } from '../../store/voice'
import { voiceConnectionLabel } from '../../lib/voice-runtime'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'

export function VoiceDock() {
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)
  const currentCommunityId = useVoiceStore((state) => state.currentCommunityId)
  const localPublicKey = useVoiceStore((state) => state.localPublicKey)
  const peers = useVoiceStore((state) => state.peers)
  const connectionState = useVoiceStore((state) => state.connectionState)
  const isMuted = useVoiceStore((state) => state.isMuted)
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const localAudioLevel = useVoiceStore((state) => state.localAudioLevel)
  const setMuted = useVoiceStore((state) => state.setMuted)
  const setDeafened = useVoiceStore((state) => state.setDeafened)
  const setCurrentVoiceSession = useVoiceStore((state) => state.setCurrentVoiceSession)
  const identity = useIdentityStore((state) => state.identity)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const voiceChannel = useChannelStore((state) => (
    currentChannelId ? state.channelEntities[currentChannelId] : undefined
  ))

  const participants = useMemo(() => {
    const localParticipant = identity
      ? [{
          publicKey: localPublicKey ?? identity.publicKey,
          displayName: identity.displayName,
          avatarColor: identity.avatarColor,
          speaking: !isMuted && localAudioLevel > 0.05,
          isLocal: true,
        }]
      : []
    return [
      ...localParticipant,
      ...peers
        .filter((peer) => peer.publicKey !== (localPublicKey ?? identity?.publicKey))
        .map((peer) => ({
          publicKey: peer.publicKey,
          displayName: peer.displayName,
          avatarColor: peer.avatarColor,
          speaking: peer.speaking,
          isLocal: false,
        })),
    ]
  }, [identity, isMuted, localAudioLevel, localPublicKey, peers])

  if (!currentChannelId || !currentCommunityId || activeChannelId === currentChannelId) return null

  const openVoiceRoom = () => {
    setActiveCommunity(currentCommunityId)
    setActiveChannel(currentChannelId)
  }

  return (
    <section
      className="mesh-voice-dock flex flex-shrink-0 items-center gap-4 border-t border-border-subtle bg-surface-sunken px-4 py-3"
      aria-label={`Voice room ${voiceChannel?.name ?? 'Voice'}`}
      data-mesh-region
      tabIndex={-1}
    >
      <button
        type="button"
        onClick={openVoiceRoom}
        className="flex min-w-64 items-center gap-3 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={`Open voice room ${voiceChannel?.name ?? 'Voice'}`}
      >
        <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-control border border-accent/40 bg-accent/10 text-accent">
          <Icon name="volume" size="sm" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-base font-semibold text-primary">
            {voiceChannel?.name ?? 'Voice'}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-caption text-muted">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connectionState === 'connected' ? 'bg-status-success' : 'bg-status-warning'
              }`}
              aria-hidden="true"
            />
            {voiceConnectionLabel(connectionState)}
          </span>
          <span className="mt-0.5 hidden text-caption text-muted lg:block">Drop in to create together.</span>
        </span>
      </button>

      <div className="hidden min-w-0 flex-1 items-center justify-center gap-3 sm:flex" aria-label="Voice participants">
        {participants.slice(0, 6).map((participant) => (
          <Tooltip
            key={participant.publicKey}
            content={`${participant.displayName}${participant.isLocal ? ' (you)' : ''}`}
            side="top"
          >
            <span className="flex min-w-12 flex-col items-center gap-1">
              <span
                className={`rounded-full p-0.5 ${
                  participant.speaking ? 'bg-status-success' : 'bg-border-emphasis'
                }`}
              >
                <Avatar
                  color={participant.avatarColor}
                  size={42}
                  name={participant.displayName}
                  className="!rounded-full border-2 border-surface-sunken"
                />
              </span>
              <span className="hidden max-w-16 truncate text-caption font-medium text-secondary xl:block">
                {participant.displayName.split(' ')[0]}
              </span>
              <span className={`hidden text-2xs xl:block ${participant.speaking ? 'text-status-success' : 'text-muted'}`}>
                {participant.speaking ? 'Talking' : participant.isLocal ? 'You' : 'Listening'}
              </span>
            </span>
          </Tooltip>
        ))}
        {participants.length > 6 && (
          <span className="text-caption text-muted">+{participants.length - 6}</span>
        )}
      </div>

      <div className="ml-auto flex flex-shrink-0 items-center gap-2 border-l border-border-subtle pl-4">
        <VoiceDockButton
          label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          active={isMuted}
          onClick={() => setMuted(!isMuted)}
          icon={isMuted ? 'micOff' : 'mic'}
        />
        <VoiceDockButton
          label={isDeafened ? 'Undeafen audio' : 'Deafen audio'}
          active={isDeafened}
          onClick={() => setDeafened(!isDeafened)}
          icon={isDeafened ? 'headphoneOff' : 'headphones'}
        />
        <button
          type="button"
          onClick={openVoiceRoom}
          className="hidden min-h-11 items-center gap-2 rounded-control px-3 text-xs font-semibold text-secondary transition-colors hover:bg-surface-hover hover:text-primary md:flex"
        >
          <Icon name="panelRight" size="sm" />
          Open
        </button>
        <button
          type="button"
          onClick={() => setCurrentVoiceSession(null, null)}
          className="flex min-h-11 items-center gap-2 rounded-control border border-status-danger/60 px-4 text-xs font-semibold text-status-danger transition-colors hover:bg-status-danger/10"
          aria-label="Leave voice room"
        >
          <Icon name="phoneOff" size="sm" />
          <span className="hidden sm:inline">Leave</span>
        </button>
      </div>
    </section>
  )
}

function VoiceDockButton({
  label,
  active,
  onClick,
  icon,
}: {
  label: string
  active: boolean
  onClick: () => void
  icon: 'mic' | 'micOff' | 'headphones' | 'headphoneOff'
}) {
  return (
    <Tooltip content={label} side="top">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        className={`flex min-h-11 items-center justify-center gap-2 rounded-control px-3 transition-colors ${
          active
            ? 'bg-status-warning/15 text-status-warning'
            : 'text-secondary hover:bg-surface-hover hover:text-primary'
        }`}
      >
        <Icon name={icon} size="sm" />
        <span className="hidden text-xs font-semibold lg:inline">
          {label.startsWith('Unmute') ? 'Unmute' : label.startsWith('Mute') ? 'Mute' : label.startsWith('Undeafen') ? 'Undeafen' : 'Deafen'}
        </span>
      </button>
    </Tooltip>
  )
}
