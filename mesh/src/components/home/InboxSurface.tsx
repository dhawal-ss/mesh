import { useMemo, useState } from 'react'
import * as bridge from '../../lib/bridge'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { useMessageStore } from '../../store/messages'
import { useMeshNavigationStore } from '../../store/navigation'
import { useSettingsStore } from '../../store/settings'
import { resolveInboxRows, rowAccessibleName, type ResolvedRecentRow } from '../../lib/inbox-rows'
import type { MeshRoute } from '../../lib/mesh-navigation'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { showToast } from '../ui/Toast'

/**
 * Everything unread across every community and direct message, in one place.
 * Unlike Home's "recent destinations," a row here exists only because it
 * currently carries unread work: reading it removes it from the list.
 */
export function InboxSurface() {
  const channelEntities = useChannelStore((state) => state.channelEntities)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const communities = useCommunityStore((state) => state.communityEntities)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const channelMessages = useMessageStore((state) => state.messages)
  const conversationEntities = useDmStore((state) => state.conversationEntities)
  const patchConversation = useDmStore((state) => state.patchConversation)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const directMessages = useDmStore((state) => state.messages)
  const notifications = useSettingsStore((state) => state.notifications)
  const showMessageContent = notifications.showMessageContent
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const [clearingAll, setClearingAll] = useState(false)

  const rows = useMemo(
    () => resolveInboxRows(
      channelEntities,
      communities,
      channelMessages,
      conversationEntities,
      directMessages,
      showMessageContent,
      notifications,
    ),
    [
      channelEntities,
      communities,
      channelMessages,
      conversationEntities,
      directMessages,
      showMessageContent,
      notifications,
    ],
  )

  const openRoute = (route: MeshRoute) => {
    if (route.kind === 'room') {
      setDmMode(false)
      setActiveCommunity(route.communityId)
      setActiveChannel(route.roomId)
    } else if (route.kind === 'direct') {
      setDmMode(true)
      setActiveConversation(route.conversationId)
    }
    navigate(route)
  }

  const markRowRead = async (row: ResolvedRecentRow) => {
    if (row.route.kind === 'direct') {
      const conversationId = row.route.conversationId
      const previous = { unreadCount: row.unreadCount, unreadMentions: row.unreadMentions, unreadMarked: row.unreadMarked }
      patchConversation(conversationId, { unreadCount: 0, unreadMentions: 0, unreadMarked: false })
      try {
        await bridge.markDmRead(conversationId)
      } catch {
        patchConversation(conversationId, previous)
        showToast('Could not mark this conversation as read. Try again.', 'error')
      }
      return
    }
    if (row.route.kind !== 'room') return
    const roomId = row.route.roomId
    const previous = { unreadCount: row.unreadCount, unreadMentions: row.unreadMentions, unreadMarked: row.unreadMarked }
    patchChannel(roomId, { unreadCount: 0, unreadMentions: 0, unreadMarked: false })
    try {
      await bridge.markChannelRead(roomId)
    } catch {
      patchChannel(roomId, previous)
      showToast('Could not mark this room as read. Try again.', 'error')
    }
  }

  const markAllRead = async () => {
    setClearingAll(true)
    try {
      const results = await Promise.allSettled(rows.map((row) => markRowRead(row)))
      if (results.some((result) => result.status === 'rejected')) {
        showToast('Some items could not be marked as read. Try again.', 'error')
      }
    } finally {
      setClearingAll(false)
    }
  }

  return (
    <section className="mesh-inbox-surface flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="mesh-inbox-heading">
      <header className="mesh-route-header mesh-inbox-header flex flex-shrink-0 items-center gap-3 border-b border-outline-variant px-5 py-2">
        <div className="min-w-0 flex-1">
          <p
            className="mesh-surface-kicker text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant"
            style={{ marginBottom: 1 }}
          >
            Attention
          </p>
          <h1
            id="mesh-inbox-heading"
            data-mesh-route-heading
            tabIndex={-1}
            className="text-title-lg font-semibold text-on-surface outline-none"
          >
            Inbox
          </h1>
        </div>
        {rows.length > 0 && (
          <Button variant="outline" size="sm" disabled={clearingAll} onClick={() => void markAllRead()}>
            <Icon name="check" size="sm" />
            Mark all as read
          </Button>
        )}
      </header>

      <div className="mesh-inbox-body min-h-0 flex-1 overflow-y-auto bg-surface">
        {rows.length === 0 ? (
          /*
            One line. The masthead used to say "Nothing unread." directly above
            this, and a third line under it explained what an inbox collects,
            which is a definition of the word at the top of the surface.
          */
          <div className="border-b border-outline-variant px-5 py-4">
            <p className="font-semibold text-on-surface-variant">You are caught up</p>
          </div>
        ) : rows.map((row) => (
          <div
            key={row.key}
            className="mesh-inbox-row flex w-full items-center gap-3 border-b border-outline-variant hover:bg-state-hover"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-5 text-left"
              onClick={() => openRoute(row.route)}
              aria-label={rowAccessibleName(row)}
            >
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center border border-outline-variant text-on-surface-variant">
                <Icon name={row.route.kind === 'direct' ? 'messageCircle' : 'hash'} size="md" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-on-surface">{row.title}</span>
                <span className="block truncate text-body-sm text-on-surface-variant">{row.detail}</span>
              </span>
              {/*
                Mentions and ordinary unreads stay separate indicators, and the
                mention badge carries an @ glyph, so neither the count nor the
                distinction depends on colour. This matches ChannelItem and Home.
              */}
              {row.unreadMentions > 0 && (
                <span className="text-body-sm font-semibold text-error">
                  <span aria-hidden="true">@</span>
                  {Math.min(row.unreadMentions, 999)}
                </span>
              )}
              {row.unreadCount > 0 && (
                <span className="text-body-sm text-primary">
                  {Math.min(row.unreadCount, 999)}
                </span>
              )}
              {row.unreadCount === 0 && row.unreadMentions === 0 && row.unreadMarked && (
                <span className="text-body-sm text-primary">Marked unread</span>
              )}
            </button>
            <button
              type="button"
              className="mr-5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
              aria-label={`Mark ${row.title} as read`}
              onClick={() => void markRowRead(row)}
            >
              <Icon name="check" size="sm" />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
