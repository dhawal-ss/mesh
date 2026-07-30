import type { Community } from '../../types/ipc'
import { NOTIFICATION_MUTE_DURATIONS, useSettingsStore } from '../../store/settings'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { ContextMenu, DropdownMenu, type MenuItem } from '../ui/InteractivePrimitives'

export interface CommunityIconProps {
  community: Community
  active: boolean
  unreadCount?: number
  onClick: () => void
  onMarkRead: () => void
  onOpenNotificationSettings: () => void
  onCopyLink: () => void
}

export function CommunityIcon({
  community,
  active,
  unreadCount = 0,
  onClick,
  onMarkRead,
  onOpenNotificationSettings,
  onCopyLink,
}: CommunityIconProps) {
  const muteCommunityFor = useSettingsStore((state) => state.muteCommunityFor)
  const unmuteCommunity = useSettingsStore((state) => state.unmuteCommunity)
  const isMuted = useSettingsStore((state) => state.isCommunityMuted(community.id))
  const hasUnread = unreadCount > 0 && !isMuted
  const muteItems: MenuItem[] = isMuted
    ? [{
        id: 'unmute',
        label: 'Turn notifications back on',
        onSelect: () => unmuteCommunity(community.id),
      }]
    : NOTIFICATION_MUTE_DURATIONS.map(({ id, label, durationMs }) => ({
        id,
        label,
        onSelect: () => muteCommunityFor(community.id, durationMs),
      }))
  const menuItems: MenuItem[] = [
    {
      id: 'mark-read',
      label: 'Mark community as read',
      disabled: unreadCount <= 0,
      onSelect: onMarkRead,
    },
    ...muteItems,
    {
      id: 'notification-settings',
      label: 'Notification settings',
      onSelect: onOpenNotificationSettings,
    },
    {
      id: 'copy-link',
      label: 'Copy community link',
      onSelect: onCopyLink,
    },
  ]

  return (
    <div className="group relative flex items-center justify-center">
      <ContextMenu
        label={`Actions for ${community.name}`}
        items={menuItems}
      >
        <button
          type="button"
          onClick={onClick}
          aria-label={`${community.name}${hasUnread ? `, ${unreadCount} unread` : ''}${isMuted ? ', muted' : ''}`}
          aria-current={active ? 'true' : undefined}
          className={`group relative flex h-10 w-10 items-center justify-center overflow-hidden transition-all duration-normal ${
            active
              ? 'rounded-community-active bg-accent'
              : 'rounded-community bg-surface-sunken hover:rounded-community-active hover:bg-accent'
          }`}
        >
          <Avatar
            color={active ? 'var(--accent)' : 'var(--avatar-blue)'}
            size={40}
            name={community.name}
            className="!rounded-none"
          />
          {/* Hover indicator for non-active */}
          {!active && (
            <div className="absolute -left-community-marker top-1/2 h-0 w-community-marker -translate-y-1/2 rounded-r-full bg-primary transition-all duration-normal group-hover:h-5" />
          )}
        </button>
      </ContextMenu>
      {hasUnread && !active && (
        <span
          aria-hidden="true"
          className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-bg-tertiary bg-accent"
        />
      )}
      <DropdownMenu
        label={`Actions for ${community.name}`}
        items={menuItems}
        trigger={(
          <button
            type="button"
            className="absolute -right-1 -top-1 z-sticky flex h-6 w-6 items-center justify-center rounded-full border border-border bg-surface-overlay text-content-muted opacity-0 transition-opacity hover:text-content group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            aria-label={`More actions for ${community.name}`}
          >
            <Icon name="ellipsis" size="xs" />
          </button>
        )}
      />
    </div>
  )
}
