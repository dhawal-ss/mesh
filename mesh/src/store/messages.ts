import { create } from 'zustand'
import type { MatrixQueuedMessageState, MatrixQueuedMessageUpdate, Message } from '../types/ipc'
import * as bridge from '../lib/bridge'
import { patchChanges, timelineEpochMilliseconds } from '../lib/state'
import {
  boundLatestWindow as boundLatest,
  boundOlderWindow as boundOlder,
  mergeTimeline,
  retainScope,
  sameOrder,
  withoutScopes,
} from './timeline-cache'
import { useIdentityStore } from './identity'
import { registerAccountReset } from '../lib/account-reset-registry'

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
  /**
   * True once this account has had a channel message of its own delivered.
   *
   * Read it as a scalar (`useMessageStore((state) => state.hasAuthoredMessage)`)
   * instead of subscribing to the whole `messages` map and scanning it: the
   * scan re-ran on every render across every cached channel.
   */
  hasAuthoredMessage: boolean
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
  editMessage: (
    channelId: string,
    messageId: string,
    content: string,
    editedAt: string,
    mentions?: readonly string[],
  ) => void
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

type AuthoredRecord = {
  authorPublicKey: string
  deliveryStatus?: 'sent' | 'pending' | 'failed' | null
}

/**
 * Whether this record is a delivered message written by the signed-in account.
 *
 * A missing delivery status means "sent" for records that came back from the
 * server, so only an explicit pending or failed echo is excluded: neither is
 * evidence that the account has successfully sent anything yet.
 */
export function authoredByLocalAccount(record: AuthoredRecord): boolean {
  const accountId = useIdentityStore.getState().identity?.publicKey
  if (!accountId || record.authorPublicKey !== accountId) return false
  return record.deliveryStatus !== 'failed' && record.deliveryStatus !== 'pending'
}

/**
 * Latch `hasAuthoredMessage` on an ingest patch.
 *
 * The scan is skipped entirely once the flag is set, so the steady-state cost
 * is one boolean read.
 */
function withLocalAuthorship<T extends object>(
  state: { hasAuthoredMessage: boolean },
  patch: T,
  admitted: readonly AuthoredRecord[],
): T & { hasAuthoredMessage: boolean } {
  return {
    ...patch,
    hasAuthoredMessage: state.hasAuthoredMessage || admitted.some(authoredByLocalAccount),
  }
}

function compareMessages(a: Message, b: Message) {
  const timeDiff = timelineEpochMilliseconds(a) - timelineEpochMilliseconds(b)
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

/**
 * Merge `incoming` into `existing`, preserving identity where nothing changed.
 *
 * Identity is resolved through a single alias index built once per merge
 * rather than a nested scan: the previous shape was O(n*m) and allocated two
 * arrays and a Set per comparison, which is up to 12,500 comparisons for a
 * 50-message page against a full 200-message window.
 *
 * `existing` is returned unchanged when no slot moved, which lets every
 * "return state unchanged" fast path downstream actually fire. `existing` is
 * always already sorted, so skipping the sort in that case is safe.
 */
const MESSAGE_TIMELINE_POLICY = {
  aliases: messageAliases,
  merge: mergeMessage,
  compare: compareMessages,
}

function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  return mergeTimeline(existing, incoming, MESSAGE_TIMELINE_POLICY)
}



function boundLatestWindow(messages: Message[]): Message[] {
  return boundLatest(messages, HOT_WINDOW_SIZE)
}

function boundOlderWindow(messages: Message[]): { messages: Message[]; trimmedNewerCount: number } {
  const bounded = boundOlder(messages, MAX_HISTORY_WINDOW_SIZE)
  return { messages: bounded.items, trimmedNewerCount: bounded.trimmedNewerCount }
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



const CHANNEL_SCOPED_KEYS = [
  'messageEntities',
  'messageOrder',
  'messages',
  'loadingOlder',
  'hasMoreOlder',
  'browsingOlder',
  'newerGapCount',
] as const

function retainChannel(
  state: ChannelCacheState,
  channelId: string,
  patch: Partial<ChannelCacheState>,
): ChannelCacheState {
  return retainScope(state, patch, {
    scopeId: channelId,
    recencyKey: 'channelRecency',
    scopedKeys: CHANNEL_SCOPED_KEYS,
    limit: MAX_CACHED_CHANNELS,
  }) as ChannelCacheState
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
  hasAuthoredMessage: false,
  matrixQueueStates: {},

  setMessages: (channelId, incoming) =>
    set((state) =>
      withLocalAuthorship(state, retainChannel(state, channelId, {
        ...normalizedChannel(
          state,
          channelId,
          boundLatestWindow(mergeMessages(state.messages[channelId] ?? [], incoming)),
        ),
        hasMoreOlder: { ...state.hasMoreOlder, [channelId]: incoming.length >= 50 },
        browsingOlder: { ...state.browsingOlder, [channelId]: false },
        newerGapCount: { ...state.newerGapCount, [channelId]: 0 },
      }), incoming),
    ),

  replaceMessages: (channelId, incoming) =>
    set((state) =>
      withLocalAuthorship(state, retainChannel(state, channelId, {
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
      }), incoming),
    ),

  addMessage: (channelId, message) =>
    set((state) => {
      if (state.messageEntities[channelId]?.[message.id]) return state

      if (state.browsingOlder[channelId] || (state.newerGapCount[channelId] ?? 0) > 0) {
        return withLocalAuthorship(state, retainChannel(state, channelId, {
          newerGapCount: {
            ...state.newerGapCount,
            [channelId]: (state.newerGapCount[channelId] ?? 0) + 1,
          },
        }), [message])
      }

      return withLocalAuthorship(state, retainChannel(
        state,
        channelId,
        normalizedChannel(
          state,
          channelId,
          boundLatestWindow(mergeMessages(state.messages[channelId] ?? [], [message])),
        ),
      ), [message])
    }),

  prependMessages: (channelId, incoming) =>
    set((state) => {
      const bounded = boundOlderWindow(
        mergeMessages(state.messages[channelId] ?? [], incoming),
      )
      return withLocalAuthorship(state, retainChannel(state, channelId, {
        ...normalizedChannel(state, channelId, bounded.messages),
        browsingOlder: { ...state.browsingOlder, [channelId]: true },
        newerGapCount: {
          ...state.newerGapCount,
          [channelId]: (state.newerGapCount[channelId] ?? 0) + bounded.trimmedNewerCount,
        },
      }), incoming)
    }),

  loadOlderMessages: async (channelId) => {
    if (get().loadingOlder[channelId]) return
    if (get().hasMoreOlder[channelId] === false) return

    // A snapshot taken before the guard write is already stale by the time it
    // is written back: a second channel paginating concurrently would clobber
    // this channel's in-flight flag, defeating the guard above.
    let oldestMessage: Message | undefined
    set((current) => {
      oldestMessage = (current.messages[channelId] ?? [])[0]
      return { loadingOlder: { ...current.loadingOlder, [channelId]: true } }
    })

    try {
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

  editMessage: (channelId, messageId, content, editedAt, mentions) =>
    set((state) => {
      const current = state.messageEntities[channelId]?.[messageId]
      if (!current || (current.content === content && current.editedAt === editedAt)) {
        return state
      }
      return patchChannelMessage(
        state,
        channelId,
        messageId,
        { ...current, content, editedAt, mentions: mentions ? [...mentions] : current.mentions },
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
        messageEntities: withoutScopes(state.messageEntities, [channelId]),
        messageOrder: withoutScopes(state.messageOrder, [channelId]),
        messages: withoutScopes(state.messages, [channelId]),
        loadingOlder: withoutScopes(state.loadingOlder, [channelId]),
        hasMoreOlder: withoutScopes(state.hasMoreOlder, [channelId]),
        browsingOlder: withoutScopes(state.browsingOlder, [channelId]),
        newerGapCount: withoutScopes(state.newerGapCount, [channelId]),
        matrixQueueStates: withoutScopes(state.matrixQueueStates, [channelId]),
        channelRecency: state.channelRecency.filter((cachedId) => cachedId !== channelId),
      }
    }),

  setDeliveryStatus: (channelId, messageId, status) =>
    set((state) => {
      const current = state.messageEntities[channelId]?.[messageId]
      if (!current || current.deliveryStatus === status) return state
      const next = { ...current, deliveryStatus: status }
      const patched = patchChannelMessage(state, channelId, messageId, next)
      if (patched === state) return state
      // A local echo confirmed here is the moment this account has provably
      // sent something, so latch the flag on the transition too.
      return withLocalAuthorship(state, patched, [next])
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
      return withLocalAuthorship(state, {
        ...retainChannel(state, message.channelId, normalized),
        matrixQueueStates: {
          ...state.matrixQueueStates,
          [message.channelId]: {
            ...state.matrixQueueStates[message.channelId],
            [transactionId]: queueState,
          },
        },
      }, [accepted])
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
      const admitted: Message[] = update.message ? [update.message] : []
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
              // Carried only while the send is actually failed, so a later
              // retry that goes back to pending does not keep showing a reason
              // that no longer applies.
              sendFailure: update.state === 'failed' ? update.failure ?? null : null,
            }
        roomMessages = [...roomMessages]
        roomMessages[index] = next
        admitted.push(next)
      }
      const normalized = normalizedChannel(
        state,
        update.roomId,
        // Sort a copy: `roomMessages` can still be the array held in state
        // when nothing above replaced it, and sorting in place would mutate
        // published state.
        boundLatestWindow([...roomMessages].sort(compareMessages)),
        update.state === 'pending',
      )
      return withLocalAuthorship(state, {
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
      }, admitted)
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

/**
 * Whether a room is holding a message that could not be sent.
 *
 * The room list is the only place a failure in a room you are not looking at
 * can surface. Without this, a send that failed while you were reading
 * somewhere else left no trace anywhere you would see it.
 */
export function useHasFailedMessages(channelId: string | null | undefined): boolean {
  return useMessageStore((state) => {
    if (!channelId) return false
    const messages = state.messages[channelId]
    return messages ? messages.some((message) => message.deliveryStatus === 'failed') : false
  })
}


registerAccountReset('messages', () => {
  useMessageStore.setState({
    messageEntities: {},
    messageOrder: {},
    messages: {},
    loadingOlder: {},
    hasMoreOlder: {},
    browsingOlder: {},
    newerGapCount: {},
    channelRecency: [],
    hasAuthoredMessage: false,
    matrixQueueStates: {},
  })
})
