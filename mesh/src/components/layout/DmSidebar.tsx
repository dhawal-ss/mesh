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
import { useNetworkStore } from '../../store/network'
import { EmptyState } from '../ui/Primitives'

export function DmSidebar() {
  const conversations = useDmStore((state) => state.conversations)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const loadConversations = useDmStore((state) => state.loadConversations)
  const setConversations = useDmStore((state) => state.setConversations)
  const patchConversation = useDmStore((state) => state.patchConversation)
  const storedIdentity = useIdentityStore((state) => state.identity)
  const networkStatus = useNetworkStore((state) => state.status)
  const notifications = useSettingsStore((state) => state.notifications)
  const matrixMode = bridge.isMatrixBackend()
  const identityLabel = storedIdentity?.displayName || (matrixMode ? 'Mesh account' : 'Local identity')
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

  useEffect(() => {
    if (bridge.isMatrixBackend()) {
      let active = true
      const unregisterPoll = registerPoll({
        key: 'matrix-dm-conversations',
        intervalMs: 5_000,
        run: async () => {
          const conversations = await bridge.getDmConversations()
          if (active) setConversations(conversations)
        },
        pauseWhenHidden: true,
        backoffOnError: true,
      })
      return () => {
        active = false
        unregisterPoll()
      }
    }
    void loadConversations()
  }, [loadConversations, setConversations])

  useEffect(() => {
    const unsub = bridge.onDmReceived((_msg) => {
      void loadConversations()
    })
    return () => { unsub.then((fn) => fn()) }
  }, [loadConversations])

  const handleSelect = useCallback(async (conversationId: string) => {
    setActiveConversation(conversationId)
    await bridge.markDmRead(conversationId)
    patchConversation(conversationId, { unreadCount: 0 })
  }, [setActiveConversation, patchConversation])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex h-conversation-header flex-shrink-0 flex-col justify-center border-b border-border-subtle px-3" data-tauri-drag-region>
        <h2 className="truncate text-sm font-semibold text-primary">Direct messages</h2>
        <p className="mt-1 truncate text-caption text-muted">Private conversations</p>
        <p className="mt-0.5 truncate text-caption text-secondary">Identity · {identityLabel}</p>
        <p className="mt-1 flex items-center gap-1.5 text-caption text-muted">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              networkStatus.state === 'connected'
                ? 'bg-status-success'
                : networkStatus.state === 'connecting'
                  ? 'bg-status-warning'
                  : 'bg-status-warning'
            }`}
            aria-hidden="true"
          />
          {networkStatus.state === 'connected'
            ? 'Synced'
            : networkStatus.state === 'connecting'
              ? 'Syncing'
              : 'Offline'}
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
      <div className="flex-1 overflow-y-auto px-2">
        {filteredConversations.length === 0 ? (
          <EmptyState
            variant="compact"
            icon={<Icon name={conversations.length === 0 ? 'messageCircle' : 'search'} size="lg" />}
            title={conversations.length === 0 ? 'No conversations yet' : 'No conversations found'}
            description={
              conversations.length === 0
                ? 'Open People in any room to start a private conversation.'
                : 'Try another name or Matrix ID.'
            }
          />
        ) : (
          <div className="space-y-0.5">
            {filteredConversations.map((conv) => {
              const isActive = conv.id === activeConversationId
              const shortName = conv.peerDisplayName || conv.peerPublicKey.slice(0, 8)

              return (
                <button
                  key={conv.id}
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
              )
            })}
          </div>
        )}
      </div>
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
