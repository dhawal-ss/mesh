import { create } from 'zustand'
import type { MatrixQueuedMessageState, MatrixQueuedMessageUpdate, Message } from '../types/ipc'
import * as bridge from '../lib/bridge'
import { federatedTimestampMilliseconds } from '../lib/federated-time'
import { patchChanges } from '../lib/state'

const HOT_WINDOW_SIZE = 200
const MAX_HISTORY_WINDOW_SIZE = 500
const MAX_CACHED_CHANNELS = 16

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
  channelRecency: string[]
  matrixQueueStates: Record<
    string,
    Record<string, { state: MatrixQueuedMessageState; eventId?: string }>
  >
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
  clearChannel: (channelId: string) => void
  setDeliveryStatus: (channelId: string, messageId: string, status: 'pending' | 'sent' | 'failed') => void
  acceptQueuedMessage: (message: Message) => void
  hydrateQueuedMessages: (messages: Message[]) => void
  applyQueuedMessageUpdate: (update: MatrixQueuedMessageUpdate) => void
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
  if (!existing) return incoming
  if (
    existing.deliveryStatus === 'sent'
    && incoming.deliveryStatus !== 'sent'
  ) {
    return existing
  }
  if (
    existing.deliveryStatus === 'failed'
    && incoming.deliveryStatus === 'pending'
  ) {
    return existing
  }
  if (
    incoming.deliveryStatus === 'sent'
    && existing.deliveryStatus !== 'sent'
  ) {
    const reconciled = { ...incoming, timestamp: existing.timestamp }
    return patchChanges(existing, reconciled) ? reconciled : existing
  }
  if (patchChanges(existing, incoming)) return incoming
  return existing
}

function messageAliases(message: Message): string[] {
  return [
    `event:${message.id}`,
    message.transactionId ? `transaction:${message.transactionId}` : '',
    message.clientRequestId ? `request:${message.clientRequestId}` : '',
  ].filter(Boolean)
}

function messagesShareIdentity(left: Message, right: Message): boolean {
  const leftAliases = new Set(messageAliases(left))
  return messageAliases(right).some((alias) => leftAliases.has(alias))
}

function mergeMessages(existing: Message[], incoming: Message[]) {
  const merged = [...existing]
  for (const incomingMessage of incoming) {
    const index = merged.findIndex((message) =>
      messagesShareIdentity(message, incomingMessage),
    )
    if (index < 0) {
      merged.push(incomingMessage)
    } else {
      merged[index] = mergeMessage(merged[index], incomingMessage)
    }
  }

  return merged.sort(compareMessages)
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
  allowFailedToPending = false,
) {
  const currentEntities = state.messageEntities[channelId] ?? {}
  const entities: Record<string, Message> = {}
  const order: string[] = []

  for (const incoming of orderedMessages) {
    if (entities[incoming.id]) continue
    const current = currentEntities[incoming.id]
    entities[incoming.id] = (
      allowFailedToPending
      && current?.deliveryStatus === 'failed'
      && incoming.deliveryStatus === 'pending'
    )
      ? incoming
      : mergeMessage(current, incoming)
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

type ChannelCacheState = Pick<
  MessagesStore,
  | 'messageEntities'
  | 'messageOrder'
  | 'messages'
  | 'loadingOlder'
  | 'hasMoreOlder'
  | 'browsingOlder'
  | 'newerGapCount'
  | 'channelRecency'
>

function withoutChannels<T>(
  values: Record<string, T>,
  channelIds: string[],
): Record<string, T> {
  let next = values
  for (const channelId of channelIds) {
    if (!(channelId in next)) continue
    next = { ...next }
    delete next[channelId]
  }
  return next
}

function retainChannel(
  state: ChannelCacheState,
  channelId: string,
  patch: Partial<ChannelCacheState>,
): ChannelCacheState {
  const channelRecency = [
    ...state.channelRecency.filter((cachedId) => cachedId !== channelId),
    channelId,
  ]
  const evictedChannelIds = channelRecency.slice(0, -MAX_CACHED_CHANNELS)
  return {
    messageEntities: withoutChannels(
      patch.messageEntities ?? state.messageEntities,
      evictedChannelIds,
    ),
    messageOrder: withoutChannels(
      patch.messageOrder ?? state.messageOrder,
      evictedChannelIds,
    ),
    messages: withoutChannels(
      patch.messages ?? state.messages,
      evictedChannelIds,
    ),
    loadingOlder: withoutChannels(
      patch.loadingOlder ?? state.loadingOlder,
      evictedChannelIds,
    ),
    hasMoreOlder: withoutChannels(
      patch.hasMoreOlder ?? state.hasMoreOlder,
      evictedChannelIds,
    ),
    browsingOlder: withoutChannels(
      patch.browsingOlder ?? state.browsingOlder,
      evictedChannelIds,
    ),
    newerGapCount: withoutChannels(
      patch.newerGapCount ?? state.newerGapCount,
      evictedChannelIds,
    ),
    channelRecency: channelRecency.slice(-MAX_CACHED_CHANNELS),
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
  channelRecency: [],
  matrixQueueStates: {},

  setMessages: (channelId, incoming) =>
    set((state) =>
      retainChannel(state, channelId, {
        ...normalizedChannel(
          state,
          channelId,
          boundLatestWindow(mergeMessages(state.messages[channelId] ?? [], incoming)),
        ),
        hasMoreOlder: { ...state.hasMoreOlder, [channelId]: incoming.length >= 50 },
        browsingOlder: { ...state.browsingOlder, [channelId]: false },
        newerGapCount: { ...state.newerGapCount, [channelId]: 0 },
      }),
    ),

  replaceMessages: (channelId, incoming) =>
    set((state) =>
      retainChannel(state, channelId, {
        ...normalizedChannel(
          state,
          channelId,
          boundLatestWindow(mergeMessages(
            (state.messages[channelId] ?? []).filter(
              (message) =>
                message.deliveryStatus === 'pending'
                || message.deliveryStatus === 'failed'
                || (
                  !!message.transactionId
                  && !incoming.some((candidate) =>
                    messagesShareIdentity(message, candidate),
                  )
                ),
            ),
            incoming,
          )),
        ),
        hasMoreOlder: { ...state.hasMoreOlder, [channelId]: incoming.length >= 50 },
        browsingOlder: { ...state.browsingOlder, [channelId]: false },
        newerGapCount: { ...state.newerGapCount, [channelId]: 0 },
      }),
    ),

  addMessage: (channelId, message) =>
    set((state) => {
      if (state.messageEntities[channelId]?.[message.id]) return state

      if (state.browsingOlder[channelId] || (state.newerGapCount[channelId] ?? 0) > 0) {
        return retainChannel(state, channelId, {
          newerGapCount: {
            ...state.newerGapCount,
            [channelId]: (state.newerGapCount[channelId] ?? 0) + 1,
          },
        })
      }

      return retainChannel(
        state,
        channelId,
        normalizedChannel(
          state,
          channelId,
          boundLatestWindow(mergeMessages(state.messages[channelId] ?? [], [message])),
        ),
      )
    }),

  prependMessages: (channelId, incoming) =>
    set((state) => {
      const bounded = boundOlderWindow(
        mergeMessages(state.messages[channelId] ?? [], incoming),
      )
      return retainChannel(state, channelId, {
        ...normalizedChannel(state, channelId, bounded.messages),
        browsingOlder: { ...state.browsingOlder, [channelId]: true },
        newerGapCount: {
          ...state.newerGapCount,
          [channelId]: (state.newerGapCount[channelId] ?? 0) + bounded.trimmedNewerCount,
        },
      })
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
      set((current) => (
        current.channelRecency.includes(channelId)
          ? { hasMoreOlder: { ...current.hasMoreOlder, [channelId]: older.length >= 50 } }
          : current
      ))
    } finally {
      set((current) => (
        current.channelRecency.includes(channelId)
          ? { loadingOlder: { ...current.loadingOlder, [channelId]: false } }
          : current
      ))
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

  clearChannel: (channelId) =>
    set((state) => {
      const cached =
        channelId in state.messageEntities
        || channelId in state.messageOrder
        || channelId in state.messages
        || channelId in state.loadingOlder
        || channelId in state.hasMoreOlder
        || channelId in state.browsingOlder
        || channelId in state.newerGapCount
        || channelId in state.matrixQueueStates
        || state.channelRecency.includes(channelId)
      if (!cached) return state
      return {
        messageEntities: withoutChannels(state.messageEntities, [channelId]),
        messageOrder: withoutChannels(state.messageOrder, [channelId]),
        messages: withoutChannels(state.messages, [channelId]),
        loadingOlder: withoutChannels(state.loadingOlder, [channelId]),
        hasMoreOlder: withoutChannels(state.hasMoreOlder, [channelId]),
        browsingOlder: withoutChannels(state.browsingOlder, [channelId]),
        newerGapCount: withoutChannels(state.newerGapCount, [channelId]),
        matrixQueueStates: withoutChannels(state.matrixQueueStates, [channelId]),
        channelRecency: state.channelRecency.filter((cachedId) => cachedId !== channelId),
      }
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

  acceptQueuedMessage: (message) =>
    set((state) => {
      const transactionId = message.transactionId ?? message.id
      const recorded = state.matrixQueueStates[message.channelId]?.[transactionId]
      if (recorded?.state === 'cancelled') return state
      const accepted = recorded?.state === 'sent' && recorded.eventId
        ? {
            ...message,
            id: recorded.eventId,
            deliveryStatus: 'sent' as const,
          }
        : recorded?.state === 'failed'
          ? { ...message, deliveryStatus: 'failed' as const }
          : message
      const normalized = normalizedChannel(
        state,
        message.channelId,
        boundLatestWindow(mergeMessages(
          state.messages[message.channelId] ?? [],
          [accepted],
        )),
      )
      const queueState = recorded ?? {
        state: accepted.deliveryStatus === 'failed' ? 'failed' : 'pending',
      }
      return {
        ...retainChannel(state, message.channelId, normalized),
        matrixQueueStates: {
          ...state.matrixQueueStates,
          [message.channelId]: {
            ...state.matrixQueueStates[message.channelId],
            [transactionId]: queueState,
          },
        },
      }
    }),

  hydrateQueuedMessages: (messages) => {
    for (const message of messages) get().acceptQueuedMessage(message)
  },

  applyQueuedMessageUpdate: (update) =>
    set((state) => {
      const roomStates = state.matrixQueueStates[update.roomId] ?? {}
      const previous = roomStates[update.transactionId]
      if (
        previous?.state === 'sent'
        && update.state !== 'sent'
      ) {
        return state
      }
      if (
        previous?.state === 'cancelled'
        && update.state !== 'sent'
      ) {
        return state
      }

      let roomMessages = state.messages[update.roomId] ?? []
      if (update.message) {
        roomMessages = mergeMessages(roomMessages, [update.message])
      }
      const index = roomMessages.findIndex(
        (message) =>
          message.transactionId === update.transactionId
          || message.id === update.transactionId,
      )
      if (update.state === 'cancelled') {
        roomMessages = roomMessages.filter(
          (message) =>
            message.transactionId !== update.transactionId
            && message.id !== update.transactionId,
        )
      } else if (index >= 0) {
        const current = roomMessages[index]
        const next = update.state === 'sent' && update.eventId
          ? {
              ...current,
              id: update.eventId,
              transactionId: update.transactionId,
              deliveryStatus: 'sent' as const,
            }
          : {
              ...current,
              deliveryStatus: update.state === 'failed'
                ? 'failed' as const
                : 'pending' as const,
            }
        roomMessages = [...roomMessages]
        roomMessages[index] = next
      }
      const normalized = normalizedChannel(
        state,
        update.roomId,
        boundLatestWindow(roomMessages.sort(compareMessages)),
        update.state === 'pending',
      )
      return {
        ...retainChannel(state, update.roomId, normalized),
        matrixQueueStates: {
          ...state.matrixQueueStates,
          [update.roomId]: {
            ...roomStates,
            [update.transactionId]: {
              state: update.state,
              ...(update.eventId ? { eventId: update.eventId } : {}),
            },
          },
        },
      }
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
