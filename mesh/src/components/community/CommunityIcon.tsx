import type { Community } from '../../types/ipc'
import { NOTIFICATION_MUTE_DURATIONS, useSettingsStore } from '../../store/settings'
import { Avatar } from '../ui/Avatar'
import { pixelColorForSeed } from '../ui/PixelMark'
import { Icon } from '../ui/Icon'
import { ContextMenu, DropdownMenu, type MenuItem } from '../ui/InteractivePrimitives'

export interface CommunityIconProps {
  community: Community
  active: boolean
  unreadCount?: number
  /**
   * Mentions only, kept apart from `unreadCount`. The short stub at the rail
   * edge already says "unread", so the dot repeated it. Carrying a number here
   * gives the dot its own job and its own reason to look.
   */
  mentionCount?: number
  /** Somebody is in a voice room of this community right now. */
  liveVoice?: boolean
  onClick: () => void
  onMarkRead: () => void
  onOpenNotificationSettings: () => void
  onCopyLink: () => void
  /**
   * Local-only rail organization: pin to top, move within the rail. Omitted
   * from the menu entirely when `onPin` is absent. `canMoveUp`/`canMoveDown`
   * default true so the caller only needs to pass `false` at the edge of the
   * community's band.
   */
  isPinned?: boolean
  onPin?: () => void
  onUnpin?: () => void
  canMoveUp?: boolean
  onMoveUp?: () => void
  canMoveDown?: boolean
  onMoveDown?: () => void
  tabIndex?: number
  onFocus?: () => void
  railActionKey?: string
}

export function CommunityIcon({
  community,
  active,
  unreadCount = 0,
  mentionCount = 0,
  liveVoice = false,
  onClick,
  onMarkRead,
  onOpenNotificationSettings,
  onCopyLink,
  isPinned = false,
  onPin,
  onUnpin,
  canMoveUp = true,
  onMoveUp,
  canMoveDown = true,
  onMoveDown,
  tabIndex,
  onFocus,
  railActionKey,
}: CommunityIconProps) {
  const muteCommunityFor = useSettingsStore((state) => state.muteCommunityFor)
  const unmuteCommunity = useSettingsStore((state) => state.unmuteCommunity)
  const isMuted = useSettingsStore((state) => state.isCommunityMuted(community.id))
  const hasMentions = mentionCount > 0 && !isMuted
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
  /*
    The community tier every room inherits unless it sets its own level.

    Notification choice used to exist only per room, plus a binary community
    mute, so wanting mentions-only across a 30-room community meant making the
    same decision 30 times and again for every room added later.

    "Nothing, including mentions" is spelled out because it is the thing Mesh
    does that Discord refuses to: a muted room there still badges for @everyone
    and @here, with no opt-out. Saying so is the only way anyone finds out.
  */
  const communityLevel = useSettingsStore(
    (state) => state.notifications.communityNotificationLevels[community.id] ?? 'all',
  )
  const setCommunityNotificationLevel = useSettingsStore(
    (state) => state.setCommunityNotificationLevel,
  )
  const levelItems: MenuItem[] = ([
    ['all', 'All messages'],
    ['mentions', 'Only mentions'],
    ['nothing', 'Nothing, including mentions'],
  ] as const).map(([level, label]) => ({
    id: `community-level-${level}`,
    label: `Every room: ${label}${communityLevel === level ? ' (selected)' : ''}`,
    onSelect: () => setCommunityNotificationLevel(community.id, level),
  }))

  const menuItems: MenuItem[] = [
    {
      id: 'mark-read',
      label: 'Mark community as read',
      disabled: unreadCount <= 0,
      onSelect: onMarkRead,
    },
    /*
      Local-only rail organization: pin/move never touch server membership,
      so they are safe for anyone. Omitted entirely when the rail has not
      wired it (see the prop doc on CommunityIconProps).
    */
    ...(onPin && onUnpin
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
    ...levelItems,
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
    <div className="mesh-rail-slot" data-rail-active={active ? 'true' : undefined}>
      {/*
        The stub steps aside for a mention badge. Both would be saying the same
        thing about the same rooms, and splitting the dot off from unread was
        the point: one marker, one reason to look.
      */}
      {hasUnread && !hasMentions && !active && (
        <span aria-hidden="true" className="mesh-rail-unread" />
      )}
      <div className="group relative flex items-center justify-center">
        <ContextMenu
          label={`Actions for ${community.name}`}
          items={menuItems}
        >
          <button
            type="button"
            onClick={onClick}
            onFocus={onFocus}
            /*
              Shift+F10 and the dedicated Menu key are how a keyboard opens a
              context menu. Without them, pin, reorder, mute, mark-as-read and
              copy-link were reachable only by right-clicking -- and rail
              reordering has no other route in the interface at all. The ellipsis
              trigger beside this button carries tabIndex={-1} on purpose, so the
              rail keeps one tab stop per community; this is what gives that one
              stop its menu.

              Dispatched as a real contextmenu event at the icon's own centre
              rather than by forcing the menu open: the menu positions itself
              from the pointer coordinates, so opening it without them would put
              it in the wrong place.
            */
            onKeyDown={(event) => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                clientX: bounds.left + bounds.width / 2,
                clientY: bounds.top + bounds.height / 2,
              }))
            }}
            tabIndex={tabIndex}
            data-mesh-rail-action={railActionKey}
            aria-label={`${community.name}${isPinned ? ', pinned' : ''}${hasMentions ? `, ${mentionCount} ${mentionCount === 1 ? 'mention' : 'mentions'}` : ''}${hasUnread ? `, ${unreadCount} unread` : ''}${liveVoice ? ', live voice' : ''}${isMuted ? ', muted' : ''}`}
            aria-current={active ? 'true' : undefined}
            /*
              The shape change is the selection cue, which is what keeps the
              rail readable without colour: a circle at rest, a 16px tile when
              this is the community you are in. There is no border on either
              face -- a tonal ground and a radius say it without one.
            */
            className={`group relative flex h-12 w-12 items-center justify-center overflow-hidden transition-all duration-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
              active
                ? 'rounded-lg bg-primary'
                : 'rounded-round bg-surface-container-low hover:rounded-lg hover:bg-state-hover'
            }`}
          >
            <Avatar
              color={active ? 'var(--primary)' : pixelColorForSeed(community.id)}
              seed={community.id}
              size={48}
              name={community.name}
              imageUrl={community.avatarUrl}
              variant="community"
            />
          </button>
        </ContextMenu>
        {hasMentions && !active && (
          <span
            data-rail-mention
            aria-hidden="true"
            className="mesh-status-badge absolute -bottom-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 text-label-sm text-on-error"
          >
            {mentionCount > 99 ? '99+' : mentionCount}
          </span>
        )}
        {/*
          Live voice sits along the bottom edge of the tile, where nothing else
          does: selection and unread own the left edge, mentions own the bottom
          right corner. Position is what separates the four, so the rail still
          reads in greyscale and in high contrast, where status colour flattens.
          An accessible name is not a substitute for a cue a sighted reader can
          see.
        */}
        {liveVoice && (
          <span
            data-rail-live
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-1 right-1 h-0.5 bg-primary"
          />
        )}
        <DropdownMenu
          label={`Actions for ${community.name}`}
          items={menuItems}
          trigger={(
            <button
              type="button"
              tabIndex={-1}
              className="absolute -right-1 -top-1 z-sticky flex h-6 w-6 items-center justify-center rounded-full border border-outline bg-surface-container-high text-on-surface-variant opacity-0 transition-opacity hover:text-on-surface group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              aria-label={`More actions for ${community.name}`}
            >
              <Icon name="ellipsis" size="xs" />
            </button>
          )}
        />
      </div>
    </div>
  )
}
