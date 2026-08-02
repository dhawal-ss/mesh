import { useEffect, useCallback, useMemo, useState } from 'react'
import { useDmStore } from '../../store/dms'
import * as bridge from '../../lib/bridge'
import { format } from 'date-fns'
import { Avatar } from '../ui/Avatar'
import { UserPanel } from './UserPanel'
import { registerPoll } from '../../lib/scheduler'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { isQuietHoursActive, useSettingsStore } from '../../store/settings'
import { Icon } from '../ui/Icon'
import { useIdentityStore } from '../../store/identity'
import { EmptyState } from '../ui/Primitives'
import { useVirtualScroll, type VirtualItem } from '../../hooks/useVirtualScroll'
import { identityLabel } from '../../lib/notifications'

export function DmSidebar() {
  const conversations = useDmStore((state) => state.conversations)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const loadConversations = useDmStore((state) => state.loadConversations)
  const conversationLoad = useDmStore((state) => state.conversationLoad)
  const storedIdentity = useIdentityStore((state) => state.identity)
  const notifications = useSettingsStore((state) => state.notifications)
  const matrixMode = bridge.isMatrixBackend()
  const currentIdentityLabel = identityLabel(storedIdentity, matrixMode)
  const showUnreadBadges =
    notifications.enabled &&
    !notifications.doNotDisturb &&
    !isQuietHoursActive(notifications.quietHours)
  const [query, setQuery] = useState('')
  const filteredConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return conversations
    return conversations.filter((conversation) => {
      const name = conversation.peerDisplayName || conversation.peerPublicKey
      return name.toLocaleLowerCase().includes(normalizedQuery)
    })
  }, [conversations, query])
  const virtualItems = useMemo<VirtualItem[]>(() => filteredConversations.map((conversation) => ({
    key: conversation.id,
    type: 'message',
    height: 52,
  })), [filteredConversations])
  const {
    scrollContainerRef,
    topSpacerHeight,
    bottomSpacerHeight,
    visibleRange,
    handleScroll,
    resetLayout,
  } = useVirtualScroll(virtualItems, {
    estimatedMessageHeight: 52,
    overscanPx: 500,
  })
  const visibleConversations = useMemo(
    () => filteredConversations.length === 0
      ? []
      : filteredConversations.slice(visibleRange.start, visibleRange.end + 1),
    [filteredConversations, visibleRange.end, visibleRange.start],
  )

  useEffect(() => {
    resetLayout()
  }, [query, resetLayout])

  useEffect(() => {
    if (bridge.isMatrixBackend()) {
      let active = true
      const unregisterPoll = registerPoll({
        key: 'matrix-dm-conversations',
        intervalMs: 5_000,
        run: async () => {
          if (active) await loadConversations()
        },
        pauseWhenHidden: true,
        backoffOnError: true,
      })
      return () => {
        active = false
        unregisterPoll()
      }
    }
    void loadConversations().catch(() => {})
  }, [loadConversations])

  useEffect(() => {
    const unsub = bridge.onDmReceived((_msg) => {
      void loadConversations().catch(() => {})
    })
    return () => { unsub.then((fn) => fn()) }
  }, [loadConversations])

  const handleSelect = useCallback(async (conversationId: string) => {
    setActiveConversation(conversationId)
  }, [setActiveConversation])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex min-h-conversation-header flex-shrink-0 flex-col justify-center border-b border-border-subtle px-3 py-2">
        <h2 className="truncate text-sm font-semibold text-primary">Direct messages</h2>
        <p className="mt-1 truncate text-caption text-muted">
          Private conversations · {currentIdentityLabel}
        </p>
      </div>

      {/* Conversation search */}
      <div className="px-2 py-3">
        <label className="sr-only" htmlFor="dm-search">Find a conversation</label>
        <input
          id="dm-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a conversation"
          className="min-h-8 w-full rounded-control border border-border bg-surface-sunken px-2 text-xs text-primary outline-none placeholder:text-muted focus:border-accent"
        />
      </div>

      {/* Conversation list */}
      <div
        ref={scrollContainerRef}
        onScroll={() => void handleScroll()}
        className="flex-1 overflow-y-auto px-2"
        role="list"
        aria-label="Direct message conversations"
      >
        {(conversationLoad.status === 'idle' || conversationLoad.status === 'loading')
        && conversations.length === 0 ? (
          <div role="status" className="px-2 py-4 text-center text-xs text-muted">
            Loading conversations...
          </div>
        ) : conversationLoad.status === 'failed' && conversations.length === 0 ? (
          <div
            role="alert"
            className="rounded-control border border-status-warning/30 bg-status-warning/10 px-3 py-3 text-xs text-secondary"
          >
            <p>Conversations could not be loaded.</p>
            <button
              type="button"
              className="mt-2 min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
              onClick={() => void loadConversations().catch(() => {})}
            >
              Retry conversations
            </button>
          </div>
        ) : filteredConversations.length === 0 ? (
          <EmptyState
            variant="compact"
            icon={<Icon name={conversations.length === 0 ? 'messageCircle' : 'search'} size="lg" />}
            title={conversations.length === 0 ? 'No conversations yet' : 'No conversations found'}
            description={
              conversations.length === 0
                ? 'Open People in any room to start a private conversation.'
                : 'Try another name, or a full address like @ashvin:example.org.'
            }
          />
        ) : (
          <div
            className="space-y-0.5"
            data-design-token-exception="data-driven-virtual-spacer-geometry"
            style={{
              paddingTop: `${topSpacerHeight}px`,
              paddingBottom: `${bottomSpacerHeight}px`,
            }}
          >
            {visibleConversations.map((conv) => {
              const isActive = conv.id === activeConversationId
              const shortName = conv.peerDisplayName || conv.peerPublicKey.slice(0, 8)

              return (
                <div key={conv.id} role="listitem">
                  <button
                    onClick={() => void handleSelect(conv.id)}
                    className={`group flex w-full items-center gap-3 rounded px-2 py-density-row text-left transition-colors ${
                      isActive
                        ? 'mesh-channel-active bg-surface-selected text-primary'
                        : 'text-muted hover:bg-surface-hover hover:text-secondary'
                    }`}
                    aria-label={`Direct message with ${shortName}`}
                  >
                    <Avatar
                      color={conv.peerAvatarColor}
                      size={32}
                      name={shortName}
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{shortName}</span>
                        {conv.lastMessageAt && (
                          <span className="tnum ml-auto flex-shrink-0 text-meta text-muted">
                            {format(new Date(conv.lastMessageAt), 'MMM d')}
                          </span>
                        )}
                        {showUnreadBadges && conv.unreadCount > 0 && (
                          <span className="badge-count flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent px-1 text-meta font-semibold text-content-on-accent">
                            {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                          </span>
                        )}
                      </div>
                      {matrixMode && conv.peerPublicKey.startsWith('@') && (
                        <span className="identifier block truncate font-mono text-caption text-muted">
                          {conv.peerPublicKey}
                        </span>
                      )}
                    </div>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {conversationLoad.status === 'failed' && conversations.length > 0 && (
        <div
          role="alert"
          className="mx-2 mb-2 rounded-control border border-status-warning/30 bg-status-warning/10 px-2 py-2 text-xs text-secondary"
        >
          <span>Could not refresh conversations. Showing the last update.</span>{' '}
          <button
            type="button"
            className="min-h-8 rounded-control px-2 font-semibold text-text-link hover:bg-surface-hover"
            onClick={() => void loadConversations().catch(() => {})}
          >
            Retry
          </button>
        </div>
      )}
      <ScopedErrorBoundary
        name="User controls"
        description="Account controls could not be displayed."
        className="m-2"
      >
        <UserPanel />
      </ScopedErrorBoundary>
    </div>
  )
}
