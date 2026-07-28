import { lazy, Suspense, useState } from 'react'
import { useActiveCommunity, useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { useVoiceStore } from '../../store/voice'
import { ChannelItem } from '../community/ChannelItem'
import { UserPanel } from './UserPanel'
import { DialogErrorBoundary, ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { useShellStore } from '../../store/shell'
import * as bridge from '../../lib/bridge'
import { copyText, matrixRoomPermalink } from '../../lib/notifications'
import { showToast } from '../ui/Toast'
import type { Channel } from '../../types/ipc'
import { useMatrixRtcMembershipSync } from '../../hooks/useMatrixRtcMembershipSync'
import { canStartMatrixVoice, shouldActivateVoiceSession } from '../../lib/voice-runtime'
import { Spinner } from '../ui/Spinner'

const CommunitySettings = lazy(() =>
  import('../community/CommunitySettings').then((module) => ({ default: module.CommunitySettings })),
)

export function ChannelSidebar() {
  const communityCount = useCommunityStore((state) => state.communityOrder.length)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const channels = useChannelStore((state) => state.channels)
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)
  const currentCommunityId = useVoiceStore((state) => state.currentCommunityId)
  const setCurrentVoiceSession = useVoiceStore((state) => state.setCurrentVoiceSession)
  const matrixRtcMembersByRoom = useVoiceStore((state) => state.matrixRtcMembersByRoom)
  const setProfileOpen = useShellStore((state) => state.setProfileOpen)
  const [showSettings, setShowSettings] = useState(false)
  const [textCollapsed, setTextCollapsed] = useState(false)
  const [voiceCollapsed, setVoiceCollapsed] = useState(false)
  const matrixMode = bridge.isMatrixBackend()
  const matrixVoiceReady = canStartMatrixVoice(bridge.getBackendStatusSnapshot())

  const activeCommunity = useActiveCommunity()
  const communityChannels = channels.filter((c) => c.communityId === activeCommunityId)
  const textChannels = communityChannels.filter((c) => c.channelType === 'text')
  const voiceChannels = communityChannels.filter((c) => c.channelType === 'voice')
  useMatrixRtcMembershipSync(
    matrixMode
      ? channels.filter((channel) => channel.channelType === 'voice').map((channel) => channel.id)
      : [],
  )

  const markRead = async (channel: Channel) => {
    const previousUnread = channel.unreadCount ?? 0
    patchChannel(channel.id, { unreadCount: 0 })
    try {
      await bridge.markChannelRead(channel.id)
    } catch {
      patchChannel(channel.id, { unreadCount: previousUnread })
      showToast('Could not mark this channel as read. Try again.', 'error')
    }
  }

  const copyChannelLink = async (channel: Channel) => {
    try {
      const link = bridge.isMatrixBackend()
        ? matrixRoomPermalink(channel.id)
        : await bridge.generateInviteLink(channel.communityId)
      await copyText(link)
      showToast('Channel link copied.', 'success')
    } catch {
      showToast('Could not copy this channel link.', 'error')
    }
  }

  if (!activeCommunity) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex h-12 flex-shrink-0 items-center border-b border-border-subtle px-4">
          <h2 className="text-sm font-semibold text-primary">Your servers</h2>
        </div>
        <div className="flex flex-1 items-center px-5 py-8 text-center">
          <div>
            <p className="text-sm font-medium text-primary">
              {communityCount > 0 ? 'Choose a server' : 'Find your people'}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted">
              {communityCount > 0
                ? 'Select a server icon to view its channels.'
                : 'Use the plus button to create or join a server.'}
            </p>
          </div>
        </div>
        <ScopedErrorBoundary
          name="User controls"
          description="Account controls could not be displayed."
          className="m-2"
        >
          <UserPanel />
        </ScopedErrorBoundary>
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Server name header */}
        <button
          className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border-subtle px-4 transition-colors hover:bg-bg-modifier-hover"
          onClick={() => setShowSettings(true)}
          data-tauri-drag-region
        >
          <h2 className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-primary">
            {activeCommunity.name}
          </h2>
          <Icon name="chevronDown" size="sm" className="flex-shrink-0 text-muted" />
        </button>

        {/* Channel list */}
        <div className="flex-1 overflow-y-auto px-2 py-4">
          {/* Text Channels category */}
          {textChannels.length > 0 && (
            <div className="mb-1">
              <button
                onClick={() => setTextCollapsed(!textCollapsed)}
                className="group flex min-h-8 w-full items-center gap-0.5 px-0.5 text-left"
                aria-expanded={!textCollapsed}
                aria-controls="text-channel-list"
              >
                <Icon
                  name="chevronDown"
                  size="xs"
                  className={`text-muted transition-transform duration-150 ${textCollapsed ? '-rotate-90' : ''}`}
                />
                <span className="text-meta font-semibold uppercase tracking-caption text-muted group-hover:text-secondary">
                  Text Channels
                </span>
              </button>
              {!textCollapsed && (
                <div id="text-channel-list" className="space-y-0.5">
                  {textChannels.map((channel) => (
                    <ChannelItem
                      key={channel.id}
                      channel={channel}
                      active={channel.id === activeChannelId}
                      onClick={() => setActiveChannel(channel.id)}
                      onMarkRead={() => void markRead(channel)}
                      onOpenNotificationSettings={() => setProfileOpen(true)}
                      onCopyLink={() => void copyChannelLink(channel)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Voice Channels category */}
          {voiceChannels.length > 0 && (
            <div className="mb-1 mt-3">
              <button
                onClick={() => setVoiceCollapsed(!voiceCollapsed)}
                className="group flex min-h-8 w-full items-center gap-0.5 px-0.5 text-left"
                aria-expanded={!voiceCollapsed}
                aria-controls="voice-channel-list"
              >
                <Icon
                  name="chevronDown"
                  size="xs"
                  className={`text-muted transition-transform duration-150 ${voiceCollapsed ? '-rotate-90' : ''}`}
                />
                <span className="text-meta font-semibold uppercase tracking-caption text-muted group-hover:text-secondary">
                  Voice Channels
                </span>
              </button>
              {!voiceCollapsed && (
                <div id="voice-channel-list" className="space-y-0.5">
                  {voiceChannels.map((channel) => {
                    const members = matrixRtcMembersByRoom[channel.id] ?? []
                    const joinChannel = () => {
                      setActiveChannel(channel.id)
                      if (shouldActivateVoiceSession(matrixMode, matrixVoiceReady)) {
                        setCurrentVoiceSession(activeCommunityId, channel.id)
                      }
                    }

                    return (
                      <div
                        key={channel.id}
                        draggable={
                          channel.id === currentChannelId &&
                          channel.communityId === currentCommunityId
                        }
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData(
                            'application/x-mesh-voice-channel',
                            channel.id,
                          )
                        }}
                        onDragOver={(event) => {
                          if (
                            currentChannelId &&
                            currentCommunityId === channel.communityId &&
                            currentChannelId !== channel.id
                          ) {
                            event.preventDefault()
                            event.dataTransfer.dropEffect = 'move'
                          }
                        }}
                        onDrop={(event) => {
                          const sourceChannelId = event.dataTransfer.getData(
                            'application/x-mesh-voice-channel',
                          )
                          if (
                            sourceChannelId &&
                            sourceChannelId === currentChannelId &&
                            currentCommunityId === channel.communityId &&
                            sourceChannelId !== channel.id
                          ) {
                            event.preventDefault()
                            joinChannel()
                          }
                        }}
                      >
                        <ChannelItem
                          channel={channel}
                          active={
                            channel.id === currentChannelId &&
                            channel.communityId === currentCommunityId
                          }
                          onClick={joinChannel}
                          onMarkRead={() => void markRead(channel)}
                          onOpenNotificationSettings={() => setProfileOpen(true)}
                          onCopyLink={() => void copyChannelLink(channel)}
                        />
                        {members.length > 0 && (
                          <div
                            className="ml-7 mt-0.5 space-y-0.5"
                            aria-label={`${channel.name} call members`}
                          >
                            {members.slice(0, 8).map((member) => (
                              <button
                                key={`${member.userId}:${member.deviceId}:${member.sessionId}`}
                                type="button"
                                onClick={joinChannel}
                                className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted hover:bg-bg-modifier-hover hover:text-secondary"
                              >
                                <span
                                  className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-bg-modifier-active text-meta font-semibold text-secondary"
                                  aria-hidden="true"
                                >
                                  {(member.displayName || member.userId).slice(0, 1).toUpperCase()}
                                </span>
                                <span className="truncate">
                                  {member.displayName || member.userId}
                                </span>
                              </button>
                            ))}
                            {members.length > 8 && (
                              <div className="px-1 text-meta text-muted">
                                +{members.length - 8} more
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* User panel — Discord-style bottom bar */}
        <ScopedErrorBoundary
          name="User controls"
          description="Account controls could not be displayed."
          className="m-2"
        >
          <UserPanel />
        </ScopedErrorBoundary>
      </div>

      <DialogErrorBoundary
        open={showSettings}
        onClose={() => setShowSettings(false)}
        title="Server Settings"
      >
        {showSettings && (
          <Suspense fallback={<div role="status" aria-label="Loading server settings" className="flex items-center justify-center p-6"><Spinner /></div>}>
            <CommunitySettings isOpen onClose={() => setShowSettings(false)} />
          </Suspense>
        )}
      </DialogErrorBoundary>
    </>
  )
}
