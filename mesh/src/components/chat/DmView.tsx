import { useState, useRef, useEffect, useCallback } from 'react'
import { useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { MessageInput } from './MessageInput'
import * as bridge from '../../lib/bridge'
import { format } from 'date-fns'

export function DmView() {
  const { activeConversationId, conversations, messages, loadMessages, addMessage } = useDmStore()
  const identity = useIdentityStore((s) => s.identity)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isLoading, setIsLoading] = useState(false)

  const conversation = conversations.find((c) => c.id === activeConversationId)
  const channelMessages = activeConversationId ? (messages[activeConversationId] ?? []) : []

  useEffect(() => {
    if (!activeConversationId) return
    setIsLoading(true)
    loadMessages(activeConversationId).finally(() => {
      setIsLoading(false)
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
    })
  }, [activeConversationId, loadMessages])

  useEffect(() => {
    const unsub = bridge.onDmReceived((msg) => {
      if (msg.conversationId === activeConversationId) {
        addMessage(msg)
        requestAnimationFrame(() => {
          const el = scrollRef.current
          if (el) el.scrollTop = el.scrollHeight
        })
      }
    })
    return () => { unsub.then((fn) => fn()) }
  }, [activeConversationId, addMessage])

  const handleSend = useCallback(async (content: string) => {
    if (!conversation) return
    try {
      const msg = await bridge.sendDm(conversation.peerPublicKey, content)
      addMessage(msg)
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
    } catch (err) {
      console.error('Failed to send DM:', err)
    }
  }, [conversation, addMessage])

  if (!activeConversationId || !conversation) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="rounded-[28px] border border-white/8 bg-surface/50 px-8 py-7 text-center shadow-pane backdrop-blur-xl">
          <p className="mb-1 text-sm text-secondary">Select a conversation</p>
          <p className="text-2xs text-muted">Choose a DM from the sidebar</p>
        </div>
      </div>
    )
  }

  const peerName = conversation.peerDisplayName || conversation.peerPublicKey.slice(0, 8)

  return (
    <div className="flex h-full flex-1 flex-col bg-white/[0.015]">
      {/* Header */}
      <div
        className="flex h-12 flex-shrink-0 items-center border-b border-white/8 px-4 backdrop-blur-xl"
        data-tauri-drag-region
      >
        <div
          className="mr-2 flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-bold text-white/90"
          style={{ backgroundColor: conversation.peerAvatarColor }}
        >
          {peerName[0]?.toUpperCase() ?? '?'}
        </div>
        <span className="text-sm font-medium text-primary">{peerName}</span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted">Loading messages...</p>
          </div>
        ) : channelMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="rounded-[28px] border border-white/8 bg-surface/50 px-8 py-7 text-center shadow-pane backdrop-blur-xl">
              <p className="mb-1 text-sm text-secondary">Start of conversation</p>
              <p className="text-2xs text-muted">Send a message to {peerName}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {channelMessages.map((msg, index) => {
              const prev = channelMessages[index - 1]
              const isGrouped = prev &&
                prev.authorPublicKey === msg.authorPublicKey &&
                new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime() < 5 * 60 * 1000

              const isOwnMessage = msg.authorPublicKey === identity?.publicKey

              return (
                <div
                  key={msg.id}
                  className={`px-4 ${!isGrouped ? 'pt-2' : 'pt-0.5'}`}
                >
                  {!isGrouped && (
                    <div className="mb-0.5 flex items-center gap-2">
                      <div
                        className="flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-bold text-white/90"
                        style={{ backgroundColor: msg.authorAvatarColor }}
                      >
                        {msg.authorDisplayName[0]?.toUpperCase() ?? '?'}
                      </div>
                      <span className={`text-xs font-medium ${isOwnMessage ? 'text-accent' : 'text-primary'}`}>
                        {isOwnMessage ? 'You' : msg.authorDisplayName}
                      </span>
                      <span className="font-mono text-2xs text-muted">
                        {format(new Date(msg.timestamp), 'HH:mm')}
                      </span>
                    </div>
                  )}
                  <div className={!isGrouped ? 'pl-8' : 'pl-8'}>
                    <p className="text-sm text-secondary whitespace-pre-wrap break-words">
                      {msg.content}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <MessageInput
        channelId={activeConversationId}
        channelName={peerName}
        onSend={handleSend}
        disableAttachments
      />
    </div>
  )
}
