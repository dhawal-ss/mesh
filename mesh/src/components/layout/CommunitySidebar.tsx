import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { useShellStore } from '../../store/shell'
import { Tooltip } from '../ui/Tooltip'
import { CommunityIcon } from '../community/CommunityIcon'
import * as bridge from '../../lib/bridge'
import { Icon } from '../ui/Icon'
import { PixelMark } from '../ui/PixelMark'
import { getEffectiveChannelNotificationLevel, useSettingsStore } from '../../store/settings'
import { useChannelStore } from '../../store/channels'
import { useVoiceStore } from '../../store/voice'
import { copyText } from '../../lib/notifications'
import { showToast } from '../ui/Toast'
import { lazy, Suspense, useMemo, useState, type KeyboardEvent } from 'react'
import { ModalLoadingFallback } from '../ui/ModalLoadingFallback'
import {
  clearVolatileInviteLink,
  getVolatileInviteLink,
} from '../../lib/pending-invitation-runtime'
import { useCurrentMeshRoute, useMeshNavigationStore } from '../../store/navigation'
import { useRoomOrganizationStore } from '../../store/room-organization'
import { applyManualOrder, applyPinned, bandPositions, RAIL_ORDER_SCOPE_KEY } from '../../lib/room-organization'

const CreateCommunityModal = lazy(() =>
  import('../community/CreateCommunityModal').then((module) => ({ default: module.CreateCommunityModal })),
)

/** Stable empty-array reference so an empty scope never invalidates a memo. */
const EMPTY_ID_LIST: string[] = []

export function CommunitySidebar() {
  const directMessagesAvailable = bridge.getBackendCapabilities().directMessages
  const rawCommunities = useCommunityStore((state) => state.communities)
  const channels = useChannelStore((state) => state.channels)
  const channelEntities = useChannelStore((state) => state.channelEntities)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const loadConversations = useDmStore((state) => state.loadConversations)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const route = useCurrentMeshRoute()
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const recents = useMeshNavigationStore((state) => state.recents)
  const serverModalOpen = useShellStore((state) => state.serverModalOpen)
  const serverModalTab = useShellStore((state) => state.serverModalTab)
  const closeServerModal = useShellStore((state) => state.closeServerModal)
  const setProfileOpen = useShellStore((state) => state.setProfileOpen)
  const notifications = useSettingsStore((state) => state.notifications)
  const matrixRtcMembersByRoom = useVoiceStore((state) => state.matrixRtcMembersByRoom)
  const currentVoiceRoom = useVoiceStore((state) => state.currentChannelId)
  const voiceConnectionState = useVoiceStore((state) => state.connectionState)
  const railOrder = useRoomOrganizationStore((state) => state.order[RAIL_ORDER_SCOPE_KEY])
  const railPinnedIds = useRoomOrganizationStore(
    (state) => state.pinned[RAIL_ORDER_SCOPE_KEY] ?? EMPTY_ID_LIST,
  )
  const pinCommunity = useRoomOrganizationStore((state) => state.pin)
  const unpinCommunity = useRoomOrganizationStore((state) => state.unpin)
  const moveCommunity = useRoomOrganizationStore((state) => state.move)
  const communities = useMemo(() => {
    const ordered = applyManualOrder(rawCommunities, (c) => c.id, railOrder)
    return applyPinned(ordered, (c) => c.id, railPinnedIds)
  }, [rawCommunities, railOrder, railPinnedIds])
  const railBandPositions = useMemo(
    () => bandPositions(communities, (c) => c.id, railPinnedIds),
    [communities, railPinnedIds],
  )
  const activeRailKey = route.kind === 'home'
    ? 'home'
    : route.kind === 'inbox'
      ? 'inbox'
    : route.kind === 'direct'
      ? 'dms'
      : route.kind === 'community'
        || route.kind === 'room'
        || route.kind === 'voice'
        || route.kind === 'community-admin'
        ? `community:${route.communityId}`
        : route.kind === 'you'
          ? 'you'
          : 'join'
  const [railFocusKey, setRailFocusKey] = useState<string | null>(null)
  const focusedRailKey = railFocusKey ?? activeRailKey

  const handleRailKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = event.target instanceof HTMLElement
      ? event.target.closest<HTMLButtonElement>('button[data-mesh-rail-action]')
      : null
    if (!current) return
    const actions = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      'button[data-mesh-rail-action]',
    )].filter((action) => !action.disabled)
    const currentIndex = actions.indexOf(current)
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % actions.length
    else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + actions.length) % actions.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = actions.length - 1
    if (nextIndex === null || !actions[nextIndex]) return
    event.preventDefault()
    actions[nextIndex].focus()
  }

  const copyCommunityLink = async (communityId: string) => {
    try {
      const link = await bridge.generateInviteLink(communityId)
      await copyText(link)
      showToast('Community link copied.', 'success')
    } catch {
      showToast('Could not copy this community link.', 'error')
    }
  }

  const handleServerModalClose = () => {
    clearVolatileInviteLink()
    closeServerModal()
  }

  const markCommunityRead = async (communityId: string) => {
    const unreadChannels = channels.filter(
      (channel) => channel.communityId === communityId && (channel.unreadCount ?? 0) > 0,
    )
    for (const channel of unreadChannels) {
      patchChannel(channel.id, { unreadCount: 0, unreadMentions: 0 })
    }

    let failedIds: Set<string>
    try {
      failedIds = new Set(await bridge.markChannelsRead(unreadChannels.map((channel) => channel.id)))
    } catch {
      failedIds = new Set(unreadChannels.map((channel) => channel.id))
    }
    for (const channel of unreadChannels) {
      if (!failedIds.has(channel.id)) continue
      const current = useChannelStore.getState().channelEntities[channel.id]
      if ((current?.unreadCount ?? 0) !== 0 || (current?.unreadMentions ?? 0) !== 0) continue
      patchChannel(channel.id, {
        unreadCount: channel.unreadCount ?? 0,
        unreadMentions: channel.unreadMentions,
      })
    }
    if (failedIds.size > 0) {
      showToast('Some rooms could not be marked as read. Try again.', 'error')
    }
  }

  const handleDmClick = async () => {
    if (!directMessagesAvailable) return
    setDmMode(true)
    navigate({ kind: 'direct-list' })
    void loadConversations().catch(() => {})
  }

  const handleCommunityClick = (id: string) => {
    setDmMode(false)
    setActiveCommunity(id)
    const recent = recents.find((entry) => (
      (entry.route.kind === 'room' || entry.route.kind === 'voice')
      && entry.route.communityId === id
      && Boolean(channelEntities[entry.route.roomId])
    ))
    navigate(recent?.route ?? { kind: 'community', communityId: id })
  }

  return (
    <>
      <div className="flex w-full flex-col items-center gap-2 pb-2" onKeyDown={handleRailKeyDown}>
        <button
          type="button"
          className="mesh-pixel-brand mb-1 flex h-12 w-12 items-center justify-center"
          aria-label="Mesh home"
          tabIndex={-1}
          onClick={() => {
            setDmMode(false)
            navigate({ kind: 'home' })
          }}
        >
          <PixelMark variant="brand" className="h-12 w-12" />
        </button>

        <RailAction
          label="Home"
          icon="home"
          active={route.kind === 'home'}
          railActionKey="home"
          tabIndex={focusedRailKey === 'home' ? 0 : -1}
          onFocus={() => setRailFocusKey('home')}
          onClick={() => {
            setDmMode(false)
            navigate({ kind: 'home' })
          }}
        />

        <RailAction
          label="Inbox"
          accessibleLabel="Inbox: everything unread"
          icon="inbox"
          active={route.kind === 'inbox'}
          railActionKey="inbox"
          tabIndex={focusedRailKey === 'inbox' ? 0 : -1}
          onFocus={() => setRailFocusKey('inbox')}
          onClick={() => {
            setDmMode(false)
            navigate({ kind: 'inbox' })
          }}
        />

        {directMessagesAvailable ? (
          <RailAction
            label="DMs"
            accessibleLabel="Direct messages"
            icon="messageCircle"
            active={route.kind === 'direct'}
            railActionKey="dms"
            tabIndex={focusedRailKey === 'dms' ? 0 : -1}
            onFocus={() => setRailFocusKey('dms')}
            onClick={() => void handleDmClick()}
          />
        ) : null}

        {communities.length > 0 && (
          <div className="mx-auto my-1 h-rail-separator w-7 bg-surface-active" />
        )}

        {communities.map((c) => (
          <Tooltip key={c.id} content={c.name} side="right">
            <CommunityIcon
              community={c}
              active={
                c.id === activeCommunityId
                && ['community', 'room', 'voice', 'community-admin'].includes(route.kind)
              }
              unreadCount={channels.reduce((total, channel) => {
                if (channel.communityId !== c.id) return total
                if (
                  getEffectiveChannelNotificationLevel(
                    notifications,
                    channel.id,
                    channel.communityId,
                  ) === 'nothing'
                ) return total
                return total + Math.max(channel.unreadCount ?? 0, channel.unreadMentions ?? 0)
              }, 0)}
              /*
                Mentions are rolled up separately from unreads. Folding them
                together with Math.max above is what stopped a count ever
                reaching the tile, so the dot had nothing to say.
              */
              mentionCount={channels.reduce((total, channel) => {
                if (channel.communityId !== c.id) return total
                if (
                  getEffectiveChannelNotificationLevel(
                    notifications,
                    channel.id,
                    channel.communityId,
                  ) === 'nothing'
                ) return total
                return total + (channel.unreadMentions ?? 0)
              }, 0)}
              liveVoice={channels.some((channel) => (
                channel.communityId === c.id
                && channel.channelType === 'voice'
                && ((matrixRtcMembersByRoom[channel.id]?.length ?? 0) > 0
                  || (channel.id === currentVoiceRoom
                    && ['connected', 'reconnecting', 'degraded'].includes(voiceConnectionState)))
              ))}
              onClick={() => handleCommunityClick(c.id)}
              onMarkRead={() => void markCommunityRead(c.id)}
              onOpenNotificationSettings={() => setProfileOpen(true)}
              onCopyLink={() => void copyCommunityLink(c.id)}
              isPinned={railPinnedIds.includes(c.id)}
              onPin={() => pinCommunity(RAIL_ORDER_SCOPE_KEY, c.id)}
              onUnpin={() => unpinCommunity(RAIL_ORDER_SCOPE_KEY, c.id)}
              canMoveUp={!(railBandPositions.get(c.id)?.isFirstInBand ?? true)}
              onMoveUp={() => moveCommunity(
                RAIL_ORDER_SCOPE_KEY,
                c.id,
                -1,
                communities.map((community) => community.id),
              )}
              canMoveDown={!(railBandPositions.get(c.id)?.isLastInBand ?? true)}
              onMoveDown={() => moveCommunity(
                RAIL_ORDER_SCOPE_KEY,
                c.id,
                1,
                communities.map((community) => community.id),
              )}
              railActionKey={`community:${c.id}`}
              tabIndex={focusedRailKey === `community:${c.id}` ? 0 : -1}
              onFocus={() => setRailFocusKey(`community:${c.id}`)}
            />
          </Tooltip>
        ))}

        <RailAction
          label="Join"
          accessibleLabel="Join a community"
          icon="plus"
          railActionKey="join"
          tabIndex={focusedRailKey === 'join' ? 0 : -1}
          onFocus={() => setRailFocusKey('join')}
          onClick={() => {
            navigate({ kind: 'communities', mode: 'join' })
          }}
        />

        <RailAction
          label="You"
          accessibleLabel="You and settings"
          icon="settings"
          active={route.kind === 'you'}
          railActionKey="you"
          tabIndex={focusedRailKey === 'you' ? 0 : -1}
          onFocus={() => setRailFocusKey('you')}
          onClick={() => {
            navigate({ kind: 'you', section: 'profile' })
          }}
        />
      </div>

      {serverModalOpen && (
        <Suspense fallback={<ModalLoadingFallback title="Communities" label="Loading community tools" size="xl" />}>
          <CreateCommunityModal
            isOpen={serverModalOpen}
            onClose={handleServerModalClose}
            initialTab={serverModalTab}
            initialInvite={getVolatileInviteLink()}
          />
        </Suspense>
      )}
    </>
  )
}

function RailAction({
  label,
  accessibleLabel = label,
  icon,
  active = false,
  railActionKey,
  tabIndex,
  onFocus,
  onClick,
}: {
  label: string
  accessibleLabel?: string
  icon: 'home' | 'inbox' | 'messageCircle' | 'plus' | 'compass' | 'settings'
  active?: boolean
  railActionKey: string
  tabIndex: number
  onFocus: () => void
  onClick: () => void
}) {
  return (
    <div className="mesh-rail-slot" data-rail-active={active ? 'true' : undefined}>
      <Tooltip content={accessibleLabel} side="right">
        <button
          type="button"
          onClick={onClick}
          onFocus={onFocus}
          tabIndex={tabIndex}
          data-mesh-rail-action={railActionKey}
          aria-label={accessibleLabel}
          aria-current={active ? 'page' : undefined}
          className={`mesh-rail-action group flex h-12 w-12 flex-col items-center justify-center rounded-control text-meta transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
            active ? 'text-accent' : 'text-muted hover:text-primary'
          }`}
        >
          <span
            className={`mesh-rail-action-icon flex h-10 w-10 items-center justify-center rounded-community border transition-all duration-normal ${
              active
                ? 'rounded-community-active border-container-accent-line bg-container-accent text-on-container-accent'
                : 'border-transparent bg-surface-sunken group-hover:rounded-community-active group-hover:border-border-subtle group-hover:bg-surface-hover'
            }`}
          >
            <Icon name={icon} size="md" />
          </span>
          <span className="sr-only">{label}</span>
        </button>
      </Tooltip>
    </div>
  )
}
