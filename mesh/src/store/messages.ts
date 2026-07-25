import { create } from 'zustand'
import type { Message } from '../types/ipc'
import * as bridge from '../lib/bridge'
import { federatedTimestampMilliseconds } from '../lib/federated-time'
import { patchChanges } from '../lib/state'

const HOT_WINDOW_SIZE = 200
const MAX_HISTORY_WINDOW_SIZE = 500

interface MessagesStore {
  /** Normalized source of truth, scoped by channel ID. */
  messageEntities: Record<string, Record<string, Message>>
  messageOrder: Record<string, string[]>
  /** Ordered compatibility snapshots used by virtualized list consumers. */
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
  const timeDiff =
    (federatedTimestampMilliseconds(a.timestamp) ?? 0)
    - (federatedTimestampMilliseconds(b.timestamp) ?? 0)
  if (timeDiff !== 0) return timeDiff
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

function mergeMessage(existing: Message | undefined, incoming: Message) {
  if (!existing || patchChanges(existing, incoming)) return incoming
  return existing
}

function mergeMessages(existing: Message[], incoming: Message[]) {
  const byId = new Map<string, Message>()

  for (const message of existing) byId.set(message.id, message)
  for (const incomingMessage of incoming) {
    byId.set(
      incomingMessage.id,
      mergeMessage(byId.get(incomingMessage.id), incomingMessage),
    )
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

function sameOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function normalizedChannel(
  state: Pick<MessagesStore, 'messageEntities' | 'messageOrder' | 'messages'>,
  channelId: string,
  orderedMessages: Message[],
) {
  const currentEntities = state.messageEntities[channelId] ?? {}
  const entities: Record<string, Message> = {}
  const order: string[] = []

  for (const incoming of orderedMessages) {
    if (entities[incoming.id]) continue
    entities[incoming.id] = mergeMessage(currentEntities[incoming.id], incoming)
    order.push(incoming.id)
  }

  const currentOrder = state.messageOrder[channelId] ?? []
  const entitiesUnchanged =
    sameOrder(currentOrder, order) &&
    order.every((id) => currentEntities[id] === entities[id])
  const nextEntities = entitiesUnchanged ? currentEntities : entities
  const nextOrder = sameOrder(currentOrder, order) ? currentOrder : order
  const nextMessages = entitiesUnchanged
    ? state.messages[channelId] ?? orderedMessages
    : nextOrder.map((id) => nextEntities[id])

  return {
    messageEntities: entitiesUnchanged
      ? state.messageEntities
      : { ...state.messageEntities, [channelId]: nextEntities },
    messageOrder: nextOrder === currentOrder
      ? state.messageOrder
      : { ...state.messageOrder, [channelId]: nextOrder },
    messages: nextMessages === state.messages[channelId]
      ? state.messages
      : { ...state.messages, [channelId]: nextMessages },
  }
}

function patchChannelMessage(
  state: MessagesStore,
  channelId: string,
  messageId: string,
  next: Message,
) {
  const index = (state.messageOrder[channelId] ?? []).indexOf(messageId)
  if (index < 0) return state
  const messages = [...(state.messages[channelId] ?? [])]
  messages[index] = next
  return {
    messageEntities: {
      ...state.messageEntities,
      [channelId]: {
        ...state.messageEntities[channelId],
        [messageId]: next,
      },
    },
    messages: { ...state.messages, [channelId]: messages },
  }
}

export const useMessageStore = create<MessagesStore>((set, get) => ({
  messageEntities: {},
  messageOrder: {},
  messages: {},
  loadingOlder: {},
  hasMoreOlder: {},
  browsingOlder: {},
  newerGapCount: {},

  setMessages: (channelId, incoming) =>
    set((state) => ({
      ...normalizedChannel(
        state,
        channelId,
        boundLatestWindow(mergeMessages(state.messages[channelId] ?? [], incoming)),
      ),
      hasMoreOlder: { ...state.hasMoreOlder, [channelId]: incoming.length >= 50 },
      browsingOlder: { ...state.browsingOlder, [channelId]: false },
      newerGapCount: { ...state.newerGapCount, [channelId]: 0 },
    })),

  replaceMessages: (channelId, incoming) =>
    set((state) => ({
      ...normalizedChannel(
        state,
        channelId,
        boundLatestWindow(mergeMessages([], incoming)),
      ),
      hasMoreOlder: { ...state.hasMoreOlder, [channelId]: incoming.length >= 50 },
      browsingOlder: { ...state.browsingOlder, [channelId]: false },
      newerGapCount: { ...state.newerGapCount, [channelId]: 0 },
    })),

  addMessage: (channelId, message) =>
    set((state) => {
      if (state.messageEntities[channelId]?.[message.id]) return state

      if (state.browsingOlder[channelId] || (state.newerGapCount[channelId] ?? 0) > 0) {
        return {
          newerGapCount: {
            ...state.newerGapCount,
            [channelId]: (state.newerGapCount[channelId] ?? 0) + 1,
          },
        }
      }

      return normalizedChannel(
        state,
        channelId,
        boundLatestWindow(mergeMessages(state.messages[channelId] ?? [], [message])),
      )
    }),

  prependMessages: (channelId, incoming) =>
    set((state) => {
      const bounded = boundOlderWindow(
        mergeMessages(state.messages[channelId] ?? [], incoming),
      )
      return {
        ...normalizedChannel(state, channelId, bounded.messages),
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

    set({ loadingOlder: { ...state.loadingOlder, [channelId]: true } })

    try {
      const existing = state.messages[channelId] ?? []
      const oldestMessage = existing[0]
      const anchorId = oldestMessage?.id
      const older = await bridge.getMessages(
        channelId,
        50,
        oldestMessage
          ? { timestamp: oldestMessage.timestamp, id: oldestMessage.id }
          : undefined,
      )

      const currentState = get()
      if (!currentState.loadingOlder[channelId]) return
      if (anchorId && !currentState.messageEntities[channelId]?.[anchorId]) return

      if (older.length > 0) get().prependMessages(channelId, older)
      set((current) => ({
        hasMoreOlder: { ...current.hasMoreOlder, [channelId]: older.length >= 50 },
      }))
    } finally {
      set((current) => ({
        loadingOlder: { ...current.loadingOlder, [channelId]: false },
      }))
    }
  },

  updateReaction: (channelId, messageId, emoji, authorPublicKey, verb) =>
    set((state) => {
      const current = state.messageEntities[channelId]?.[messageId]
      if (!current) return state
      const currentAuthors = current.reactions[emoji] ?? []
      const authors = [...currentAuthors]

      if (verb === 'add') {
        if (authors.includes(authorPublicKey)) return state
        authors.push(authorPublicKey)
      } else {
        const index = authors.indexOf(authorPublicKey)
        if (index < 0) return state
        authors.splice(index, 1)
      }

      const reactions = { ...current.reactions }
      if (authors.length > 0) reactions[emoji] = authors
      else delete reactions[emoji]
      return patchChannelMessage(
        state,
        channelId,
        messageId,
        { ...current, reactions },
      )
    }),

  editMessage: (channelId, messageId, content, editedAt) =>
    set((state) => {
      const current = state.messageEntities[channelId]?.[messageId]
      if (!current || (current.content === content && current.editedAt === editedAt)) {
        return state
      }
      return patchChannelMessage(
        state,
        channelId,
        messageId,
        { ...current, content, editedAt },
      )
    }),

  deleteMessage: (channelId, messageId) =>
    set((state) => {
      const current = state.messageEntities[channelId]?.[messageId]
      if (!current) return state
      return patchChannelMessage(
        state,
        channelId,
        messageId,
        { ...current, content: '', deletedAt: new Date().toISOString() },
      )
    }),

  removeMessage: (channelId, messageId) =>
    set((state) => {
      if (!state.messageEntities[channelId]?.[messageId]) return state
      const remaining = (state.messages[channelId] ?? []).filter(
        (message) => message.id !== messageId,
      )
      return normalizedChannel(state, channelId, remaining)
    }),

  setDeliveryStatus: (channelId, messageId, status) =>
    set((state) => {
      const current = state.messageEntities[channelId]?.[messageId]
      if (!current || current.deliveryStatus === status) return state
      return patchChannelMessage(
        state,
        channelId,
        messageId,
        { ...current, deliveryStatus: status },
      )
    }),

  removeMessagesByAuthor: (channelId, authorPublicKey) =>
    set((state) => {
      const current = state.messages[channelId]
      if (!current) return state
      const remaining = current.filter(
        (message) => message.authorPublicKey !== authorPublicKey,
      )
      if (remaining.length === current.length) return state
      return normalizedChannel(state, channelId, remaining)
    }),

  removeMessagesByAuthorAllChannels: (authorPublicKey) =>
    set((state) => {
      let messageEntities = state.messageEntities
      let messageOrder = state.messageOrder
      let messages = state.messages
      let changed = false

      for (const [channelId, current] of Object.entries(state.messages)) {
        const remaining = current.filter(
          (message) => message.authorPublicKey !== authorPublicKey,
        )
        if (remaining.length === current.length) continue
        const normalized = normalizedChannel(
          { messageEntities, messageOrder, messages },
          channelId,
          remaining,
        )
        messageEntities = normalized.messageEntities
        messageOrder = normalized.messageOrder
        messages = normalized.messages
        changed = true
      }

      return changed ? { messageEntities, messageOrder, messages } : state
    }),
}))

const EMPTY_MESSAGES: Message[] = []

export function useChannelMessages(channelId: string | null | undefined) {
  return useMessageStore((state) =>
    channelId
      ? state.messages[channelId] ?? EMPTY_MESSAGES
      : EMPTY_MESSAGES,
  )
}

export function useMessage(channelId: string | null | undefined, messageId: string | null | undefined) {
  return useMessageStore((state) =>
    channelId && messageId
      ? state.messageEntities[channelId]?.[messageId]
      : undefined,
  )
}
