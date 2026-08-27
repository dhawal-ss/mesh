import type { Channel } from '../../types/ipc'
import {
  getEffectiveChannelNotificationLevel,
  NOTIFICATION_MUTE_DURATIONS,
  useSettingsStore,
} from '../../store/settings'
import { useHasFailedMessages } from '../../store/messages'
import { useDraftStore } from '../../store/drafts'
import { useRoomShapeStore } from '../../store/room-shape'
import { Icon } from '../ui/Icon'
import { ContextMenu, DropdownMenu, type MenuItem } from '../ui/InteractivePrimitives'
import { AnimatePresence, motion } from '../../lib/lazy-motion'
import { variants } from '../../lib/motion'
import { rowNumber } from '../ui/QuietStructure'

export interface ChannelItemProps {
  channel: Channel
  /**
   * Position in the rendered list, zero-based.
   *
   * The number in the gutter is positional, not an identifier: it renumbers
   * when the list reorders and is never persisted. It exists so a room has a
   * stable thing to point at in a sentence and a jump target in the palette,
   * which is why it is derived here rather than stored anywhere.
   */
  index: number
  matrixMode?: boolean
  active: boolean
  onClick: () => void
  onMarkRead: () => void
  onMarkUnread: () => void
  onOpenNotificationSettings: () => void
  onCopyLink: () => void
  /** Owners and administrators only: rooms are otherwise read-only here. */
  canManage?: boolean
  onRename?: () => void
  onRemove?: () => void
  /**
   * Local-only room organization: pin to top, move within the list, hide
   * from the sidebar. The whole section is omitted from the menu (rather
   * than shown disabled) when `onPin` is absent, which keeps this component
   * usable without room organization wired at all. `canMoveUp`/
   * `canMoveDown` default true so the caller only needs to pass `false` at
   * the edge of a room's band: Move up/down still shows, just disabled,
   * rather than a click that would silently do nothing.
   */
  isPinned?: boolean
  onPin?: () => void
  onUnpin?: () => void
  canMoveUp?: boolean
  onMoveUp?: () => void
  canMoveDown?: boolean
  onMoveDown?: () => void
  /** Row is rendered inside the hidden-rooms tray, not the main list. */
  isHidden?: boolean
  onHide?: () => void
  onUnhide?: () => void
  tabIndex?: number
  onFocus?: () => void
  /**
   * A join for this room is in flight. Only meaningful for a row whose channel
   * is not joined, and it suppresses a second join rather than queueing one.
   */
  joining?: boolean
}

export function ChannelItem({
  channel,
  index,
  matrixMode = false,
  active,
  onClick,
  onMarkRead,
  onMarkUnread,
  onOpenNotificationSettings,
  onCopyLink,
  canManage = false,
  onRename,
  onRemove,
  isPinned = false,
  onPin,
  onUnpin,
  canMoveUp = true,
  onMoveUp,
  canMoveDown = true,
  onMoveDown,
  isHidden = false,
  onHide,
  onUnhide,
  tabIndex = 0,
  onFocus,
  joining = false,
}: ChannelItemProps) {
  /*
    A room of this community that this account has not joined: it has no
    timeline, no unread count and nothing to mark read, so this row offers to
    join instead of to open. Read defensively for the same reason `topic` is:
    a record written before the field existed, or any faked IPC layer, described
    a room this account was in, and treating that as unjoined would replace a
    working room with a Join button.
  */
  const joined = channel.joined !== false
  const hasFailedMessages = useHasFailedMessages(channel.id)
  /*
    One expression, because two things depend on it: the marker itself and the
    `ml-auto` the badges must not also claim. A room you have not joined can
    still hold a draft -- leaving a room does not clear one -- so `joined`
    belongs here rather than on the marker alone, where the badges would lose
    their spacer to a marker that never rendered.
  */
  const roomShape = useRoomShapeStore((state) => state.shapes[channel.id] ?? 'conversation')
  const setRoomShape = useRoomShapeStore((state) => state.setShape)
  const hasDraft = useDraftStore(
    (state) => (state.drafts[channel.id] ?? '').trim().length > 0,
  ) && !active && joined
  const unreadCount = channel.unreadCount ?? 0
  const unreadMentions = channel.unreadMentions ?? 0
  const unreadMarked = Boolean(channel.unreadMarked)
  const displayedUnreadCount = Math.max(unreadCount, unreadMentions)
  const hasStoredUnread = displayedUnreadCount > 0 || unreadMarked
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
    unreadCount === 0 && unreadMentions === 0 && unreadMarked ? 'marked unread' : null,
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
  /*
    An unjoined room's menu carries only the two actions that mean anything
    before joining: take the link somewhere else, or keep the row out of the
    sidebar. Marking a room read, muting it, or renaming it all need membership
    this account does not have, and the backend refuses every one of them, so
    they are omitted rather than shown disabled: a disabled control explains a
    state you are in, and this is a room you are not in yet.
  */
  const unjoinedMenuItems: MenuItem[] = [
    {
      id: 'copy-link',
      label: 'Copy room link',
      onSelect: onCopyLink,
    },
    ...(isHidden && onUnhide
      ? [{ id: 'unhide', label: 'Show in sidebar', onSelect: onUnhide }]
      : []),
    ...(!isHidden && onHide
      ? [{ id: 'hide', label: 'Hide from sidebar', onSelect: onHide }]
      : []),
  ]
  const joinedMenuItems: MenuItem[] = [
    {
      id: 'mark-read',
      label: 'Mark as read',
      disabled: !hasStoredUnread,
      onSelect: onMarkRead,
    },
    {
      id: 'mark-unread',
      label: 'Mark as unread',
      disabled: hasStoredUnread,
      onSelect: onMarkUnread,
    },
    /*
      Local-only room organization: pin/move/hide never touch server
      membership or power levels, so they are safe for anyone, not just
      owners and administrators. Omitted entirely when the sidebar has not
      wired room organization (see the prop doc on ChannelItemProps). Pin and
      move are meaningless for a row already in the hidden tray, so only
      Unhide shows there.
    */
    ...(!isHidden && onPin && onUnpin
      ? [
          {
            id: 'pin',
            label: isPinned ? 'Unpin from top' : 'Pin to top',
            onSelect: isPinned ? onUnpin : onPin,
          },
          {
            id: 'move-up',
            label: 'Move up',
            disabled: !canMoveUp || !onMoveUp,
            onSelect: () => onMoveUp?.(),
          },
          {
            id: 'move-down',
            label: 'Move down',
            disabled: !canMoveDown || !onMoveDown,
            onSelect: () => onMoveDown?.(),
          },
        ]
      : []),
    ...(isHidden && onUnhide
      ? [{ id: 'unhide', label: 'Show in sidebar', onSelect: onUnhide }]
      : []),
    ...(!isHidden && onHide
      ? [{ id: 'hide', label: 'Hide from sidebar', onSelect: onHide }]
      : []),
    ...muteItems,
    {
      id: 'notifications-all',
      label: `Notifications: all messages${notificationLevel === 'all' ? ' (selected)' : ''}`,
      onSelect: () => setChannelNotificationLevel(channel.id, 'all'),
    },
    {
      id: 'notifications-mentions',
      label: `Notifications: only @mentions${notificationLevel === 'mentions' ? ' (selected)' : ''}`,
      onSelect: () => setChannelNotificationLevel(channel.id, 'mentions'),
    },
    {
      id: 'notifications-nothing',
      label: `Notifications: nothing${notificationLevel === 'nothing' ? ' (selected)' : ''}`,
      onSelect: () => setChannelNotificationLevel(channel.id, 'nothing'),
    },
    {
      id: 'notification-settings',
      label: 'Notification settings',
      onSelect: onOpenNotificationSettings,
    },
    /*
      How a room is read, on this device. A text room full of screenshots is a
      gallery whether or not the software knows it, and a room where somebody
      pinned a plan is an event whether or not the software knows it, so this
      only lets a person say so. It is not a room setting and needs no power
      level: nobody else's view of the room changes.

      Listed rather than toggled. Two shapes could be a single verb; three
      cannot, and a toggle that cycles gives no way to see what is on offer.
    */
    ...(channel.channelType === 'text'
      ? ([
          ['conversation', 'Read as a conversation'],
          ['clips', 'Read as clips'],
          ['event', 'Read as an event'],
        ] as const).map(([shape, label]) => ({
          id: `room-shape-${shape}`,
          label: `${label}${roomShape === shape ? ' (selected)' : ''}`,
          onSelect: () => setRoomShape(channel.id, shape),
        }))
      : []),
    {
      id: 'copy-link',
      label: 'Copy room link',
      onSelect: onCopyLink,
    },
    /*
      Community settings told administrators to manage each room from this menu
      while the menu carried no way to rename, re-topic or remove one, so a
      typo in a room name was permanent. These are the missing actions.
    */
    ...(canManage && onRename
      ? [{ id: 'rename', label: 'Rename room', onSelect: onRename }]
      : []),
    ...(canManage && onRemove
      ? [{ id: 'remove', label: 'Remove room', tone: 'danger' as const, onSelect: onRemove }]
      : []),
  ]
  const menuItems = joined ? joinedMenuItems : unjoinedMenuItems

  /*
    The trailing value, in one place.

    A mention outranks an unread count, an unread count outranks a marked-unread
    room, and a room with none of those shows nothing at all. The pill badge is
    gone: this is a zero-padded mono count at the accent, right-aligned, so a
    column of rooms reads as a column of numbers rather than a scatter of
    lozenges at different widths.
  */
  const trailingCount = hasMentions
    ? { value: unreadMentions > 99 ? '99+' : rowNumber(unreadMentions - 1), mention: true }
    : hasUnread && unreadCount > 0
      ? { value: unreadCount > 99 ? '99+' : rowNumber(unreadCount - 1), mention: false }
      : null

  return (
    <div className="group relative flex min-w-0 items-center">
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
        disabled={joining}
        aria-label={`${channel.channelType === 'text' ? 'Text' : 'Voice'} room: ${channel.name}${joined ? '' : joining ? ', joining' : ', not joined yet'}${isPinned ? ', pinned' : ''}${isHidden ? ', hidden' : ''}${hasUnread ? `, ${unreadLabel}` : ''}${isMuted ? ', muted' : ''}${hasDraft ? ', unsent draft' : ''}${hasFailedMessages ? ', a message could not be sent' : ''}`}
        aria-current={active ? 'page' : undefined}
        /*
          Active is a flat plane: square corners, full-bleed to both rules,
          near-black ink. It does not hover, because it is already a plane, and
          it carries aria-current above because a plane is a colour and a colour
          is never the only channel.
        */
        className={`mesh-channel-item flex min-h-shell-channel-row min-w-0 flex-1 items-center gap-1.5 rounded-full px-shell-gutter text-left transition-colors duration-instant ${
          active
            ? 'mesh-channel-active bg-primary text-on-primary'
            : hasUnread
              ? 'text-on-surface hover:bg-state-hover'
              : 'text-on-surface-variant hover:bg-state-hover hover:text-on-surface'
        }`}
      >
        <span
          aria-hidden="true"
          className={`w-row-index flex-none text-label-sm font-semibold transition-colors duration-instant ${
            active
              ? 'text-on-primary'
              : 'text-on-surface-variant group-hover:text-on-surface'
          }`}
        >
          {rowNumber(index)}
        </span>

        {/*
          The type glyph stays. The number says where a room is, not what it is,
          and text and voice rooms are otherwise distinguishable only by the
          accessible name.
        */}
        <Icon
          name={channel.channelType === 'text' ? 'hash' : 'volume'}
          size="xs"
          className="flex-shrink-0"
        />

        <span className={`truncate text-title-md ${active || hasUnread ? 'font-medium' : ''}`}>
          {channel.name}
        </span>

        {/*
          The word carries the state, not the dimmed row: an unjoined room and a
          quiet joined one are the same colour, and this is the only thing that
          separates them. It stays visible rather than appearing on hover, so a
          touch, a keyboard and a screenshot all show what the click will do.
        */}
        {!joined && (
          <span className="ml-auto flex-shrink-0 pl-1 text-body-sm text-on-surface-variant">
            {joining ? 'Joining' : 'Join'}
          </span>
        )}

        {/*
          A half-written message is state the list already knows about and has
          never shown. The room you are reading is excluded: the draft is on
          screen there, so naming it again would be noise.
        */}
        {hasDraft && (
          <span className="ml-auto flex-shrink-0 pl-1 text-body-sm text-on-surface-variant">
            Draft
          </span>
        )}

        {isPinned && (
          <Icon
            name="pin"
            size="xs"
            aria-hidden="true"
            className={`flex-shrink-0 ${active ? 'text-on-primary' : 'text-outline'}`}
          />
        )}

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
            className={`ml-auto flex-shrink-0 ${active ? 'text-on-primary' : 'text-outline'}`}
          />
        )}

        {/*
          A send that failed while the reader was in another room had no surface
          outside that room. This marker is deliberately not suppressed for a
          muted room: muting asks Mesh to stop announcing other people's
          messages, not to hide that your own message never left.
        */}
        {hasFailedMessages && (
          <Icon
            name="triangleAlert"
            size="xs"
            aria-hidden="true"
            className={`flex-shrink-0 text-error ${isMuted ? '' : 'ml-auto'}`}
          />
        )}

        {/*
          Mentions and ordinary unreads used to collapse into a single accent
          badge via Math.max, so sighted users got strictly less information
          than screen-reader users did. They are now separate indicators, and
          the mention badge carries an @ glyph so it does not rely on colour.

          Both counts also leave through the same 100ms collapse from their
          trailing edge. Marking a room read used to unmount the badge between
          two frames, which is the one moment in the room list worth
          acknowledging, and a count that vanishes without a trace leaves no
          evidence that the action did anything. The accessible name on the
          button carries the state itself, so the exiting badge is never
          announced and no reader waits for the animation.
        */}
        <AnimatePresence initial={false}>
          {trailingCount && !active && (
            <motion.span
              key="count"
              data-mention={trailingCount.mention ? 'true' : undefined}
              variants={variants.countBadge}
              initial="initial"
              animate="animate"
              exit="exit"
              className={`badge-count flex origin-right items-center gap-0.5 text-label-sm font-semibold ${
                trailingCount.mention ? 'text-error' : 'text-primary'
              } ${isMuted || hasDraft ? '' : 'ml-auto'}`}
            >
              {trailingCount.mention && <span aria-hidden="true">@</span>}
              {trailingCount.value}
            </motion.span>
          )}

          {/*
            A room explicitly marked unread carries no message or mention count
            to show, so the count above renders nothing. Without this it would
            look identical to a fully read room.
          */}
          {hasUnread && !active && unreadCount === 0 && unreadMentions === 0 && unreadMarked && (
            <motion.span
              key="marked-unread"
              data-unread-marker
              variants={variants.countBadge}
              initial="initial"
              animate="animate"
              exit="exit"
              aria-hidden="true"
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary ${isMuted || hasDraft ? '' : 'ml-auto'}`}
            />
          )}
        </AnimatePresence>
        </button>
      </ContextMenu>
      <DropdownMenu
        label={`Actions for ${channel.name}`}
        items={menuItems}
        trigger={(
          <button
            type="button"
            className={`absolute right-1 flex min-h-8 w-8 flex-none items-center justify-center rounded-full opacity-0 transition-opacity hover:bg-state-pressed group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
              active ? 'text-on-primary' : 'text-outline hover:text-on-surface'
            }`}
            aria-label={`More actions for ${channel.name}`}
          >
            <Icon name="ellipsis" size="sm" />
          </button>
        )}
      />
    </div>
  )
}
