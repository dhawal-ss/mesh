import type { Channel } from '../../types/ipc'
import {
  getEffectiveChannelNotificationLevel,
  useSettingsStore,
} from '../../store/settings'
import { Icon } from '../ui/Icon'
import { ContextMenu, type MenuItem } from '../ui/InteractivePrimitives'

const MINUTE_MS = 60 * 1000

const MUTE_DURATIONS = [
  { id: 'mute-15m', label: 'Mute for 15 minutes', durationMs: 15 * MINUTE_MS },
  { id: 'mute-1h', label: 'Mute for 1 hour', durationMs: 60 * MINUTE_MS },
  { id: 'mute-8h', label: 'Mute for 8 hours', durationMs: 8 * 60 * MINUTE_MS },
  { id: 'mute-24h', label: 'Mute for 24 hours', durationMs: 24 * 60 * MINUTE_MS },
  { id: 'mute-until-enabled', label: 'Mute until turned back on', durationMs: null },
] as const

export interface ChannelItemProps {
  channel: Channel
  active: boolean
  onClick: () => void
  onMarkRead: () => void
  onOpenNotificationSettings: () => void
  onCopyLink: () => void
}

export function ChannelItem({
  channel,
  active,
  onClick,
  onMarkRead,
  onOpenNotificationSettings,
  onCopyLink,
}: ChannelItemProps) {
  const unreadCount = channel.unreadCount ?? 0
  const unreadMentions = channel.unreadMentions ?? 0
  const displayedUnreadCount = Math.max(unreadCount, unreadMentions)
  const hasStoredUnread = displayedUnreadCount > 0
  const muteChannelFor = useSettingsStore((state) => state.muteChannelFor)
  const unmuteChannel = useSettingsStore((state) => state.unmuteChannel)
  const isMuted = useSettingsStore((state) => state.isChannelMuted(channel.id))
  const notificationLevel = useSettingsStore(
    (state) => state.notifications.channelNotificationLevels[channel.id] ?? 'all',
  )
  const effectiveNotificationLevel = useSettingsStore((state) =>
    getEffectiveChannelNotificationLevel(
      state.notifications,
      channel.id,
      channel.communityId,
    ),
  )
  const setChannelNotificationLevel = useSettingsStore(
    (state) => state.setChannelNotificationLevel,
  )
  const hasUnread = hasStoredUnread && effectiveNotificationLevel !== 'nothing'
  const unreadLabel = unreadMentions > unreadCount
    ? `${unreadMentions} mentions`
    : `${unreadCount} unread`
  const muteItems: MenuItem[] = isMuted
    ? [{
        id: 'unmute',
        label: 'Turn notifications back on',
        onSelect: () => unmuteChannel(channel.id),
      }]
    : MUTE_DURATIONS.map(({ id, label, durationMs }) => ({
        id,
        label,
        onSelect: () => muteChannelFor(channel.id, durationMs),
      }))
  const menuItems: MenuItem[] = [
    {
      id: 'mark-read',
      label: 'Mark as read',
      disabled: !hasStoredUnread,
      onSelect: onMarkRead,
    },
    ...muteItems,
    {
      id: 'notifications-all',
      label: `Notifications: All messages${notificationLevel === 'all' ? ' (selected)' : ''}`,
      onSelect: () => setChannelNotificationLevel(channel.id, 'all'),
    },
    {
      id: 'notifications-mentions',
      label: `Notifications: Only @mentions${notificationLevel === 'mentions' ? ' (selected)' : ''}`,
      onSelect: () => setChannelNotificationLevel(channel.id, 'mentions'),
    },
    {
      id: 'notifications-nothing',
      label: `Notifications: Nothing${notificationLevel === 'nothing' ? ' (selected)' : ''}`,
      onSelect: () => setChannelNotificationLevel(channel.id, 'nothing'),
    },
    {
      id: 'notification-settings',
      label: 'Notification settings',
      onSelect: onOpenNotificationSettings,
    },
    {
      id: 'copy-link',
      label: 'Copy room link',
      onSelect: onCopyLink,
    },
  ]

  return (
    <ContextMenu
      label={`Actions for ${channel.name}`}
      items={menuItems}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={`${channel.channelType === 'text' ? 'Text' : 'Voice'} room: ${channel.name}${hasUnread ? `, ${unreadLabel}` : ''}${isMuted ? ', muted' : ''}`}
        aria-current={active ? 'page' : undefined}
        className={`group flex w-full items-center gap-1.5 rounded px-2 py-density-row text-left transition-colors duration-instant ${
          active
            ? 'mesh-channel-active bg-bg-modifier-selected text-primary'
            : hasUnread
              ? 'text-primary hover:bg-bg-modifier-hover'
              : 'text-muted hover:bg-bg-modifier-hover hover:text-secondary'
        }`}
      >
        {/* Channel type icon */}
        <Icon
          name={channel.channelType === 'text' ? 'hash' : 'volume'}
          className="flex-shrink-0 opacity-60"
        />

        <span className={`truncate text-sm ${active || hasUnread ? 'font-medium' : ''}`}>
          {channel.name}
        </span>

        {/* Unread badge */}
        {hasUnread && !active && (
          <span className="badge-count ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-status-danger px-1 text-meta font-semibold text-content-on-status">
            {displayedUnreadCount > 99 ? '99+' : displayedUnreadCount}
          </span>
        )}
      </button>
    </ContextMenu>
  )
}
