import { create } from 'zustand'
import type { Message } from '../types/ipc'
import * as bridge from '../lib/bridge'

const HOT_WINDOW_SIZE = 200
const MAX_HISTORY_WINDOW_SIZE = 500

interface MessagesStore {
  messages: Record<string, Message[]>
  loadingOlder: Record<string, boolean>
  hasMoreOlder: Record<string, boolean>
  browsingOlder: Record<string, boolean>
  newerGapCount: Record<string, number>
  setMessages: (channelId: string, messages: Message[]) => void
  replaceMessages: (channelId: string, messages: Message[]) => void
  addMessage: (channelId: string, message: Message) => void
  prependMessages: (channelId: string, messages: Message[]) => void
  loadOlderMessages: (channelId: string) => Promise<void>
  updateReaction: (
    channelId: string,
    messageId: string,
    emoji: string,
    authorPublicKey: string,
    verb: 'add' | 'remove',
  ) => void
  editMessage: (channelId: string, messageId: string, content: string, editedAt: string) => void
  deleteMessage: (channelId: string, messageId: string) => void
  removeMessage: (channelId: string, messageId: string) => void
  setDeliveryStatus: (channelId: string, messageId: string, status: 'pending' | 'sent' | 'failed') => void
  removeMessagesByAuthor: (channelId: string, authorPublicKey: string) => void
  removeMessagesByAuthorAllChannels: (authorPublicKey: string) => void
}

function compareMessages(a: Message, b: Message) {
  const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  if (timeDiff !== 0) {
    return timeDiff
  }

  if (a.id === b.id) {
    return 0
  }

  return a.id < b.id ? -1 : 1
}

function mergeMessages(existing: Message[], incoming: Message[]) {
  const byId = new Map<string, Message>()

  for (const message of existing) {
    byId.set(message.id, message)
  }

  for (const message of incoming) {
    byId.set(message.id, message)
  }

  return [...byId.values()].sort(compareMessages)
}

function boundLatestWindow(messages: Message[]): Message[] {
  if (messages.length <= HOT_WINDOW_SIZE) return messages
  return messages.slice(-HOT_WINDOW_SIZE)
}

function boundOlderWindow(messages: Message[]): { messages: Message[]; trimmedNewerCount: number } {
  if (messages.length <= MAX_HISTORY_WINDOW_SIZE) {
    return { messages, trimmedNewerCount: 0 }
  }

  return {
    messages: messages.slice(0, MAX_HISTORY_WINDOW_SIZE),
    trimmedNewerCount: messages.length - MAX_HISTORY_WINDOW_SIZE,
  }
}

function applyReaction(
  messages: Message[],
  messageId: string,
  emoji: string,
  authorPublicKey: string,
  verb: 'add' | 'remove',
): Message[] {
  return messages.map((msg) => {
    if (msg.id !== messageId) return msg

    const reactions = { ...msg.reactions }
    const authors = [...(reactions[emoji] ?? [])]

    if (verb === 'add') {
      if (!authors.includes(authorPublicKey)) {
        authors.push(authorPublicKey)
      }
    } else {
      const idx = authors.indexOf(authorPublicKey)
      if (idx >= 0) {
        authors.splice(idx, 1)
      }
    }

    if (authors.length > 0) {
      reactions[emoji] = authors
    } else {
      delete reactions[emoji]
    }

    return { ...msg, reactions }
  })
}

export const useMessageStore = create<MessagesStore>((set, get) => ({
  messages: {},
  loadingOlder: {},
  hasMoreOlder: {},
  browsingOlder: {},
  newerGapCount: {},
  setMessages: (channelId, messages) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [channelId]: boundLatestWindow(mergeMessages(state.messages[channelId] ?? [], messages)),
      },
      hasMoreOlder: { ...state.hasMoreOlder, [channelId]: messages.length >= 50 },
      browsingOlder: { ...state.browsingOlder, [channelId]: false },
      newerGapCount: { ...state.newerGapCount, [channelId]: 0 },
    })),
  replaceMessages: (channelId, messages) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [channelId]: boundLatestWindow(mergeMessages([], messages)),
      },
      hasMoreOlder: { ...state.hasMoreOlder, [channelId]: messages.length >= 50 },
      browsingOlder: { ...state.browsingOlder, [channelId]: false },
      newerGapCount: { ...state.newerGapCount, [channelId]: 0 },
    })),
  addMessage: (channelId, message) =>
    set((state) => {
      const channelMessages = state.messages[channelId] ?? []
      if (channelMessages.some((existing) => existing.id === message.id)) {
        return state
      }

      if (state.browsingOlder[channelId] || (state.newerGapCount[channelId] ?? 0) > 0) {
        return {
          newerGapCount: {
            ...state.newerGapCount,
            [channelId]: (state.newerGapCount[channelId] ?? 0) + 1,
          },
        }
      }

      return {
        messages: {
          ...state.messages,
          [channelId]: boundLatestWindow(mergeMessages(channelMessages, [message])),
        },
      }
    }),
  prependMessages: (channelId, messages) =>
    set((state) => {
      const merged = mergeMessages(state.messages[channelId] ?? [], messages)
      const bounded = boundOlderWindow(merged)

      return {
        messages: {
          ...state.messages,
          [channelId]: bounded.messages,
        },
        browsingOlder: { ...state.browsingOlder, [channelId]: true },
        newerGapCount: {
          ...state.newerGapCount,
          [channelId]: (state.newerGapCount[channelId] ?? 0) + bounded.trimmedNewerCount,
        },
      }
    }),
  loadOlderMessages: async (channelId) => {
    const state = get()
    if (state.loadingOlder[channelId]) return
    if (state.hasMoreOlder[channelId] === false) return

    // Guard: track which channel we started loading for
    const loadingForChannel = channelId
    set({ loadingOlder: { ...state.loadingOlder, [channelId]: true } })

    try {
      const existing = state.messages[channelId] ?? []
      const oldestMessage = existing.length > 0 ? existing[0] : undefined
      // Capture the anchor ID so we can detect if the channel was reset mid-flight
      const anchorId = oldestMessage?.id
      const older = await bridge.getMessages(
        channelId,
        50,
        oldestMessage
          ? {
              timestamp: oldestMessage.timestamp,
              id: oldestMessage.id,
            }
          : undefined,
      )

      // Guard: verify we're still loading this channel (not stale from rapid switch)
      const currentState = get()
      if (!currentState.loadingOlder[loadingForChannel]) return

      // Guard: if the channel was reset (e.g., via setMessages on channel switch)
      // while we were fetching, the anchor message will no longer exist in the
      // current message list. Discard stale results to avoid corrupting the new state.
      if (anchorId) {
        const currentMessages = currentState.messages[channelId] ?? []
        if (!currentMessages.some((msg) => msg.id === anchorId)) return
      }

      if (older.length > 0) {
        get().prependMessages(channelId, older)
      }

      set((s) => ({
        hasMoreOlder: { ...s.hasMoreOlder, [channelId]: older.length >= 50 },
      }))
    } finally {
      set((s) => ({ loadingOlder: { ...s.loadingOlder, [channelId]: false } }))
    }
  },
  updateReaction: (channelId, messageId, emoji, authorPublicKey, verb) =>
    set((state) => {
      const channelMessages = state.messages[channelId]
      if (!channelMessages) return state

      return {
        messages: {
          ...state.messages,
          [channelId]: applyReaction(channelMessages, messageId, emoji, authorPublicKey, verb),
        },
      }
    }),
  editMessage: (channelId, messageId, content, editedAt) =>
    set((state) => {
      const channelMessages = state.messages[channelId]
      if (!channelMessages) return state

      return {
        messages: {
          ...state.messages,
          [channelId]: channelMessages.map((msg) =>
            msg.id === messageId ? { ...msg, content, editedAt } : msg,
          ),
        },
      }
    }),
  deleteMessage: (channelId, messageId) =>
    set((state) => {
      const channelMessages = state.messages[channelId]
      if (!channelMessages) return state

      return {
        messages: {
          ...state.messages,
          [channelId]: channelMessages.map((msg) =>
            msg.id === messageId
              ? { ...msg, content: '', deletedAt: new Date().toISOString() }
              : msg,
          ),
        },
      }
    }),
  removeMessage: (channelId, messageId) =>
    set((state) => {
      const channelMessages = state.messages[channelId]
      if (!channelMessages) return state

      return {
        messages: {
          ...state.messages,
          [channelId]: channelMessages.filter((msg) => msg.id !== messageId),
        },
      }
    }),
  setDeliveryStatus: (channelId, messageId, status) =>
    set((state) => {
      const channelMessages = state.messages[channelId]
      if (!channelMessages) return state

      return {
        messages: {
          ...state.messages,
          [channelId]: channelMessages.map((msg) =>
            msg.id === messageId ? { ...msg, deliveryStatus: status } : msg,
          ),
        },
      }
    }),
  removeMessagesByAuthor: (channelId, authorPublicKey) =>
    set((state) => {
      const channelMessages = state.messages[channelId]
      if (!channelMessages) return state

      return {
        messages: {
          ...state.messages,
          [channelId]: channelMessages.filter((msg) => msg.authorPublicKey !== authorPublicKey),
        },
      }
    }),
  removeMessagesByAuthorAllChannels: (authorPublicKey) =>
    set((state) => {
      const updated: Record<string, Message[]> = {}

      for (const [channelId, msgs] of Object.entries(state.messages)) {
        updated[channelId] = msgs.filter((msg) => msg.authorPublicKey !== authorPublicKey)
      }

      return { messages: updated }
    }),
}))
