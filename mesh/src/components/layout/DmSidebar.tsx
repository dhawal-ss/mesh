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
import { useMeshNavigationStore } from '../../store/navigation'
import { AsyncStatus } from '../ui/AsyncStatus'
import { Button } from '../ui/Button'

export const DM_CONVERSATION_ROW_HEIGHT = 64

export function DmSidebar() {
  const conversations = useDmStore((state) => state.conversations)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const messagesByConversation = useDmStore((state) => state.messages)
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
    height: DM_CONVERSATION_ROW_HEIGHT,
  })), [filteredConversations])
  const {
    scrollContainerRef,
    topSpacerHeight,
    bottomSpacerHeight,
    visibleRange,
    handleScroll,
    resetLayout,
  } = useVirtualScroll(virtualItems, {
    estimatedMessageHeight: DM_CONVERSATION_ROW_HEIGHT,
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
    setDmMode(true)
    setActiveConversation(conversationId)
    navigate({ kind: 'direct', conversationId })
  }, [navigate, setActiveConversation, setDmMode])

  const startConversation = useCallback(() => {
    setDmMode(false)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('mesh:open-room-context', { detail: 'people' }))
    }, 100)
  }, [setDmMode])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex min-h-conversation-header flex-shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
        <div className="min-w-0 flex-1">
        <h2 className="truncate text-base font-semibold tracking-tight text-primary">Messages</h2>
        <p className="mt-1 truncate text-caption text-muted">
          Private conversations · {currentIdentityLabel}
        </p>
        </div>
        <button
          type="button"
          aria-label="Start a private conversation"
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-control border border-border-subtle bg-surface-sunken text-muted transition-colors hover:border-border-emphasis hover:bg-surface-hover hover:text-primary"
          onClick={startConversation}
        >
          <Icon name="squarePen" size="sm" />
        </button>
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
          className="mesh-dm-search min-h-8 w-full rounded-control border border-border bg-surface-sunken px-2 text-xs text-primary outline-none placeholder:text-muted focus:border-accent"
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
          <AsyncStatus
            compact
            title="Bringing in your conversations"
            detail="You can keep using your current room while private conversations arrive."
          />
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
            title={conversations.length === 0 ? 'No direct messages yet' : 'No conversations found'}
            description={
              conversations.length === 0
                ? 'Start a private conversation when you need one.'
                : 'Try another name, or a full address like @ashvin:example.org.'
            }
            action={conversations.length === 0 ? (
              <Button size="sm" variant="secondary" onClick={startConversation}>
                New conversation
              </Button>
            ) : undefined}
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
              const conversationMessages = messagesByConversation[conv.id] ?? []
              const latestMessage = conversationMessages[conversationMessages.length - 1]

              return (
                <div key={conv.id} role="listitem">
                  <button
                    onClick={() => void handleSelect(conv.id)}
                    className={`mesh-dm-item group flex min-h-14 w-full items-center gap-3 rounded-control border px-2.5 py-2 text-left transition-colors ${
                      isActive
                        ? 'border-accent/30 bg-accent/10 text-primary'
                        : 'border-transparent text-muted hover:border-border-subtle hover:bg-surface-hover hover:text-secondary'
                    }`}
                    aria-label={`Direct message with ${shortName}`}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <Avatar
                      color={conv.peerAvatarColor}
                      size={40}
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
                      <span className="block truncate text-caption text-muted">
                        {latestMessage?.content || (matrixMode ? 'Private conversation' : 'Local conversation')}
                      </span>
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
