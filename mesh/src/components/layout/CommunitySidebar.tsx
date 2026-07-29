import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { useShellStore } from '../../store/shell'
import { Tooltip } from '../ui/Tooltip'
import { CommunityIcon } from '../community/CommunityIcon'
import * as bridge from '../../lib/bridge'
import { Icon } from '../ui/Icon'
import {
  getEffectiveChannelNotificationLevel,
  isBackupReminderDue,
  useSettingsStore,
} from '../../store/settings'
import { useChannelStore } from '../../store/channels'
import { copyText, matrixRoomPermalink } from '../../lib/notifications'
import { showToast } from '../ui/Toast'
import { lazy, Suspense } from 'react'
import { ModalLoadingFallback } from '../ui/ModalLoadingFallback'

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
  const inviteDraft = useShellStore((state) => state.inviteDraft)
  const openServerModal = useShellStore((state) => state.openServerModal)
  const closeServerModal = useShellStore((state) => state.closeServerModal)
  const setProfileOpen = useShellStore((state) => state.setProfileOpen)
  const backupReminderDue = useSettingsStore((state) => isBackupReminderDue(state.backup))
  const notifications = useSettingsStore((state) => state.notifications)

  const copyCommunityLink = async (communityId: string) => {
    try {
      const link = bridge.isMatrixBackend()
        ? matrixRoomPermalink(communityId)
        : await bridge.generateInviteLink(communityId)
      await copyText(link)
      showToast('Community link copied.', 'success')
    } catch {
      showToast('Could not copy this community link.', 'error')
    }
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
      <div className="flex flex-col items-center gap-1.5 pb-2">
        {/* Server icons */}
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

        {/* Separator */}
        {communities.length > 0 && (
          <div className="mx-auto h-rail-separator w-6 rounded-full bg-surface-active" />
        )}

        <Tooltip content="Add a community" side="right">
          <button
            onClick={() => openServerModal('create')}
            className="group flex h-10 w-10 items-center justify-center rounded-community bg-surface-sunken text-accent transition-all duration-normal hover:rounded-community-active hover:bg-accent hover:text-content-on-accent"
            aria-label="Add a community"
          >
            <Icon name="plus" />
          </button>
        </Tooltip>

        <div className="mx-auto h-rail-separator w-6 rounded-full bg-surface-active" />

        {directMessagesAvailable ? <Tooltip content="Direct Messages" side="right">
          <button
            onClick={handleDmClick}
            className={`group relative flex h-10 w-10 items-center justify-center rounded-community transition-all duration-normal ${
              isDmMode
                ? 'rounded-community-active bg-accent text-content-on-accent'
                : 'bg-surface-sunken text-muted hover:rounded-community-active hover:bg-accent hover:text-content-on-accent'
            }`}
            aria-label="Direct Messages"
          >
            <Icon name="send" size="lg" />
            {isDmMode && (
              <div className="absolute -left-community-marker top-1/2 h-10 w-community-marker -translate-y-1/2 rounded-r-full bg-primary" />
            )}
          </button>
        </Tooltip> : null}

        <Tooltip content="Explore communities" side="right">
          <button
            onClick={() => openServerModal('discover')}
            className="group relative flex h-10 w-10 items-center justify-center rounded-community bg-surface-sunken text-muted transition-all duration-normal hover:rounded-community-active hover:bg-accent hover:text-content-on-accent"
            aria-label="Explore communities"
          >
            <Icon name="search" />
          </button>
        </Tooltip>

        <Tooltip content="Profile" side="right">
          <button
            onClick={() => setProfileOpen(true)}
            className="group relative flex h-10 w-10 items-center justify-center rounded-community bg-surface-sunken text-muted transition-all duration-normal hover:rounded-community-active hover:bg-accent hover:text-content-on-accent"
            aria-label="Profile"
          >
            <Icon name="users" />
            {backupReminderDue && (
              <span
                className="absolute right-0 top-0 h-3 w-3 rounded-full border-2 border-bg-tertiary bg-status-warning"
                aria-label="Message backup needs attention"
              />
            )}
          </button>
        </Tooltip>
      </div>

      {serverModalOpen && (
        <Suspense fallback={<ModalLoadingFallback title="Communities" label="Loading community tools" />}>
          <CreateCommunityModal
            isOpen={serverModalOpen}
            onClose={closeServerModal}
            initialTab={serverModalTab}
            initialInvite={inviteDraft}
          />
        </Suspense>
      )}
    </>
  )
}
