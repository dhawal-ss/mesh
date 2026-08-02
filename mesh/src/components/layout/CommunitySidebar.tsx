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
import { lazy, Suspense } from 'react'
import { ModalLoadingFallback } from '../ui/ModalLoadingFallback'
import {
  clearVolatileInviteLink,
  getVolatileInviteLink,
} from '../../lib/pending-invitation-runtime'

const CreateCommunityModal = lazy(() =>
  import('../community/CreateCommunityModal').then((module) => ({ default: module.CreateCommunityModal })),
)

export function CommunitySidebar() {
  const directMessagesAvailable = bridge.getBackendCapabilities().directMessages
  const communities = useCommunityStore((state) => state.communities)
  const channels = useChannelStore((state) => state.channels)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const isDmMode = useDmStore((state) => state.isDmMode)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const serverModalOpen = useShellStore((state) => state.serverModalOpen)
  const serverModalTab = useShellStore((state) => state.serverModalTab)
  const openServerModal = useShellStore((state) => state.openServerModal)
  const closeServerModal = useShellStore((state) => state.closeServerModal)
  const setProfileOpen = useShellStore((state) => state.setProfileOpen)
  const notifications = useSettingsStore((state) => state.notifications)

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

    const results = await Promise.allSettled(
      unreadChannels.map((channel) => bridge.markChannelRead(channel.id)),
    )
    let failed = false
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return
      failed = true
      const channel = unreadChannels[index]
      patchChannel(channel.id, {
        unreadCount: channel.unreadCount ?? 0,
        unreadMentions: channel.unreadMentions,
      })
    })
    if (failed) {
      showToast('Some rooms could not be marked as read. Try again.', 'error')
    }
  }

  const handleDmClick = () => {
    if (!directMessagesAvailable) return
    setDmMode(!isDmMode)
  }

  const handleCommunityClick = (id: string) => {
    setDmMode(false)
    setActiveCommunity(id)
  }

  return (
    <>
      <div className="flex flex-col items-center gap-2 pb-2">
        <div
          className="mesh-pixel-brand mb-1 flex h-12 w-12 items-center justify-center text-accent"
          role="img"
          aria-label="Mesh"
        >
          <PixelMark variant="brand" className="h-12 w-12" />
        </div>

        <RailAction
          label="Home"
          icon="home"
          onClick={() => setDmMode(false)}
        />

        {directMessagesAvailable ? (
          <RailAction
            label="DMs"
            accessibleLabel="Direct messages"
            icon="messageCircle"
            active={isDmMode}
            onClick={handleDmClick}
          />
        ) : null}

        {communities.length > 0 && (
          <div className="mx-auto my-1 h-rail-separator w-7 rounded-full bg-surface-active" />
        )}

        {communities.map((c) => (
          <Tooltip key={c.id} content={c.name} side="right">
            <CommunityIcon
              community={c}
              active={c.id === activeCommunityId && !isDmMode}
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
            />
          </Tooltip>
        ))}

        <RailAction
          label="Join"
          accessibleLabel="Join a community"
          icon="plus"
          onClick={() => openServerModal('join')}
        />

        <RailAction
          label="Explore"
          accessibleLabel="Explore communities"
          icon="compass"
          onClick={() => openServerModal('discover')}
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
  onClick,
}: {
  label: string
  accessibleLabel?: string
  icon: 'home' | 'messageCircle' | 'plus' | 'compass'
  active?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip content={accessibleLabel} side="right">
      <button
        type="button"
        onClick={onClick}
        aria-label={accessibleLabel}
        aria-current={active ? 'page' : undefined}
        className={`group flex w-14 flex-col items-center gap-1 rounded-control py-1 text-meta transition-colors ${
          active ? 'text-accent' : 'text-muted hover:text-primary'
        }`}
      >
        <span
          className={`flex h-10 w-10 items-center justify-center rounded-community border transition-all duration-normal ${
            active
              ? 'rounded-community-active border-accent/50 bg-accent/15 text-accent'
              : 'border-transparent bg-surface-sunken group-hover:rounded-community-active group-hover:border-border-subtle group-hover:bg-surface-hover'
          }`}
        >
          <Icon name={icon} size="md" />
        </span>
        <span>{label}</span>
      </button>
    </Tooltip>
  )
}
