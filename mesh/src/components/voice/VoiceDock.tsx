import { useMemo } from 'react'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useCallPeers, useVoiceStore } from '../../store/voice'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { useCurrentMeshRoute, useMeshNavigationStore } from '../../store/navigation'
import { playInterfaceSound } from '../../lib/interface-sounds'
import { voiceMediaErrorMessage } from '../../lib/voice-runtime'
import { showToast } from '../ui/Toast'
import { useVoiceEngineController } from './VoiceEngineProvider'

export function VoiceDock() {
  const { toggleCamera, toggleScreenSharing } = useVoiceEngineController()
  const route = useCurrentMeshRoute()
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)
  const currentCommunityId = useVoiceStore((state) => state.currentCommunityId)
  const localPublicKey = useVoiceStore((state) => state.localPublicKey)
  const peers = useCallPeers()
  const connectionState = useVoiceStore((state) => state.connectionState)
  const isMuted = useVoiceStore((state) => state.isMuted)
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const isCameraEnabled = useVoiceStore((state) => state.isCameraEnabled)
  const isScreenSharing = useVoiceStore((state) => state.isScreenSharing)
  const localAudioLevel = useVoiceStore((state) => state.localAudioLevel)
  const setMuted = useVoiceStore((state) => state.setMuted)
  const setDeafened = useVoiceStore((state) => state.setDeafened)
  const setCameraEnabled = useVoiceStore((state) => state.setCameraEnabled)
  const setScreenSharing = useVoiceStore((state) => state.setScreenSharing)
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
          avatarUrl: identity.avatarUrl,
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
          avatarUrl: peer.avatarUrl,
          speaking: peer.speaking,
          isLocal: false,
        })),
    ]
  }, [identity, isMuted, localAudioLevel, localPublicKey, peers])

  if (
    !currentChannelId
    || !currentCommunityId
    || (route.kind === 'voice' && route.roomId === currentChannelId)
  ) return null

  const openVoiceRoom = () => {
    navigate({
      kind: 'voice',
      communityId: currentCommunityId,
      roomId: currentChannelId,
    })
    setActiveCommunity(currentCommunityId)
    setActiveChannel(currentChannelId)
  }
  const retryVoice = () => {
    const communityId = currentCommunityId
    const channelId = currentChannelId
    setCurrentVoiceSession(null, null)
    requestAnimationFrame(() => setCurrentVoiceSession(communityId, channelId))
  }
  const leaveVoice = () => {
    setMuted(true)
    setCameraEnabled(false)
    setScreenSharing(false)
    setCurrentVoiceSession(null, null)
    void playInterfaceSound('voice-self-leave')
  }
  const voiceStateLabel = connectionState === 'reconnecting'
    ? `Reconnecting to ${voiceChannel?.name ?? 'voice'}`
    : connectionState === 'disconnected'
      ? 'Voice could not reconnect'
      : connectionState === 'connecting'
        ? `Joining ${voiceChannel?.name ?? 'voice'}`
        : `${participants.length} in call`

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
        className="mesh-voice-dock-room flex min-w-64 items-center gap-3 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        aria-label={`Open voice room ${voiceChannel?.name ?? 'Voice'}`}
      >
        <span className="mesh-voice-dock-room-icon flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-control border border-container-accent-line bg-container-accent text-accent">
          <Icon name="volume" size="sm" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-base font-semibold text-primary">
            {voiceChannel?.name ?? 'Voice'}
          </span>
          <span className="mesh-voice-dock-status mt-0.5 flex items-center gap-1.5 text-caption text-muted">
            <span
              className={`h-1.5 w-1.5 rounded-round ${
                connectionState === 'connected' ? 'bg-status-success' : 'bg-status-warning'
              }`}
              aria-hidden="true"
            />
            {voiceStateLabel}
          </span>
        </span>
      </button>

      <div className="mesh-voice-dock-participants hidden min-w-0 flex-1 items-center justify-center gap-3 sm:flex" aria-label="Voice participants">
        {participants.slice(0, 6).map((participant) => (
          <Tooltip
            key={participant.publicKey}
            content={`${participant.displayName}${participant.isLocal ? ' (you)' : ''}`}
            side="top"
          >
            <span className="mesh-voice-dock-participant flex min-w-12 flex-col items-center gap-1">
              {/* The ring is present only while talking, so the state survives
                  without colour vision. Padding stays fixed so speech onset
                  never nudges the row. */}
              <span
                className={`rounded-round p-0.5 ${
                  participant.speaking ? 'bg-status-success' : 'bg-transparent'
                }`}
              >
                <Avatar
                  color={participant.avatarColor}
                  size={42}
                  name={participant.displayName}
                  imageUrl={participant.avatarUrl}
                  className="border-2 border-surface-sunken"
                />
              </span>
              {/* Screen-reader-only until the dock has room for it, never
                  removed: who is talking must stay readable at every width. */}
              <span className="mesh-voice-dock-participant-copy sr-only min-w-0">
                <span className="block max-w-20 truncate text-caption font-medium text-secondary">
                  {participant.displayName.split(' ')[0]}
                </span>
                <span className={`block text-2xs ${participant.speaking ? 'text-status-success' : 'text-muted'}`}>
                  {participant.speaking ? 'Talking' : participant.isLocal ? 'You' : 'Listening'}
                </span>
              </span>
            </span>
          </Tooltip>
        ))}
        {participants.length > 6 && (
          <span className="text-caption text-muted">+{participants.length - 6}</span>
        )}
      </div>

      <div className="mesh-voice-dock-controls ml-auto flex flex-shrink-0 items-center gap-2 border-l border-border-subtle pl-4">
        {connectionState === 'disconnected' ? (
          <button
            type="button"
            onClick={retryVoice}
            className="flex min-h-11 items-center gap-2 rounded-control px-3 text-xs font-semibold text-accent transition-colors hover:bg-surface-hover"
          >
            <Icon name="refresh" size="sm" />
            <span className="hidden sm:inline">Try again</span>
          </button>
        ) : null}
        <VoiceDockButton
          label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          active={isMuted}
          onClick={() => setMuted(!isMuted)}
          icon={isMuted ? 'micOff' : 'mic'}
        />
        <VoiceDockButton
          label={isDeafened ? 'Turn incoming audio on' : 'Turn incoming audio off'}
          active={isDeafened}
          onClick={() => setDeafened(!isDeafened)}
          icon={isDeafened ? 'headphoneOff' : 'headphones'}
        />
        {isCameraEnabled ? (
          <VoiceDockButton
            label="Turn camera off"
            shortLabel="Camera off"
            active
            onClick={() => {
              void toggleCamera(false).catch((error) => {
                showToast(voiceMediaErrorMessage(error, 'camera'), 'error')
              })
            }}
            icon="videoOff"
          />
        ) : null}
        {isScreenSharing ? (
          <VoiceDockButton
            label="Stop sharing screen"
            shortLabel="Stop share"
            active
            onClick={() => {
              void toggleScreenSharing(false).catch((error) => {
                showToast(voiceMediaErrorMessage(error, 'screen-share'), 'error')
              })
            }}
            icon="screenShareOff"
          />
        ) : null}
        <button
          type="button"
          onClick={openVoiceRoom}
          className="mesh-voice-dock-open hidden min-h-11 items-center gap-2 rounded-control px-3 text-xs font-semibold text-secondary transition-colors hover:bg-surface-hover hover:text-primary md:flex"
          aria-label={`Open voice room ${voiceChannel?.name ?? 'Voice'}`}
        >
          <Icon name="panelRight" size="sm" />
          <span className="mesh-voice-dock-control-label">Open</span>
        </button>
        <button
          type="button"
          onClick={leaveVoice}
          className="flex min-h-11 items-center gap-2 rounded-control border border-container-danger-line px-4 text-xs font-semibold text-status-danger transition-colors hover:bg-container-danger-hover"
          aria-label={`Leave ${voiceChannel?.name ?? 'voice'}`}
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
  shortLabel,
}: {
  label: string
  active: boolean
  onClick: () => void
  icon: 'mic' | 'micOff' | 'headphones' | 'headphoneOff' | 'screenShareOff' | 'videoOff'
  shortLabel?: string
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
            ? 'bg-container-warning text-status-warning'
            : 'text-secondary hover:bg-surface-hover hover:text-primary'
        }`}
      >
        <Icon name={icon} size="sm" />
        <span className="hidden text-xs font-semibold lg:inline">
          {shortLabel ?? (label.startsWith('Unmute')
            ? 'Unmute'
            : label.startsWith('Mute')
              ? 'Mute'
              : label.endsWith(' on')
                ? 'Sound on'
                : 'Sound off')}
        </span>
      </button>
    </Tooltip>
  )
}
