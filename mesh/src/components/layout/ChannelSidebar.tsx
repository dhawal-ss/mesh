import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useActiveCommunity, useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { useVoiceStore } from '../../store/voice'
import { ChannelItem } from '../community/ChannelItem'
/*
    Imported directly rather than lazily, unlike every other community surface
    here. This one sits above the room list, so a chunk that arrives a frame
    later pushes the rooms down under whatever the pointer was already aiming at.
    It cost a room click in the preview suite before it cost anybody a misclick
    in the product. The sidebar itself is inside the lazy application shell
    chunk, so nothing about startup changes.
*/
import { CommunityChecklist } from '../community/CommunityChecklist'
import { UserPanel } from './UserPanel'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon } from '../ui/Icon'
import { Avatar } from '../ui/Avatar'
import * as bridge from '../../lib/bridge'
import { copyText, matrixRoomPermalink } from '../../lib/notifications'
import { showToast } from '../ui/Toast'
import type { Channel } from '../../types/ipc'
import { useMatrixRtcMembershipSync } from '../../hooks/useMatrixRtcMembershipSync'
import { shouldActivateVoiceSession, shouldExposeVoiceRoutes } from '../../lib/voice-runtime'
import { EmptyState, Field, SectionHeader, Textarea } from '../ui/Primitives'
import {
  CHANNEL_NAME_MAX_LENGTH,
  CHANNEL_TOPIC_MAX_LENGTH,
} from '../../lib/community-metadata-limits'
import { Button } from '../ui/Button'
import { Skeleton } from '../ui/Skeleton'
import { useVirtualScroll, type VirtualItem } from '../../hooks/useVirtualScroll'
import { IconButton } from '../ui/IconButton'
import { useMeshNavigationStore } from '../../store/navigation'
import { ModalLoadingFallback } from '../ui/ModalLoadingFallback'
import { Modal } from '../ui/Modal'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { useOnboardingChecklistStore } from '../../store/onboarding-checklist'
import { useOnboardingChecklist } from '../../hooks/useOnboardingChecklist'
import { useJoinCommunityRoom } from '../../hooks/useJoinCommunityRoom'
import type { OnboardingStepId } from '../../lib/onboarding-checklist'
import { useRoomOrganizationStore } from '../../store/room-organization'
import {
  applyManualOrder,
  applyPinned,
  bandPositions,
  hiddenGroupKey,
  isGroupCollapsed,
  textOrderScopeKey,
  voiceGroupKey,
  voiceOrderScopeKey,
} from '../../lib/room-organization'

/** Enough rows to read as a list, few enough to never outlast a real refresh. */
const ROOM_SKELETON_WIDTHS = ['74%', '58%', '86%', '64%'] as const
/** Stable empty-array reference so a scope with no pins never invalidates a memo. */
const EMPTY_ID_LIST: string[] = []

const InviteModal = lazy(() =>
  import('../community/InviteModal').then((module) => ({ default: module.InviteModal })),
)

type RoomListEntry =
  | {
      key: string
      kind: 'heading'
      roomType: 'text' | 'voice'
      label: string
      collapsed: boolean
      collapsible: boolean
      /** The local-organization group key this heading's collapse toggles, when collapsible. */
      groupKey?: string
    }
  | {
      key: string
      kind: 'room'
      channel: Channel
      /** Row belongs to the hidden-rooms tray rather than the main list. */
      hidden?: boolean
    }

export function ChannelSidebar() {
  const communityCount = useCommunityStore((state) => state.communityOrder.length)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const channels = useChannelStore((state) => state.channels)
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  /*
    Joining a room the community already admits this account to. A room created
    after this account arrived is listed with `joined: false`, and this is the
    only way it becomes readable. Opening the room afterwards is the point of the
    click, so the room list passes true; a voice room passes false, because
    joining a room is not consent to open a microphone.
  */
  const { joiningRoomId, joinRoom } = useJoinCommunityRoom()
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const dropChannel = useChannelStore((state) => state.removeChannel)
  /*
    Room settings, which used to be a rename-only modal.

    `m.room.topic` has been writable through `updateChannel` since it existed
    and no UI ever passed one, so every room's description was permanently
    empty and the conversation header filled that slot with a generated
    sentence instead. A rename dialog was the only post-creation room editing
    surface, so the description is added here rather than in a second one.
  */
  const [settingsTarget, setSettingsTarget] = useState<Channel | null>(null)
  const [roomNameValue, setRoomNameValue] = useState('')
  const [roomTopicValue, setRoomTopicValue] = useState('')
  const [removeTarget, setRemoveTarget] = useState<Channel | null>(null)
  const [roomActionBusy, setRoomActionBusy] = useState(false)
  const [roomActionError, setRoomActionError] = useState<unknown | null>(null)
  const activeRefresh = useChannelStore((state) => (
    activeCommunityId ? state.refreshByCommunity[activeCommunityId] : undefined
  ))
  const requestCommunityRefresh = useChannelStore((state) => state.requestCommunityRefresh)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)
  const currentCommunityId = useVoiceStore((state) => state.currentCommunityId)
  const setCurrentVoiceSession = useVoiceStore((state) => state.setCurrentVoiceSession)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const matrixRtcMembersByRoom = useVoiceStore((state) => state.matrixRtcMembersByRoom)
  const order = useRoomOrganizationStore((state) => state.order)
  const pinned = useRoomOrganizationStore((state) => state.pinned)
  const hidden = useRoomOrganizationStore((state) => state.hidden)
  const collapsedGroups = useRoomOrganizationStore((state) => state.collapsedGroups)
  const pinRoom = useRoomOrganizationStore((state) => state.pin)
  const unpinRoom = useRoomOrganizationStore((state) => state.unpin)
  const moveRoom = useRoomOrganizationStore((state) => state.move)
  const hideRoom = useRoomOrganizationStore((state) => state.hide)
  const unhideRoom = useRoomOrganizationStore((state) => state.unhide)
  const toggleGroupCollapsed = useRoomOrganizationStore((state) => state.toggleGroupCollapsed)
  const checklist = useOnboardingChecklist()
  const setChecklistCollapsed = useOnboardingChecklistStore((state) => state.setCollapsed)
  const hideChecklist = useOnboardingChecklistStore((state) => state.dismiss)
  const voiceCollapsed = activeCommunityId
    ? isGroupCollapsed(collapsedGroups, voiceGroupKey(activeCommunityId))
    : false
  const hiddenTrayCollapsed = activeCommunityId
    ? isGroupCollapsed(collapsedGroups, hiddenGroupKey(activeCommunityId), true)
    : true
  const [inviteOpen, setInviteOpen] = useState(false)
  const [roomFocus, setRoomFocus] = useState({
    activeChannelId,
    roomId: activeChannelId,
  })
  const typeaheadRef = useRef('')
  const typeaheadTimerRef = useRef<number | null>(null)
  const matrixMode = bridge.isMatrixBackend()
  const backendStatus = bridge.getBackendStatusSnapshot()
  const voiceRoutesEnabled = useMemo(
    () => shouldExposeVoiceRoutes(matrixMode, backendStatus),
    [backendStatus, matrixMode],
  )

  const activeCommunity = useActiveCommunity()
  const roomsUnavailable = activeRefresh?.status === 'failed' || activeRefresh?.status === 'stale'
  const canCreateRooms = activeCommunity?.role === 'owner' || activeCommunity?.role === 'admin'

  const submitRoomSettings = async () => {
    if (!settingsTarget) return
    const name = roomNameValue.trim()
    const topic = roomTopicValue.trim()
    const nameChanged = Boolean(name) && name !== settingsTarget.name
    const topicChanged = topic !== (settingsTarget.topic ?? '').trim()
    /*
      Only changed fields go on the wire. `update_channel` writes one state
      event per field it receives, so sending an unchanged description would
      publish an `m.room.topic` event that changes nothing, and every member's
      timeline would carry it.
    */
    if (!nameChanged && !topicChanged) {
      setSettingsTarget(null)
      return
    }
    setRoomActionBusy(true)
    setRoomActionError(null)
    try {
      const updated = await bridge.updateChannel(settingsTarget.communityId, settingsTarget.id, {
        ...(nameChanged ? { name } : {}),
        ...(topicChanged ? { topic } : {}),
      })
      patchChannel(settingsTarget.id, { name: updated.name, topic: updated.topic })
      showToast(
        nameChanged ? `Room saved as ${updated.name}.` : `Description saved for ${updated.name}.`,
        'success',
      )
      setSettingsTarget(null)
    } catch (error) {
      setRoomActionError(error)
    } finally {
      setRoomActionBusy(false)
    }
  }

  const submitRemove = async () => {
    if (!removeTarget) return
    setRoomActionBusy(true)
    setRoomActionError(null)
    try {
      await bridge.removeChannel(removeTarget.communityId, removeTarget.id)
      dropChannel(removeTarget.id)
      showToast(`${removeTarget.name} was removed from this community.`, 'success')
      setRemoveTarget(null)
    } catch (error) {
      setRoomActionError(error)
    } finally {
      setRoomActionBusy(false)
    }
  }
  const hiddenSet = useMemo(() => new Set(hidden), [hidden])
  const communityChannels = useMemo(
    () => channels.filter(
      (channel) => channel.communityId === activeCommunityId && !hiddenSet.has(channel.id),
    ),
    [activeCommunityId, channels, hiddenSet],
  )
  const hiddenCommunityChannels = useMemo(
    () => channels.filter(
      (channel) => channel.communityId === activeCommunityId && hiddenSet.has(channel.id),
    ),
    [activeCommunityId, channels, hiddenSet],
  )
  const textScopeKey = activeCommunityId ? textOrderScopeKey(activeCommunityId) : ''
  const voiceScopeKey = activeCommunityId ? voiceOrderScopeKey(activeCommunityId) : ''
  const textPinnedIds = pinned[textScopeKey] ?? EMPTY_ID_LIST
  const voicePinnedIds = pinned[voiceScopeKey] ?? EMPTY_ID_LIST
  const textChannels = useMemo(() => {
    const rawTextChannels = communityChannels.filter((channel) => channel.channelType === 'text')
    const ordered = applyManualOrder(rawTextChannels, (c) => c.id, order[textScopeKey])
    return applyPinned(ordered, (c) => c.id, textPinnedIds)
  }, [communityChannels, order, textPinnedIds, textScopeKey])
  const voiceChannels = useMemo(() => {
    if (!voiceRoutesEnabled) return []
    const rawVoiceChannels = communityChannels.filter((channel) => channel.channelType === 'voice')
    const ordered = applyManualOrder(rawVoiceChannels, (c) => c.id, order[voiceScopeKey])
    return applyPinned(ordered, (c) => c.id, voicePinnedIds)
  }, [communityChannels, order, voicePinnedIds, voiceRoutesEnabled, voiceScopeKey])
  const textBandPositions = useMemo(
    () => bandPositions(textChannels, (c) => c.id, textPinnedIds),
    [textChannels, textPinnedIds],
  )
  const voiceBandPositions = useMemo(
    () => bandPositions(voiceChannels, (c) => c.id, voicePinnedIds),
    [voiceChannels, voicePinnedIds],
  )
  const textOrderedIds = useMemo(() => textChannels.map((c) => c.id), [textChannels])
  const voiceOrderedIds = useMemo(() => voiceChannels.map((c) => c.id), [voiceChannels])
  const roomListEntries = useMemo<RoomListEntry[]>(() => {
    const entries: RoomListEntry[] = []
    const liveVoiceChannels = voiceChannels.filter((channel) => (
      (matrixRtcMembersByRoom[channel.id]?.length ?? 0) > 0
      || channel.id === currentChannelId
    ))
    const availableVoiceChannels = voiceChannels.filter(
      (channel) => !liveVoiceChannels.includes(channel),
    )
    if (liveVoiceChannels.length > 0) {
      entries.push({
        key: 'heading:live-now',
        kind: 'heading',
        roomType: 'voice',
        label: 'Live now',
        collapsed: false,
        collapsible: false,
      })
      for (const channel of liveVoiceChannels) {
        entries.push({ key: `room:${channel.id}`, kind: 'room', channel })
      }
    }
    if (availableVoiceChannels.length > 0) {
      entries.push({
        key: 'heading:voice',
        kind: 'heading',
        roomType: 'voice',
        label: 'Voice rooms',
        collapsed: voiceCollapsed,
        collapsible: true,
        groupKey: activeCommunityId ? voiceGroupKey(activeCommunityId) : undefined,
      })
      if (!voiceCollapsed) {
        for (const channel of availableVoiceChannels) {
          entries.push({ key: `room:${channel.id}`, kind: 'room', channel })
        }
      }
    }
    if (textChannels.length > 0) {
      entries.push({
        key: 'heading:rooms',
        kind: 'heading',
        roomType: 'text',
        label: 'Rooms',
        collapsed: false,
        collapsible: false,
      })
      for (const channel of textChannels) {
        entries.push({ key: `room:${channel.id}`, kind: 'room', channel })
      }
    }
    if (hiddenCommunityChannels.length > 0) {
      entries.push({
        key: 'heading:hidden',
        kind: 'heading',
        roomType: 'text',
        label: `${hiddenCommunityChannels.length} hidden room${hiddenCommunityChannels.length === 1 ? '' : 's'}`,
        collapsed: hiddenTrayCollapsed,
        collapsible: true,
        groupKey: activeCommunityId ? hiddenGroupKey(activeCommunityId) : undefined,
      })
      if (!hiddenTrayCollapsed) {
        for (const channel of hiddenCommunityChannels) {
          entries.push({ key: `hidden-room:${channel.id}`, kind: 'room', channel, hidden: true })
        }
      }
    }
    return entries
  }, [
    activeCommunityId,
    currentChannelId,
    hiddenCommunityChannels,
    hiddenTrayCollapsed,
    matrixRtcMembersByRoom,
    textChannels,
    voiceChannels,
    voiceCollapsed,
  ])
  /**
   * Local room-organization props for one row. A row in the hidden-rooms
   * tray only ever offers Unhide: pin/move act on a room's position among
   * its visible siblings, which a hidden row does not have.
   */
  const roomOrganizationProps = (channel: Channel, isHiddenRow: boolean) => {
    if (isHiddenRow) {
      return { isHidden: true as const, onUnhide: () => unhideRoom(channel.id) }
    }
    const isVoice = channel.channelType === 'voice'
    const scopeKey = isVoice ? voiceScopeKey : textScopeKey
    const pinnedIds = isVoice ? voicePinnedIds : textPinnedIds
    const orderedIds = isVoice ? voiceOrderedIds : textOrderedIds
    const position = (isVoice ? voiceBandPositions : textBandPositions).get(channel.id)
    return {
      isPinned: pinnedIds.includes(channel.id),
      onPin: () => pinRoom(scopeKey, channel.id),
      onUnpin: () => unpinRoom(scopeKey, channel.id),
      canMoveUp: !(position?.isFirstInBand ?? true),
      onMoveUp: () => moveRoom(scopeKey, channel.id, -1, orderedIds),
      canMoveDown: !(position?.isLastInBand ?? true),
      onMoveDown: () => moveRoom(scopeKey, channel.id, 1, orderedIds),
      onHide: () => hideRoom(channel.id),
    }
  }
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
  }, [activeCommunityId, hiddenTrayCollapsed, resetLayout, voiceCollapsed])

  const navigableRooms = useMemo(
    () => roomListEntries.flatMap((entry) => (
      entry.kind === 'room' && !entry.hidden ? [entry.channel] : []
    )),
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

  const markUnread = async (channel: Channel) => {
    patchChannel(channel.id, { unreadMarked: true })
    try {
      await bridge.setRoomUnreadFlag(channel.id, true)
    } catch {
      patchChannel(channel.id, { unreadMarked: false })
      showToast('Could not mark this room as unread. Try again.', 'error')
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

  const browseRooms = () => {
    const roomList = document.querySelector<HTMLElement>('#community-room-list')
    roomList?.focus({ preventScroll: true })
    roomList?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // The room menu asks for notifications, so it must land on notifications
  // rather than whichever settings section happens to open first.
  const openNotificationSettings = () => navigate({ kind: 'you', section: 'notifications' })

  const openMembers = () => {
    window.dispatchEvent(new CustomEvent('mesh:open-room-context', { detail: 'people' }))
  }

  /*
   * Hiding the list removes the control that was focused, so focus moves to the
   * room list rather than falling back to the document. The toast is the only
   * pointer to where the list went: appearance settings is a long way from the
   * sidebar, and a dismissed thing with no visible way back is a dead end.
   */
  const dismissChecklist = () => {
    hideChecklist()
    showToast('Getting started hidden. Turn it back on in Appearance settings.', 'info')
    window.requestAnimationFrame(() => {
      document.getElementById('community-room-list')?.focus()
    })
  }

  /*
   * A checklist step either opens the thing it names or it does nothing. The
   * room step uses the first room in the list as displayed, pins and manual
   * order included, so it lands on the same room a person would have clicked.
   */
  const runChecklistStep = (stepId: OnboardingStepId) => {
    if (stepId === 'picture') {
      navigate({ kind: 'you', section: 'profile' })
      return
    }
    if (stepId !== 'room') return
    // A room this account has not joined would answer "open a room" with a join
    // button, so the step skips to the first room it can actually open.
    const firstRoom = textChannels.find((candidate) => candidate.joined !== false)
    if (!firstRoom) return
    setActiveChannel(firstRoom.id)
    navigate({ kind: 'room', communityId: firstRoom.communityId, roomId: firstRoom.id })
  }

  if (!activeCommunity) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex h-conversation-header flex-shrink-0 items-center border-b border-outline-variant px-4">
          <h2 className="text-body-md font-semibold text-on-surface">Your communities</h2>
        </div>
        {/*
          The checklist mounts here as well as above the room list. It used to
          render only past the early return below, which needs an active
          community -- so "Join a community" was complete before the list could
          ever be seen, and the one step whose hint explains where to start was
          the one step nobody could be shown. This is the surface a person with
          no community is actually looking at.

          Only when there are no communities at all, which is exactly when that
          step is the suggested one. With communities present but none selected,
          the suggested step can be "Open the first room", whose action reads the
          active community's room list -- empty here, so the button would do
          nothing. Trading one dead end for another is not a fix.
        */}
        {checklist.active && communityCount === 0 && (
          <CommunityChecklist
            steps={checklist.steps}
            collapsed={checklist.collapsed}
            onToggleCollapsed={setChecklistCollapsed}
            onDismiss={dismissChecklist}
            onStepAction={runChecklistStep}
          />
        )}
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            variant="compact"
            icon={<Icon name={communityCount > 0 ? 'hash' : 'users'} size="lg" />}
            title={communityCount > 0 ? 'Choose a community' : 'Create or join a community'}
            description={
              communityCount > 0
                ? 'Select a community icon to view its rooms.'
                // Named by what the control says, not by where it sits. The
                // rail's plus is labelled "Join", so telling someone to use it
                // to create sent them to a button that does not offer that.
                : 'Join a community with an invite, or make one of your own.'
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
        <div className="mesh-community-header flex h-shell-header flex-shrink-0 items-center justify-between gap-2 border-b border-outline-variant px-3">
          <span className="mesh-community-identity min-w-0 flex-1">
            <span className="block truncate text-body-md font-semibold text-on-surface">
              {activeCommunity.name}
            </span>
            <span className="flex items-center gap-2 truncate text-label-sm text-on-surface-variant">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-round bg-primary" aria-hidden="true" />
                {activeCommunity.memberCount ?? 1} members
              </span>
            </span>
          </span>
          <IconButton
            size="sm"
            aria-label={`Open settings for ${activeCommunity.name}`}
            className="border border-outline-variant"
            onClick={() => navigate({
              kind: 'community-admin',
              communityId: activeCommunity.id,
              section: 'general',
            })}
          >
            <Icon name="ellipsis" size="sm" />
          </IconButton>
        </div>

        {/*
          Above the room list and outside its scroll container. The list is
          virtualized and measures its own rows, so a section inside it would be
          measured as a room.
        */}
        {checklist.active && (
          <CommunityChecklist
            steps={checklist.steps}
            collapsed={checklist.collapsed}
            onToggleCollapsed={setChecklistCollapsed}
            onDismiss={dismissChecklist}
            onStepAction={runChecklistStep}
          />
        )}

        {/* Room list */}
        <div
          id="community-room-list"
          ref={scrollContainerRef}
          onScroll={() => void handleScroll()}
          onKeyDown={handleRoomListKeyDown}
          className="mesh-room-list min-h-0 flex-1 overflow-y-auto py-3"
          role="navigation"
          aria-label="Community rooms"
          tabIndex={-1}
        >
          {roomsUnavailable && (
            <div
              role="alert"
              className="mb-2 rounded-full border border-marker-container-line bg-marker-container px-2 py-2 text-body-sm text-on-marker-container"
            >
              <p>
                {activeRefresh?.status === 'stale'
                  ? 'Rooms could not be refreshed. Showing the last update.'
                  : 'Rooms could not be loaded.'}
              </p>
              <button
                type="button"
                className="mt-1 min-h-8 rounded-full px-2 font-semibold text-primary hover:bg-state-hover"
                onClick={() => activeCommunityId && requestCommunityRefresh(activeCommunityId)}
              >
                Retry rooms
              </button>
            </div>
          )}
          <div
            className=""
            data-design-token-exception="data-driven-virtual-spacer-geometry"
            style={{
              paddingTop: `${topSpacerHeight}px`,
              paddingBottom: `${bottomSpacerHeight}px`,
            }}
          >
            {visibleRoomEntries.map((entry) => {
              if (entry.kind === 'heading') {
                const collapsed = entry.collapsed
                const headingSpacing = entry.roomType === 'voice' || entry.label !== 'Start here' ? 'pt-3' : ''
                return (
                  <MeasuredRoomRow
                    key={entry.key}
                    rowKey={entry.key}
                    onHeightChange={handleMeasuredHeight}
                  >
                    {entry.collapsible ? (
                      // A heading holds phrasing content, so the collapsible
                      // variant keeps the button and a span and matches
                      // SectionHeader's type by hand instead of nesting a div.
                      <h3 className={`px-5 ${headingSpacing}`}>
                        <button
                          onClick={() => entry.groupKey && toggleGroupCollapsed(entry.groupKey)}
                          className="group flex min-h-8 w-full items-center gap-0.5 text-left"
                          aria-expanded={!collapsed}
                        >
                          <span
                            aria-hidden="true"
                            className="mesh-disclosure-mark text-on-surface-variant"
                            data-collapsed={collapsed ? 'true' : 'false'}
                          />
                          <span className="text-label-sm font-medium text-on-surface-variant group-hover:text-on-surface">
                            {entry.label}
                          </span>
                        </button>
                      </h3>
                    ) : (
                      <SectionHeader
                        headingLevel={3}
                        title={entry.label}
                        className={`px-5 ${headingSpacing}`}
                      />
                    )}
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
                        onClick={() => {
                          if (channel.joined === false) {
                            void joinRoom(channel, true)
                            return
                          }
                          setActiveChannel(channel.id)
                          navigate({
                            kind: 'room',
                            communityId: channel.communityId,
                            roomId: channel.id,
                          })
                        }}
                        joining={joiningRoomId === channel.id}
                        onMarkRead={() => void markRead(channel)}
                        onMarkUnread={() => void markUnread(channel)}
                        onOpenNotificationSettings={openNotificationSettings}
                        onCopyLink={() => void copyChannelLink(channel)}
                        canManage={matrixMode && canCreateRooms}
                        onRename={() => {
                          setRoomNameValue(channel.name)
                          setRoomTopicValue(channel.topic ?? '')
                          setRoomActionError(null)
                          setSettingsTarget(channel)
                        }}
                        onRemove={() => {
                          setRoomActionError(null)
                          setRemoveTarget(channel)
                        }}
                        {...roomOrganizationProps(channel, Boolean(entry.hidden))}
                        tabIndex={focusedRoomId === channel.id ? 0 : -1}
                        onFocus={() => setRoomFocus({ activeChannelId, roomId: channel.id })}
                      />
                    </div>
                  </MeasuredRoomRow>
                )
              }

              const members = matrixRtcMembersByRoom[channel.id] ?? []
              const joinChannel = () => {
                /*
                  A voice room this account is not in joins the room and stops
                  there. Entering the call is a second, deliberate click,
                  because opening a microphone is not something a first click on
                  an unfamiliar room should be able to do.
                */
                if (channel.joined === false) {
                  void joinRoom(channel, false)
                  return
                }
                if (!voiceRoutesEnabled) return
                setActiveChannel(channel.id)
                if (shouldActivateVoiceSession(matrixMode, voiceRoutesEnabled)) {
                  setCurrentVoiceSession(activeCommunityId, channel.id)
                }
                navigate({
                  kind: 'voice',
                  communityId: channel.communityId,
                  roomId: channel.id,
                })
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
                      joining={joiningRoomId === channel.id}
                      onMarkRead={() => void markRead(channel)}
                      onMarkUnread={() => void markUnread(channel)}
                      onOpenNotificationSettings={openNotificationSettings}
                      onCopyLink={() => void copyChannelLink(channel)}
                      {...roomOrganizationProps(channel, Boolean(entry.hidden))}
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
                            className="flex min-h-6 w-full items-center gap-1.5 rounded-full px-1 py-0.5 text-left text-body-sm text-on-surface-variant hover:bg-state-hover hover:text-on-surface-variant"
                          >
                            <Avatar
                              color="var(--mark-azure-pale)"
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
                          <div className="member-count px-1 text-body-sm text-on-surface-variant">
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
          {/*
            A blank column reads as an empty community even while the first
            refresh is still running, and the main pane meanwhile asks for a
            room to be selected. Both states have to say which one this is.
          */}
          {roomListEntries.length === 0 && !roomsUnavailable && (
            activeRefresh?.status === 'loaded' ? (
              <EmptyState
                variant="compact"
                icon={<Icon name="hash" size="lg" />}
                title="No rooms yet"
                description="Rooms appear here as soon as they are created or finish arriving."
                action={canCreateRooms ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => navigate({
                      kind: 'community-admin',
                      communityId: activeCommunity.id,
                      section: 'rooms-voice',
                    })}
                  >
                    Create a room
                  </Button>
                ) : undefined}
              />
            ) : (
              <div className="space-y-1.5 px-1" role="status">
                <span className="sr-only">Loading rooms</span>
                {ROOM_SKELETON_WIDTHS.map((width) => (
                  <Skeleton key={width} width={width} height={24} />
                ))}
              </div>
            )
          )}
        </div>

        <div className="mesh-community-shortcuts grid grid-cols-3 gap-1 border-t border-outline-variant p-2">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={inviteOpen}
            onClick={() => setInviteOpen(true)}
            className="flex min-h-9 items-center justify-center gap-2 rounded-full text-body-sm font-medium text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface"
          >
            <Icon name="userPlus" size="sm" />
            Invite
          </button>
          <button
            type="button"
            onClick={browseRooms}
            className="flex min-h-9 items-center justify-center gap-2 rounded-full text-body-sm font-medium text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface"
          >
            <Icon name="search" size="sm" />
            Browse
          </button>
          <button
            type="button"
            onClick={openMembers}
            className="flex min-h-9 items-center justify-center gap-2 rounded-full text-body-sm font-medium text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface"
          >
            <Icon name="users" size="sm" />
            Members
          </button>
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
      {inviteOpen && (
        <Suspense
          fallback={(
            <ModalLoadingFallback
              title={`Invite to ${activeCommunity.name}`}
              label="Loading invitation options"
              size={matrixMode ? 'lg' : 'md'}
            />
          )}
        >
          <InviteModal
            isOpen
            onClose={() => setInviteOpen(false)}
            communityId={activeCommunity.id}
            communityName={activeCommunity.name}
          />
        </Suspense>
      )}

      <Modal
        open={settingsTarget !== null}
        onClose={() => {
          if (roomActionBusy) return
          setSettingsTarget(null)
          setRoomActionError(null)
        }}
        title={settingsTarget ? `${settingsTarget.name} settings` : 'Room settings'}
        description="Everyone in this community sees the name and description."
        size="sm"
      >
        <div className="space-y-3">
          {roomActionError != null ? (
            <ErrorState
              error={roomActionError}
              context={{ operation: 'save this room', resource: 'channel' }}
              compact
            />
          ) : null}
          <Input
            label="Room name"
            value={roomNameValue}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setRoomNameValue(event.target.value)}
            disabled={roomActionBusy}
            maxLength={CHANNEL_NAME_MAX_LENGTH}
          />
          <Field
            label="Description"
            htmlFor="room-settings-description"
          >
            <Textarea
              id="room-settings-description"
              value={roomTopicValue}
              onChange={(event) => setRoomTopicValue(event.target.value)}
              disabled={roomActionBusy}
              maxLength={CHANNEL_TOPIC_MAX_LENGTH}
              rows={2}
              className="min-h-16 resize-none"
              placeholder="What is this room for?"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setSettingsTarget(null)}
              disabled={roomActionBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitRoomSettings()}
              disabled={roomActionBusy || !roomNameValue.trim()}
            >
              {roomActionBusy ? 'Saving...' : 'Save room'}
            </Button>
          </div>
        </div>
      </Modal>

      {/*
        Removal is confirmed because it cannot be undone from here, and the copy
        states what Matrix actually does: the room is detached from the
        community and this account leaves it. Nothing deletes anyone else's
        copy, so the one consequence worth a line is that they keep theirs.
      */}
      <Modal
        open={removeTarget !== null}
        onClose={() => {
          if (roomActionBusy) return
          setRemoveTarget(null)
          setRoomActionError(null)
        }}
        title={removeTarget ? `Remove ${removeTarget.name}?` : 'Remove room'}
        description="The room leaves this community. People already in it keep their copy."
        size="sm"
      >
        <div className="space-y-3">
          {roomActionError != null ? (
            <ErrorState
              error={roomActionError}
              context={{ operation: 'remove this room', resource: 'channel' }}
              compact
            />
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setRemoveTarget(null)}
              disabled={roomActionBusy}
            >
              Keep room
            </Button>
            <Button
              tone="danger"
              onClick={() => void submitRemove()}
              disabled={roomActionBusy}
            >
              {roomActionBusy ? 'Removing...' : 'Remove room'}
            </Button>
          </div>
        </div>
      </Modal>
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
