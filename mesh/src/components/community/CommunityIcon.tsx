import type { Community } from '../../types/ipc'
import { useSettingsStore } from '../../store/settings'
import { Avatar } from '../ui/Avatar'
import { ContextMenu, type MenuItem } from '../ui/InteractivePrimitives'

const HOUR_MS = 60 * 60 * 1000

const MUTE_DURATIONS = [
  { id: 'mute-15m', label: 'Mute for 15 minutes', durationMs: 15 * 60 * 1000 },
  { id: 'mute-1h', label: 'Mute for 1 hour', durationMs: HOUR_MS },
  { id: 'mute-8h', label: 'Mute for 8 hours', durationMs: 8 * HOUR_MS },
  { id: 'mute-24h', label: 'Mute for 24 hours', durationMs: 24 * HOUR_MS },
  { id: 'mute-until-enabled', label: 'Mute until turned back on', durationMs: null },
] as const

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
    : MUTE_DURATIONS.map(({ id, label, durationMs }) => ({
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
    <div className="relative flex items-center justify-center">
      {/* Left pill indicator */}
      <div
        className={`absolute -left-community-marker w-community-marker rounded-r-full bg-primary transition-all duration-normal ${
          active
            ? 'h-10'
            : 'h-0 group-hover:h-5'
        }`}
      />
      <ContextMenu
        label={`Actions for ${community.name}`}
        items={menuItems}
      >
        <button
          type="button"
          onClick={onClick}
          aria-label={`${community.name}${hasUnread ? `, ${unreadCount} unread` : ''}${isMuted ? ', muted' : ''}`}
          aria-current={active ? 'true' : undefined}
          className={`group relative flex h-12 w-12 items-center justify-center overflow-hidden transition-all duration-normal ${
            active
              ? 'rounded-community-active bg-accent'
              : 'rounded-community bg-bg-primary hover:rounded-community-active hover:bg-accent'
          }`}
        >
          <Avatar
            color={active ? 'var(--accent)' : 'var(--avatar-blue)'}
            size={48}
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
          className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-bg-tertiary bg-status-danger"
        />
      )}
    </div>
  )
}
