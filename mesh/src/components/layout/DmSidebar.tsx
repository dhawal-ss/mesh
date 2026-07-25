import { useEffect, useCallback, useMemo, useState } from 'react'
import { useDmStore } from '../../store/dms'
import * as bridge from '../../lib/bridge'
import { format } from 'date-fns'
import { Avatar } from '../ui/Avatar'
import { UserPanel } from './UserPanel'
import { registerPoll } from '../../lib/scheduler'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { isQuietHoursActive, useSettingsStore } from '../../store/settings'

export function DmSidebar() {
  const conversations = useDmStore((state) => state.conversations)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const loadConversations = useDmStore((state) => state.loadConversations)
  const setConversations = useDmStore((state) => state.setConversations)
  const patchConversation = useDmStore((state) => state.patchConversation)
  const notifications = useSettingsStore((state) => state.notifications)
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
      <div
        className="flex h-12 flex-shrink-0 items-center border-b border-border-subtle px-4 shadow-elevation-low"
        data-tauri-drag-region
      >
        <h2 className="text-sm font-semibold text-primary">Direct Messages</h2>
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
          className="w-full rounded bg-bg-tertiary px-2 py-1.5 text-xs text-primary outline-none placeholder:text-muted focus:ring-2 focus:ring-accent"
        />
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2">
        {filteredConversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-xs text-muted">
              {conversations.length === 0 ? 'No conversations yet' : 'No conversations found'}
            </p>
            {conversations.length === 0 && (
              <p className="text-xs text-muted mt-1">Start a DM from the member list</p>
            )}
          </div>
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
                      ? 'bg-bg-modifier-selected text-primary'
                      : 'text-muted hover:bg-bg-modifier-hover hover:text-secondary'
                  }`}
                  aria-label={`Direct message with ${shortName}`}
                >
                  <Avatar
                    color={conv.peerAvatarColor}
                    size={32}
                    name={shortName}
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="truncate text-sm font-medium">{shortName}</span>
                      {showUnreadBadges && conv.unreadCount > 0 && (
                        <span className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red px-1 text-meta font-semibold text-content-on-status">
                          {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                        </span>
                      )}
                    </div>
                    {conv.lastMessageAt && (
                      <span className="text-meta text-muted">
                        {format(new Date(conv.lastMessageAt), 'MMM d')}
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
