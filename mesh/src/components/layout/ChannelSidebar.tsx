import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
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
import { ModalLoadingFallback } from '../ui/ModalLoadingFallback'
import { useIdentityStore } from '../../store/identity'
import { useNetworkStore } from '../../store/network'
import { EmptyState } from '../ui/Primitives'
import { useVirtualScroll, type VirtualItem } from '../../hooks/useVirtualScroll'

const CommunitySettings = lazy(() =>
  import('../community/CommunitySettings').then((module) => ({ default: module.CommunitySettings })),
)

type RoomListEntry =
  | {
      key: string
      kind: 'heading'
      roomType: 'text' | 'voice'
      label: string
      collapsed: boolean
    }
  | {
      key: string
      kind: 'room'
      channel: Channel
    }

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
  const networkStatus = useNetworkStore((state) => state.status)
  const storedIdentity = useIdentityStore((state) => state.identity)
  const matrixAccountId = matrixMode ? bridge.getMatrixUserId() : null
  const identityLabel = storedIdentity?.displayName || (matrixMode ? 'Mesh account' : 'Local identity')
  const homeService = serviceName(
    bridge.getBackendStatusSnapshot()?.homeserver
      ?? (matrixAccountId?.split(':').slice(1).join(':') || null),
  )

  const activeCommunity = useActiveCommunity()
  const communityChannels = useMemo(
    () => channels.filter((channel) => channel.communityId === activeCommunityId),
    [activeCommunityId, channels],
  )
  const textChannels = useMemo(
    () => communityChannels.filter((channel) => channel.channelType === 'text'),
    [communityChannels],
  )
  const voiceChannels = useMemo(
    () => communityChannels.filter((channel) => channel.channelType === 'voice'),
    [communityChannels],
  )
  const roomListEntries = useMemo<RoomListEntry[]>(() => {
    const entries: RoomListEntry[] = []
    if (textChannels.length > 0) {
      entries.push({
        key: 'heading:text',
        kind: 'heading',
        roomType: 'text',
        label: 'Rooms',
        collapsed: textCollapsed,
      })
      if (!textCollapsed) {
        for (const channel of textChannels) {
          entries.push({ key: `room:${channel.id}`, kind: 'room', channel })
        }
      }
    }
    if (voiceChannels.length > 0) {
      entries.push({
        key: 'heading:voice',
        kind: 'heading',
        roomType: 'voice',
        label: 'Voice rooms',
        collapsed: voiceCollapsed,
      })
      if (!voiceCollapsed) {
        for (const channel of voiceChannels) {
          entries.push({ key: `room:${channel.id}`, kind: 'room', channel })
        }
      }
    }
    return entries
  }, [textChannels, textCollapsed, voiceChannels, voiceCollapsed])
  const virtualRoomItems = useMemo<VirtualItem[]>(() => roomListEntries.map((entry) => {
    if (entry.kind === 'heading') {
      return {
        key: entry.key,
        type: 'gap',
        height: entry.roomType === 'voice' ? 44 : 32,
      }
    }
    const memberCount = matrixRtcMembersByRoom[entry.channel.id]?.length ?? 0
    return {
      key: entry.key,
      type: 'message',
      height:
        entry.channel.channelType === 'voice'
          ? 36 + Math.min(memberCount, 8) * 24 + (memberCount > 8 ? 20 : 0)
          : 36,
    }
  }), [matrixRtcMembersByRoom, roomListEntries])
  const {
    scrollContainerRef,
    topSpacerHeight,
    bottomSpacerHeight,
    visibleRange,
    handleMeasuredHeight,
    handleScroll,
    resetLayout,
  } = useVirtualScroll(virtualRoomItems, {
    estimatedMessageHeight: 36,
    estimatedGapHeight: 32,
    overscanPx: 800,
  })
  const visibleRoomEntries = useMemo(
    () => roomListEntries.length === 0
      ? []
      : roomListEntries.slice(visibleRange.start, visibleRange.end + 1),
    [roomListEntries, visibleRange.end, visibleRange.start],
  )
  useEffect(() => {
    resetLayout()
  }, [activeCommunityId, resetLayout, textCollapsed, voiceCollapsed])
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
      showToast('Could not mark this room as read. Try again.', 'error')
    }
  }

  const copyChannelLink = async (channel: Channel) => {
    try {
      const link = bridge.isMatrixBackend()
        ? matrixRoomPermalink(channel.id)
        : await bridge.generateInviteLink(channel.communityId)
      await copyText(link)
      showToast('Room link copied.', 'success')
    } catch {
      showToast('Could not copy this room link.', 'error')
    }
  }

  if (!activeCommunity) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex h-conversation-header flex-shrink-0 items-center border-b border-border-subtle px-4">
          <h2 className="text-sm font-semibold text-primary">Your servers</h2>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            variant="compact"
            icon={<Icon name={communityCount > 0 ? 'hash' : 'users'} size="lg" />}
            title={communityCount > 0 ? 'Choose a community' : 'Find your people'}
            description={
              communityCount > 0
                ? 'Select a community icon to view its rooms.'
                : 'Use the plus button to create or join a community.'
            }
          />
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
        <button
          className="flex h-conversation-header flex-shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => setShowSettings(true)}
          aria-label={`Open settings for ${activeCommunity.name}`}
          data-tauri-drag-region
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-primary">
              {activeCommunity.name}
            </span>
            <span className="mt-1 block truncate text-caption text-muted">
              {homeService ?? (matrixMode ? 'Connected service' : 'Local community')}
            </span>
            <span className="mt-0.5 block truncate text-caption text-secondary">
              Identity · {identityLabel}
            </span>
            <span className="mt-1 flex items-center gap-1.5 text-caption text-muted">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  networkStatus.state === 'connected'
                    ? 'bg-status-success'
                    : networkStatus.state === 'connecting'
                      ? 'bg-status-warning'
                      : 'bg-status-warning'
                }`}
                aria-hidden="true"
              />
              {networkStatus.state === 'connected'
                ? 'Synced'
                : networkStatus.state === 'connecting'
                  ? 'Syncing'
                  : 'Offline'}
            </span>
          </span>
          <Icon name="settings" size="sm" className="mt-0.5 flex-shrink-0 text-muted" />
        </button>

        {/* Room list */}
        <div
          id="community-room-list"
          ref={scrollContainerRef}
          onScroll={() => void handleScroll()}
          className="flex-1 overflow-y-auto px-2 py-3"
          role="list"
          aria-label="Community rooms"
        >
          <div
            className="space-y-0.5"
            data-design-token-exception="data-driven-virtual-spacer-geometry"
            style={{
              paddingTop: `${topSpacerHeight}px`,
              paddingBottom: `${bottomSpacerHeight}px`,
            }}
          >
            {visibleRoomEntries.map((entry, visibleIndex) => {
              const listPosition = visibleRange.start + visibleIndex + 1
              if (entry.kind === 'heading') {
                const collapsed = entry.collapsed
                const toggle = entry.roomType === 'text'
                  ? () => setTextCollapsed((current) => !current)
                  : () => setVoiceCollapsed((current) => !current)
                return (
                  <MeasuredRoomRow
                    key={entry.key}
                    rowKey={entry.key}
                    onHeightChange={handleMeasuredHeight}
                  >
                    <div
                      role="listitem"
                      aria-posinset={listPosition}
                      aria-setsize={roomListEntries.length}
                      className={entry.roomType === 'voice' ? 'pt-3' : undefined}
                    >
                      <button
                        onClick={toggle}
                        className="group flex min-h-8 w-full items-center gap-0.5 px-0.5 text-left"
                        aria-expanded={!collapsed}
                        aria-controls="community-room-list"
                      >
                        <Icon
                          name="chevronDown"
                          size="xs"
                          className={`text-muted transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}
                        />
                        <span
                          role="heading"
                          aria-level={3}
                          className="text-meta font-semibold uppercase tracking-caption text-muted group-hover:text-secondary"
                        >
                          {entry.label}
                        </span>
                      </button>
                    </div>
                  </MeasuredRoomRow>
                )
              }

              const channel = entry.channel
              if (channel.channelType === 'text') {
                return (
                  <MeasuredRoomRow
                    key={entry.key}
                    rowKey={entry.key}
                    onHeightChange={handleMeasuredHeight}
                  >
                    <div
                      role="listitem"
                      aria-posinset={listPosition}
                      aria-setsize={roomListEntries.length}
                    >
                      <ChannelItem
                        channel={channel}
                        active={channel.id === activeChannelId}
                        onClick={() => setActiveChannel(channel.id)}
                        onMarkRead={() => void markRead(channel)}
                        onOpenNotificationSettings={() => setProfileOpen(true)}
                        onCopyLink={() => void copyChannelLink(channel)}
                      />
                    </div>
                  </MeasuredRoomRow>
                )
              }

              const members = matrixRtcMembersByRoom[channel.id] ?? []
              const joinChannel = () => {
                setActiveChannel(channel.id)
                if (shouldActivateVoiceSession(matrixMode, matrixVoiceReady)) {
                  setCurrentVoiceSession(activeCommunityId, channel.id)
                }
              }

              return (
                <MeasuredRoomRow
                  key={entry.key}
                  rowKey={entry.key}
                  onHeightChange={handleMeasuredHeight}
                >
                  <div
                    role="listitem"
                    aria-posinset={listPosition}
                    aria-setsize={roomListEntries.length}
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
                            className="flex w-full items-center gap-1.5 rounded-control px-1 py-0.5 text-left text-xs text-muted hover:bg-surface-hover hover:text-secondary"
                          >
                            <span
                              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-control bg-surface-active text-meta font-semibold text-secondary"
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
                          <div className="member-count px-1 text-meta text-muted">
                            +{members.length - 8} more
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </MeasuredRoomRow>
              )
            })}
          </div>
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
        title="Community Settings"
      >
        {showSettings && (
          <Suspense fallback={<ModalLoadingFallback title="Community Settings" label="Loading community settings" />}>
            <CommunitySettings isOpen onClose={() => setShowSettings(false)} />
          </Suspense>
        )}
      </DialogErrorBoundary>
    </>
  )
}

function MeasuredRoomRow({
  rowKey,
  onHeightChange,
  children,
}: {
  rowKey: string
  onHeightChange: (rowKey: string, height: number) => void
  children: ReactNode
}) {
  const rowRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = rowRef.current
    if (!element) return
    const reportHeight = () => onHeightChange(rowKey, element.offsetHeight)
    reportHeight()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reportHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [onHeightChange, rowKey])

  return <div ref={rowRef}>{children}</div>
}

function serviceName(value: string | null | undefined) {
  if (!value) return null
  try {
    return new URL(value).host || null
  } catch {
    return value.replace(/^[a-z]+:\/\//i, '').split('/')[0].trim() || null
  }
}
