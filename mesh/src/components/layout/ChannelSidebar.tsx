import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useActiveCommunity, useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { useVoiceStore } from '../../store/voice'
import { ChannelItem } from '../community/ChannelItem'
import { UserPanel } from './UserPanel'
import { DialogErrorBoundary, ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { Avatar } from '../ui/Avatar'
import { useShellStore } from '../../store/shell'
import * as bridge from '../../lib/bridge'
import { copyText, matrixRoomPermalink } from '../../lib/notifications'
import { showToast } from '../ui/Toast'
import type { Channel } from '../../types/ipc'
import { useMatrixRtcMembershipSync } from '../../hooks/useMatrixRtcMembershipSync'
import { canStartMatrixVoice, shouldActivateVoiceSession } from '../../lib/voice-runtime'
import { ModalLoadingFallback } from '../ui/ModalLoadingFallback'
import { EmptyState } from '../ui/Primitives'
import { useVirtualScroll, type VirtualItem } from '../../hooks/useVirtualScroll'
import { IconButton } from '../ui/IconButton'

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
      collapsible: boolean
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
  const activeRefresh = useChannelStore((state) => (
    activeCommunityId ? state.refreshByCommunity[activeCommunityId] : undefined
  ))
  const requestCommunityRefresh = useChannelStore((state) => state.requestCommunityRefresh)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)
  const currentCommunityId = useVoiceStore((state) => state.currentCommunityId)
  const setCurrentVoiceSession = useVoiceStore((state) => state.setCurrentVoiceSession)
  const matrixRtcMembersByRoom = useVoiceStore((state) => state.matrixRtcMembersByRoom)
  const setProfileOpen = useShellStore((state) => state.setProfileOpen)
  const [showSettings, setShowSettings] = useState(false)
  const [voiceCollapsed, setVoiceCollapsed] = useState(false)
  const [roomFocus, setRoomFocus] = useState({
    activeChannelId,
    roomId: activeChannelId,
  })
  const typeaheadRef = useRef('')
  const typeaheadTimerRef = useRef<number | null>(null)
  const matrixMode = bridge.isMatrixBackend()
  const matrixVoiceReady = canStartMatrixVoice(bridge.getBackendStatusSnapshot())
  const matrixAccountId = matrixMode ? bridge.getMatrixUserId() : null
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
      const startHere = textChannels.filter((channel) =>
        ['welcome', 'announcements'].includes(channel.name.toLocaleLowerCase()),
      )
      const projects = textChannels.filter((channel) =>
        channel.name.toLocaleLowerCase().startsWith('project-'),
      )
      const chat = textChannels.filter((channel) =>
        !startHere.includes(channel) && !projects.includes(channel),
      )
      const sections = [
        ['start-here', 'Start here', startHere],
        ['chat', 'Chat', chat],
        ['projects', 'Projects', projects],
      ] as const

      for (const [key, label, sectionChannels] of sections) {
        if (sectionChannels.length === 0) continue
        entries.push({
          key: `heading:${key}`,
          kind: 'heading',
          roomType: 'text',
          label,
          collapsed: false,
          collapsible: false,
        })
        for (const channel of sectionChannels) {
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
        collapsible: true,
      })
      if (!voiceCollapsed) {
        for (const channel of voiceChannels) {
          entries.push({ key: `room:${channel.id}`, kind: 'room', channel })
        }
      }
    }
    return entries
  }, [textChannels, voiceChannels, voiceCollapsed])
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
    scrollToItem,
  } = useVirtualScroll(virtualRoomItems, {
    estimatedMessageHeight: 36,
    estimatedGapHeight: 32,
    overscanPx: 800,
    autoScrollToBottom: false,
  })
  const visibleRoomEntries = useMemo(
    () => roomListEntries.length === 0
      ? []
      : roomListEntries.slice(visibleRange.start, visibleRange.end + 1),
    [roomListEntries, visibleRange.end, visibleRange.start],
  )
  useEffect(() => {
    resetLayout()
  }, [activeCommunityId, resetLayout, voiceCollapsed])
  const navigableRooms = useMemo(
    () => roomListEntries.flatMap((entry) => entry.kind === 'room' ? [entry.channel] : []),
    [roomListEntries],
  )
  const activeRoomIsNavigable = Boolean(
    activeChannelId && navigableRooms.some((room) => room.id === activeChannelId),
  )
  const focusedRoomIsNavigable = Boolean(
    roomFocus.roomId && navigableRooms.some((room) => room.id === roomFocus.roomId),
  )
  let focusedRoomId = roomFocus.roomId
  if (roomFocus.activeChannelId !== activeChannelId) {
    focusedRoomId = activeRoomIsNavigable
      ? activeChannelId
      : navigableRooms[0]?.id ?? null
  } else if (!focusedRoomIsNavigable) {
    focusedRoomId = activeRoomIsNavigable
      ? activeChannelId
      : navigableRooms[0]?.id ?? null
  }
  if (
    roomFocus.activeChannelId !== activeChannelId
    || roomFocus.roomId !== focusedRoomId
  ) {
    setRoomFocus({ activeChannelId, roomId: focusedRoomId })
  }
  useEffect(() => () => {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current)
  }, [])

  const focusRoom = (roomId: string) => {
    setRoomFocus({ activeChannelId, roomId })
    scrollToItem(`room:${roomId}`)
    window.requestAnimationFrame(() => {
      const target = [...document.querySelectorAll<HTMLButtonElement>('[data-room-id]')]
        .find((button) => button.dataset.roomId === roomId)
      target?.focus()
    })
  }

  const handleRoomListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLButtonElement>('button[data-room-id]')
      : null
    if (!target || navigableRooms.length === 0) return
    const currentIndex = Math.max(
      0,
      navigableRooms.findIndex((room) => room.id === target.dataset.roomId),
    )
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = Math.min(navigableRooms.length - 1, currentIndex + 1)
    else if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1)
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = navigableRooms.length - 1
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeaheadRef.current += event.key.toLocaleLowerCase()
      if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current)
      typeaheadTimerRef.current = window.setTimeout(() => {
        typeaheadRef.current = ''
        typeaheadTimerRef.current = null
      }, 700)
      const start = (currentIndex + 1) % navigableRooms.length
      const ordered = [...navigableRooms.slice(start), ...navigableRooms.slice(0, start)]
      const match = ordered.find((room) => (
        room.name.toLocaleLowerCase().startsWith(typeaheadRef.current)
      ))
      if (match) nextIndex = navigableRooms.indexOf(match)
    }
    if (nextIndex === null) return
    event.preventDefault()
    focusRoom(navigableRooms[nextIndex].id)
  }
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
        <div className="mesh-community-header relative flex min-h-28 flex-shrink-0 items-end justify-between gap-2 overflow-hidden border-b border-border-subtle px-4 pb-4 pt-5">
          {activeCommunity.bannerUrl ? (
            <img
              src={activeCommunity.bannerUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-cover opacity-45"
            />
          ) : null}
          <span className="relative min-w-0 flex-1">
            <span className="block truncate text-base font-semibold tracking-tight text-primary">
              {activeCommunity.name}
            </span>
            <span className="mt-1 flex items-center gap-2 truncate text-caption text-secondary">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-status-success" aria-hidden="true" />
                {activeCommunity.role === 'owner' ? 'Private' : 'Member'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="truncate">
                {homeService ?? (matrixMode ? 'Connected' : 'Local community')}
              </span>
            </span>
          </span>
          <IconButton
            size="sm"
            aria-label={`Open settings for ${activeCommunity.name}`}
            className="relative"
            onClick={() => setShowSettings(true)}
          >
            <Icon name="ellipsis" size="sm" />
          </IconButton>
        </div>

        {/* Room list */}
        <div
          id="community-room-list"
          ref={scrollContainerRef}
          onScroll={() => void handleScroll()}
          onKeyDown={handleRoomListKeyDown}
          className="mesh-room-list flex-1 overflow-y-auto px-2 py-3"
          role="navigation"
          aria-label="Community rooms"
        >
          {activeRefresh && (activeRefresh.status === 'failed' || activeRefresh.status === 'stale') && (
            <div
              role="alert"
              className="mb-2 rounded-control border border-status-warning/30 bg-status-warning/10 px-2 py-2 text-xs text-secondary"
            >
              <p>
                {activeRefresh.status === 'stale'
                  ? 'Rooms could not be refreshed. Showing the last update.'
                  : 'Rooms could not be loaded.'}
              </p>
              <button
                type="button"
                className="mt-1 min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
                onClick={() => activeCommunityId && requestCommunityRefresh(activeCommunityId)}
              >
                Retry rooms
              </button>
            </div>
          )}
          <div
            className="space-y-0.5"
            data-design-token-exception="data-driven-virtual-spacer-geometry"
            style={{
              paddingTop: `${topSpacerHeight}px`,
              paddingBottom: `${bottomSpacerHeight}px`,
            }}
          >
            {visibleRoomEntries.map((entry) => {
              if (entry.kind === 'heading') {
                const collapsed = entry.collapsed
                return (
                  <MeasuredRoomRow
                    key={entry.key}
                    rowKey={entry.key}
                    onHeightChange={handleMeasuredHeight}
                  >
                    <h3 className={entry.roomType === 'voice' || entry.label !== 'Start here' ? 'pt-3' : undefined}>
                      {entry.collapsible ? (
                      <button
                        onClick={() => setVoiceCollapsed((current) => !current)}
                        className="group flex min-h-8 w-full items-center gap-0.5 px-0.5 text-left"
                        aria-expanded={!collapsed}
                      >
                        <Icon
                          name="chevronDown"
                          size="xs"
                          className={`text-muted transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}
                        />
                        <span className="text-meta font-semibold uppercase tracking-caption text-muted group-hover:text-secondary">
                          {entry.label}
                        </span>
                      </button>
                      ) : (
                        <span className="flex min-h-8 items-center px-1 text-meta font-semibold uppercase tracking-caption text-muted">
                          {entry.label}
                        </span>
                      )}
                    </h3>
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
                    <div role="presentation">
                      <ChannelItem
                        channel={channel}
                        matrixMode={matrixMode}
                        active={channel.id === activeChannelId}
                        onClick={() => setActiveChannel(channel.id)}
                        onMarkRead={() => void markRead(channel)}
                        onOpenNotificationSettings={() => setProfileOpen(true)}
                        onCopyLink={() => void copyChannelLink(channel)}
                        tabIndex={focusedRoomId === channel.id ? 0 : -1}
                        onFocus={() => setRoomFocus({ activeChannelId, roomId: channel.id })}
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
                    role="presentation"
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
                      matrixMode={matrixMode}
                      active={
                        channel.id === currentChannelId &&
                        channel.communityId === currentCommunityId
                      }
                      onClick={joinChannel}
                      onMarkRead={() => void markRead(channel)}
                      onOpenNotificationSettings={() => setProfileOpen(true)}
                      onCopyLink={() => void copyChannelLink(channel)}
                      tabIndex={focusedRoomId === channel.id ? 0 : -1}
                      onFocus={() => setRoomFocus({ activeChannelId, roomId: channel.id })}
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
                            className="flex min-h-6 w-full items-center gap-1.5 rounded-control px-1 py-0.5 text-left text-xs text-muted hover:bg-surface-hover hover:text-secondary"
                          >
                            <Avatar
                              color="var(--avatar-violet)"
                              size={16}
                              name={member.displayName || member.userId}
                              imageUrl={member.avatarUrl}
                            />
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

        {/* User panel: Discord-style bottom bar */}
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
