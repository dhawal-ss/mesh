import { useEffect, useCallback } from 'react'
import { useDmStore } from '../../store/dms'
import * as bridge from '../../lib/bridge'
import { format } from 'date-fns'
import { Avatar } from '../ui/Avatar'

export function DmSidebar() {
  const { conversations, activeConversationId, setActiveConversation, loadConversations, patchConversation } = useDmStore()

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    const unsub = bridge.onDmReceived((_msg) => {
      loadConversations()
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
        className="flex h-12 flex-shrink-0 items-center border-b border-black/30 px-4 shadow-elevation-low"
        data-tauri-drag-region
      >
        <h2 className="text-sm font-semibold text-primary">Direct Messages</h2>
      </div>

      {/* Search placeholder */}
      <div className="px-2 py-3">
        <div className="rounded bg-bg-tertiary px-2 py-1.5 text-xs text-muted">
          Find or start a conversation
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-xs text-muted">No conversations yet</p>
            <p className="text-xs text-muted mt-1">Start a DM from the member list</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {conversations.map((conv) => {
              const isActive = conv.id === activeConversationId
              const shortName = conv.peerDisplayName || conv.peerPublicKey.slice(0, 8)

              return (
                <button
                  key={conv.id}
                  onClick={() => void handleSelect(conv.id)}
                  className={`group flex w-full items-center gap-3 rounded px-2 py-[6px] text-left transition-colors ${
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
                      {conv.unreadCount > 0 && (
                        <span className="ml-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red px-1 text-[11px] font-bold text-white">
                          {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                        </span>
                      )}
                    </div>
                    {conv.lastMessageAt && (
                      <span className="text-[11px] text-muted">
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
    </div>
  )
}
