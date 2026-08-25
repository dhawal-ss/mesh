import type { useCommunityStore } from '../store/communities'
import type { useMessageStore } from '../store/messages'
import type { useDmStore } from '../store/dms'
import { isRoomSilenced, type useSettingsStore } from '../store/settings'
import type { useChannelStore } from '../store/channels'
import type { MeshRecentDestination } from './mesh-navigation'
import type { Channel, DmConversation } from '../types/ipc'
import { dmPrimaryPeer } from '../types/ipc'
import { calloutsFirst } from './attention-ranking'

export interface ResolvedRecentRow {
  key: string
  route: MeshRecentDestination['route']
  title: string
  detail: string
  unreadCount: number
  unreadMentions: number
  /** The person's own explicit "mark as unread" marker, independent of unreadCount. */
  unreadMarked: boolean
  /** Deliberately muted, so it never competes for attention. */
  silenced: boolean
  /** Waiting rows have never been opened on this device and carry no open time. */
  lastOpenedAt: number | null
  /**
   * The same redacted activity summary that `detail` carries, without the
   * community prefix, so a surface can lead with what was said instead of what
   * the room is called. Computed inside the producers so it passes through
   * `safeActivitySummary` exactly once: never assemble this from raw message
   * content at the call site.
   *
   * Empty whenever there is no message to quote, including when notification
   * previews are off. A surface that sets this in display type must check it
   * and fall back to the destination name, which at least says where the row
   * goes; filler at that size outranks the name and says less than it does.
   */
  preview: string
  /** "room in community", the counterpart line when `preview` leads. Never empty. */
  source: string
}

/**
 * A text room holding unread work that this device has no navigation record of.
 * Returns null when the room is quiet. Home only borrows space for rooms that
 * are actually asking for something.
 */
export function resolveWaitingRoomRow(
  channel: Channel,
  communities: ReturnType<typeof useCommunityStore.getState>['communityEntities'],
  channelMessages: ReturnType<typeof useMessageStore.getState>['messages'],
  showMessageContent: boolean,
  notifications: ReturnType<typeof useSettingsStore.getState>['notifications'],
): ResolvedRecentRow | null {
  const unreadCount = channel.unreadCount ?? 0
  const unreadMentions = channel.unreadMentions ?? 0
  const unreadMarked = Boolean(channel.unreadMarked)
  if (unreadCount === 0 && unreadMentions === 0 && !unreadMarked) return null
  if (isRoomSilenced(notifications, channel.id, channel.communityId)) return null
  const community = communities[channel.communityId]
  if (!community) return null
  const roomMessages = channelMessages[channel.id] ?? []
  const latest = roomMessages[roomMessages.length - 1]
  const summary = safeActivitySummary(
    showMessageContent,
    unreadCount,
    latest?.content,
    latest?.authorDisplayName,
  )
  return {
    key: `room:${channel.id}`,
    route: { kind: 'room', communityId: channel.communityId, roomId: channel.id },
    title: channel.name,
    detail: detailLine(community.name, summary),
    preview: summary,
    source: `${channel.name} in ${community.name}`,
    unreadCount,
    unreadMentions,
    unreadMarked,
    silenced: false,
    lastOpenedAt: null,
  }
}

/** The direct-message counterpart of {@link resolveWaitingRoomRow}. */
export function resolveWaitingDirectRow(
  conversation: DmConversation,
  directMessages: ReturnType<typeof useDmStore.getState>['messages'],
  showMessageContent: boolean,
  notifications: ReturnType<typeof useSettingsStore.getState>['notifications'],
): ResolvedRecentRow | null {
  const unreadCount = conversation.unreadCount ?? 0
  const unreadMentions = conversation.unreadMentions ?? 0
  const unreadMarked = Boolean(conversation.unreadMarked)
  if (unreadCount === 0 && unreadMentions === 0 && !unreadMarked) return null
  if (isRoomSilenced(notifications, conversation.id)) return null
  const conversationMessages = directMessages[conversation.id] ?? []
  const latest = conversationMessages[conversationMessages.length - 1]
  const summary = safeActivitySummary(
    showMessageContent,
    unreadCount,
    latest?.content,
    latest?.authorDisplayName,
  )
  return {
    key: `direct:${conversation.id}`,
    route: { kind: 'direct', conversationId: conversation.id },
    title: dmPrimaryPeer(conversation).displayName || 'Unknown account',
    detail: summary,
    preview: summary,
    source: dmPrimaryPeer(conversation).displayName || 'Unknown account',
    unreadCount,
    unreadMentions,
    unreadMarked,
    silenced: false,
    lastOpenedAt: null,
  }
}

/**
 * Every text room and conversation carrying unread work, across the whole
 * account rather than just this device's navigation history. Unlike Home's
 * waiting rows, this does not stop at what has never been opened here: the
 * Inbox is the complete answer to "what is unread right now," so a room this
 * device visited yesterday and a room it has never opened both belong in it.
 * Mentions float to the top; everything else keeps a stable, arbitrary order.
 */
export function resolveInboxRows(
  channelEntities: ReturnType<typeof useChannelStore.getState>['channelEntities'],
  communities: ReturnType<typeof useCommunityStore.getState>['communityEntities'],
  channelMessages: ReturnType<typeof useMessageStore.getState>['messages'],
  conversationEntities: ReturnType<typeof useDmStore.getState>['conversationEntities'],
  directMessages: ReturnType<typeof useDmStore.getState>['messages'],
  showMessageContent: boolean,
  notifications: ReturnType<typeof useSettingsStore.getState>['notifications'],
): ResolvedRecentRow[] {
  const rows = [
    ...Object.values(channelEntities).flatMap((channel) => {
      if (channel.channelType !== 'text') return []
      const row = resolveWaitingRoomRow(channel, communities, channelMessages, showMessageContent, notifications)
      return row ? [row] : []
    }),
    ...Object.values(conversationEntities).flatMap((conversation) => {
      const row = resolveWaitingDirectRow(conversation, directMessages, showMessageContent, notifications)
      return row ? [row] : []
    }),
  ]
  return calloutsFirst(rows, (row) => row.silenced)
}

/**
 * The badges render as bare numerals, so the row's own name has to spell out
 * what each one counts.
 */
export function rowAccessibleName(row: {
  title: string
  detail: string
  unreadCount: number
  unreadMentions: number
  unreadMarked?: boolean
}): string {
  const parts = [row.title, row.detail].filter((part) => part.trim().length > 0)
  if (row.unreadMentions > 0) {
    parts.push(`${row.unreadMentions} ${row.unreadMentions === 1 ? 'mention' : 'mentions'}`)
  }
  if (row.unreadCount > 0) parts.push(`${row.unreadCount} unread`)
  if (row.unreadCount === 0 && row.unreadMentions === 0 && row.unreadMarked) {
    parts.push('marked unread')
  }
  return parts.join(', ')
}

export function safeActivitySummary(
  showMessageContent: boolean,
  unreadCount: number,
  content?: string,
  author?: string,
): string {
  /*
   * A message, or nothing.
   *
   * This used to fall back to "Something new" and "All caught up", and every
   * surface that prints it also prints the row's unread count as a numeral
   * beside it. "Something new" was that numeral said again in words, and "All
   * caught up" was its absence said in words; a list of twenty rows repeated
   * one or the other twenty times and distinguished none of them.
   *
   * Returning nothing is also the stricter reading of the privacy branch: with
   * previews off there is no permitted content, so the row says only how much
   * is waiting, which is what the count and `rowAccessibleName` are for.
   */
  if (unreadCount > 0 && !showMessageContent) return ''
  const summary = content?.replace(/\s+/g, ' ').trim()
  if (!summary) return ''
  const bounded = summary.slice(0, 120)
  return author ? `${author}: ${bounded}` : bounded
}

/** "Canyon Crew · Maya: Bring a headlamp", collapsing to whichever half exists. */
export function detailLine(...parts: string[]): string {
  return parts.filter((part) => part.trim().length > 0).join(' · ')
}
