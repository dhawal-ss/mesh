import type { Channel } from '../../types/ipc'
import {
  getEffectiveChannelNotificationLevel,
  NOTIFICATION_MUTE_DURATIONS,
  useSettingsStore,
} from '../../store/settings'
import { Icon } from '../ui/Icon'
import { ContextMenu, DropdownMenu, type MenuItem } from '../ui/InteractivePrimitives'

export interface ChannelItemProps {
  channel: Channel
  matrixMode?: boolean
  active: boolean
  onClick: () => void
  onMarkRead: () => void
  onOpenNotificationSettings: () => void
  onCopyLink: () => void
  tabIndex?: number
  onFocus?: () => void
}

export function ChannelItem({
  channel,
  matrixMode = false,
  active,
  onClick,
  onMarkRead,
  onOpenNotificationSettings,
  onCopyLink,
  tabIndex = 0,
  onFocus,
}: ChannelItemProps) {
  const unreadCount = channel.unreadCount ?? 0
  const unreadMentions = channel.unreadMentions ?? 0
  const displayedUnreadCount = Math.max(unreadCount, unreadMentions)
  const hasStoredUnread = displayedUnreadCount > 0
  const muteChannelFor = useSettingsStore((state) => state.muteChannelFor)
  const unmuteChannel = useSettingsStore((state) => state.unmuteChannel)
  const isLocallyMuted = useSettingsStore((state) => state.isChannelMuted(channel.id))
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
  const isMuted = matrixMode ? notificationLevel === 'nothing' : isLocallyMuted
  const hasUnread = hasStoredUnread && effectiveNotificationLevel !== 'nothing'
  const hasMentions = unreadMentions > 0 && effectiveNotificationLevel !== 'nothing'
  const unreadLabel = [
    unreadMentions > 0 ? `${unreadMentions} ${unreadMentions === 1 ? 'mention' : 'mentions'}` : null,
    unreadCount > 0 ? `${unreadCount} unread` : null,
  ].filter(Boolean).join(', ')
  const muteItems: MenuItem[] = matrixMode
    ? isMuted
      ? [{
          id: 'unmute',
          label: 'Turn notifications back on',
          onSelect: () => setChannelNotificationLevel(channel.id, 'all'),
        }]
      : [{
          id: 'mute',
          label: 'Mute notifications',
          onSelect: () => setChannelNotificationLevel(channel.id, 'nothing'),
        }]
    : isMuted
      ? [{
          id: 'unmute',
          label: 'Turn notifications back on',
          onSelect: () => unmuteChannel(channel.id),
        }]
      : NOTIFICATION_MUTE_DURATIONS.map(({ id, label, durationMs }) => ({
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
    <div className="group flex min-w-0 items-center gap-0.5">
      <ContextMenu
        label={`Actions for ${channel.name}`}
        items={menuItems}
      >
        <button
        type="button"
        data-room-id={channel.id}
        tabIndex={tabIndex}
        onFocus={onFocus}
        onClick={onClick}
        aria-label={`${channel.channelType === 'text' ? 'Text' : 'Voice'} room: ${channel.name}${hasUnread ? `, ${unreadLabel}` : ''}${isMuted ? ', muted' : ''}`}
        aria-current={active ? 'page' : undefined}
        className={`mesh-channel-item flex min-w-0 flex-1 items-center gap-1.5 rounded-control border px-2 py-density-row text-left transition-colors duration-instant ${
          active
            ? 'mesh-channel-active border-transparent bg-transparent text-accent'
            : hasUnread
              ? 'border-transparent text-primary hover:bg-surface-hover'
              : 'border-transparent text-muted hover:bg-surface-hover hover:text-secondary'
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

        {/*
          A muted room previously rendered identically to a read one, so there
          was no way to tell why a busy room showed no badge. The glyph carries
          the state independently of the dimmed text colour.
        */}
        {isMuted && (
          <Icon
            name="bellOff"
            size="xs"
            aria-hidden="true"
            className="ml-auto flex-shrink-0 text-content-muted opacity-70"
          />
        )}

        {/*
          Mentions and ordinary unreads used to collapse into a single accent
          badge via Math.max, so sighted users got strictly less information
          than screen-reader users did. They are now separate indicators, and
          the mention badge carries an @ glyph so it does not rely on colour.
        */}
        {hasMentions && !active && (
          <span className={`badge-count flex h-4 min-w-4 items-center justify-center gap-0.5 rounded-control bg-status-danger px-1 text-meta font-semibold text-content-on-status ${isMuted ? '' : 'ml-auto'}`}>
            <span aria-hidden="true">@</span>
            {unreadMentions > 99 ? '99+' : unreadMentions}
          </span>
        )}

        {/* Unread badge */}
        {hasUnread && !active && unreadCount > 0 && (
          <span className={`badge-count flex h-4 min-w-4 items-center justify-center rounded-control bg-accent px-1 text-meta font-semibold text-content-on-accent ${isMuted || hasMentions ? '' : 'ml-auto'}`}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
        </button>
      </ContextMenu>
      <DropdownMenu
        label={`Actions for ${channel.name}`}
        items={menuItems}
        trigger={(
          <button
            type="button"
            className="flex min-h-8 w-8 flex-none items-center justify-center rounded-control text-content-muted opacity-0 transition-opacity hover:bg-surface-hover hover:text-content group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            aria-label={`More actions for ${channel.name}`}
          >
            <Icon name="ellipsis" size="sm" />
          </button>
        )}
      />
    </div>
  )
}
