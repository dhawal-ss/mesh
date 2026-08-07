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
import { copyText } from '../../lib/notifications'
import { showToast } from '../ui/Toast'
import { lazy, Suspense, useState, type KeyboardEvent } from 'react'
import { ModalLoadingFallback } from '../ui/ModalLoadingFallback'
import {
  clearVolatileInviteLink,
  getVolatileInviteLink,
} from '../../lib/pending-invitation-runtime'
import { useCurrentMeshRoute, useMeshNavigationStore } from '../../store/navigation'

const CreateCommunityModal = lazy(() =>
  import('../community/CreateCommunityModal').then((module) => ({ default: module.CreateCommunityModal })),
)

export function CommunitySidebar() {
  const directMessagesAvailable = bridge.getBackendCapabilities().directMessages
  const communities = useCommunityStore((state) => state.communities)
  const channels = useChannelStore((state) => state.channels)
  const channelEntities = useChannelStore((state) => state.channelEntities)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const loadConversations = useDmStore((state) => state.loadConversations)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const route = useCurrentMeshRoute()
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const recents = useMeshNavigationStore((state) => state.recents)
  const serverModalOpen = useShellStore((state) => state.serverModalOpen)
  const serverModalTab = useShellStore((state) => state.serverModalTab)
  const closeServerModal = useShellStore((state) => state.closeServerModal)
  const setProfileOpen = useShellStore((state) => state.setProfileOpen)
  const notifications = useSettingsStore((state) => state.notifications)
  const activeRailKey = route.kind === 'home'
    ? 'home'
    : route.kind === 'direct'
      ? 'dms'
      : route.kind === 'community'
        || route.kind === 'room'
        || route.kind === 'voice'
        || route.kind === 'community-admin'
        ? `community:${route.communityId}`
        : route.kind === 'you'
          ? 'you'
          : route.kind === 'communities' && route.mode === 'browse'
            ? 'explore'
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
    let conversationId = activeConversationId
    if (!conversationId) {
      try {
        await loadConversations()
      } catch {
        showToast('Private conversations could not be loaded. Try again.', 'error')
        return
      }
      const dmState = useDmStore.getState()
      conversationId = dmState.activeConversationId ?? dmState.conversationOrder[0] ?? null
    }
    if (!conversationId) {
      showToast('No private conversations yet. Open a player from a room to start one.', 'info')
      return
    }
    setDmMode(true)
    setActiveConversation(conversationId)
    navigate({ kind: 'direct', conversationId })
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
      <div className="flex flex-col items-center gap-2 pb-2" onKeyDown={handleRailKeyDown}>
        <button
          type="button"
          className="mesh-pixel-brand mb-1 flex h-12 w-12 items-center justify-center text-accent"
          aria-label="Mesh Home"
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
          <div className="mx-auto my-1 h-rail-separator w-7 rounded-full bg-surface-active" />
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
              onClick={() => handleCommunityClick(c.id)}
              onMarkRead={() => void markCommunityRead(c.id)}
              onOpenNotificationSettings={() => setProfileOpen(true)}
              onCopyLink={() => void copyCommunityLink(c.id)}
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
          label="Find"
          accessibleLabel="Find a community"
          icon="compass"
          railActionKey="explore"
          tabIndex={focusedRailKey === 'explore' ? 0 : -1}
          onFocus={() => setRailFocusKey('explore')}
          onClick={() => {
            navigate({ kind: 'communities', mode: 'browse' })
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
        <Suspense fallback={<ModalLoadingFallback title="Communities" label="Loading community tools" />}>
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
  icon: 'home' | 'messageCircle' | 'plus' | 'compass' | 'settings'
  active?: boolean
  railActionKey: string
  tabIndex: number
  onFocus: () => void
  onClick: () => void
}) {
  return (
    <Tooltip content={accessibleLabel} side="right">
      <button
        type="button"
        onClick={onClick}
        onFocus={onFocus}
        tabIndex={tabIndex}
        data-mesh-rail-action={railActionKey}
        aria-label={accessibleLabel}
        aria-current={active ? 'page' : undefined}
        className={`mesh-rail-action group flex w-14 flex-col items-center gap-1 rounded-control py-1 text-meta transition-colors ${
          active ? 'text-accent' : 'text-muted hover:text-primary'
        }`}
      >
        <span
          className={`mesh-rail-action-icon flex h-10 w-10 items-center justify-center rounded-community border transition-all duration-normal ${
            active
              ? 'rounded-community-active border-accent/50 bg-accent/15 text-accent'
              : 'border-transparent bg-surface-sunken group-hover:rounded-community-active group-hover:border-border-subtle group-hover:bg-surface-hover'
          }`}
        >
          <Icon name={icon} size="md" />
        </span>
        <span className="sr-only">{label}</span>
      </button>
    </Tooltip>
  )
}
