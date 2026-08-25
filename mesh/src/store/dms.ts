import { create } from 'zustand'
import type {
  BlockedAccountDto,
  DmConversation,
  DmRequestDto,
  DirectMessage,
} from '../types/ipc'
import * as bridge from '../lib/bridge'
import { patchChanges, timelineEpochMilliseconds } from '../lib/state'
import {
  boundLatestWindow,
  mergeTimeline,
  retainScope,
  sameOrder,
} from './timeline-cache'
import { authoredByLocalAccount, useMessageStore } from './messages'
import { registerAccountReset } from '../lib/account-reset-registry'

const DM_PAGE_SIZE = 50
const MAX_DM_HISTORY_WINDOW_SIZE = 500
/** Mirrors the channel store's hot window so a live DM cannot grow unbounded. */
const MAX_DM_HOT_WINDOW_SIZE = 200
/** Mirrors MAX_CACHED_CHANNELS, scaled to how many DMs stay open at once. */
const MAX_CACHED_CONVERSATIONS = 12

export type LoadStatus = 'idle' | 'loading' | 'loaded' | 'refreshing' | 'failed'

export interface LoadState {
  status: LoadStatus
  error: unknown | null
  generation: number
}

interface DmStore {
  /** Normalized conversation source of truth. */
  conversationEntities: Record<string, DmConversation>
  conversationOrder: string[]
  /** Ordered compatibility snapshot for conversation list consumers. */
  conversations: DmConversation[]
  requests: DmRequestDto[]
  blockedAccounts: BlockedAccountDto[]
  blockedAccountsNextCursor: string | null
  /** Normalized message source of truth, scoped by conversation. */
  messageEntities: Record<string, Record<string, DirectMessage>>
  messageOrder: Record<string, string[]>
  /** Ordered compatibility snapshots for message-list consumers. */
  messages: Record<string, DirectMessage[]>
  activeConversationId: string | null
  isDmMode: boolean
  conversationLoad: LoadState
  requestLoad: LoadState
  blockedAccountLoad: LoadState
  messageLoads: Record<string, LoadState>
  loadingOlder: Record<string, boolean>
  hasMoreOlder: Record<string, boolean>
  browsingOlder: Record<string, boolean>
  newerGapCount: Record<string, number>
  /** Least-recently-used first; bounds how many conversations stay cached. */
  conversationRecency: string[]
  /**
   * True once this account has had a direct message of its own delivered.
   *
   * Read it as a scalar (`useDmStore((state) => state.hasAuthoredMessage)`)
   * instead of subscribing to the whole `messages` map and scanning it.
   */
  hasAuthoredMessage: boolean

  setDmMode: (active: boolean) => void
  setActiveConversation: (id: string | null) => void
  setConversations: (conversations: DmConversation[]) => void
  loadConversations: () => Promise<void>
  loadRequests: () => Promise<void>
  removeRequest: (roomId: string) => void
  loadBlockedAccounts: (reset?: boolean) => Promise<void>
  upsertBlockedAccount: (account: BlockedAccountDto) => void
  removeBlockedAccount: (userId: string) => void
  suppressPeer: (userId: string) => void
  resetIgnoredUserProjection: () => void
  loadMessages: (
    conversationId: string,
    options?: { resetToLatest?: boolean },
  ) => Promise<void>
  loadOlderMessages: (conversationId: string) => Promise<void>
  mergeHistoricalMessages: (
    conversationId: string,
    messages: DirectMessage[],
  ) => void
  addMessage: (msg: DirectMessage) => void
  patchMessage: (conversationId: string, messageId: string, patch: Partial<DirectMessage>) => void
  updateReaction: (conversationId: string, messageId: string, emoji: string, userId: string, verb: 'add' | 'remove') => void
  upsertConversation: (conversation: DmConversation) => void
  patchConversation: (id: string, patch: Partial<DmConversation>) => void
}

function mergeEntity<T extends object>(existing: T | undefined, incoming: T): T {
  if (!existing || patchChanges(existing, incoming)) return incoming
  return existing
}



function normalizeConversations(
  conversations: DmConversation[],
  existing: Record<string, DmConversation>,
) {
  const conversationEntities: Record<string, DmConversation> = {}
  const conversationOrder: string[] = []

  for (const incoming of conversations) {
    if (conversationEntities[incoming.id]) continue
    conversationEntities[incoming.id] = mergeEntity(existing[incoming.id], incoming)
    conversationOrder.push(incoming.id)
  }

  return {
    conversationEntities,
    conversationOrder,
    conversations: conversationOrder.map((id) => conversationEntities[id]),
  }
}

function normalizeMessages(
  messages: DirectMessage[],
  existing: Record<string, DirectMessage>,
) {
  const entities: Record<string, DirectMessage> = {}
  const order: string[] = []

  for (const incoming of messages) {
    if (entities[incoming.id]) continue
    entities[incoming.id] = mergeEntity(existing[incoming.id], incoming)
    order.push(incoming.id)
  }

  return {
    entities,
    order,
    messages: order.map((id) => entities[id]),
  }
}

function compareDirectMessages(left: DirectMessage, right: DirectMessage) {
  const timeDifference = timelineEpochMilliseconds(left) - timelineEpochMilliseconds(right)
  if (timeDifference !== 0) return timeDifference
  return left.id.localeCompare(right.id)
}

/**
 * Merge `incoming` into `existing`, preserving identity where nothing changed.
 *
 * `existing` is returned unchanged when no slot moved, so the ordered
 * projection and every entity in it keep their identity. `existing` is always
 * already sorted, so skipping the sort in that case is safe.
 */
/*
  A direct message is known by its id alone: unlike a channel send, there is no
  separate transaction id to reconcile, because the optimistic record and the
  server echo are both keyed on the id the sender minted.
*/
const DM_TIMELINE_POLICY = {
  aliases: (message: DirectMessage) => [message.id],
  merge: mergeEntity<DirectMessage>,
  compare: compareDirectMessages,
}

function mergeDirectMessages(
  existing: DirectMessage[],
  incoming: DirectMessage[],
): DirectMessage[] {
  return mergeTimeline(existing, incoming, DM_TIMELINE_POLICY)
}

function withoutConversation<T>(record: Record<string, T>, conversationId: string) {
  if (!Object.prototype.hasOwnProperty.call(record, conversationId)) return record
  const next = { ...record }
  delete next[conversationId]
  return next
}


function boundDmLatestWindow(messages: DirectMessage[]): DirectMessage[] {
  return boundLatestWindow(messages, MAX_DM_HOT_WINDOW_SIZE)
}

const CONVERSATION_SCOPED_KEYS = [
  'messageEntities',
  'messageOrder',
  'messages',
  'messageLoads',
  'loadingOlder',
  'hasMoreOlder',
  'browsingOlder',
  'newerGapCount',
] as const

type ConversationCacheState = Pick<
  DmStore,
  | 'messageEntities'
  | 'messageOrder'
  | 'messages'
  | 'messageLoads'
  | 'loadingOlder'
  | 'hasMoreOlder'
  | 'browsingOlder'
  | 'newerGapCount'
  | 'conversationRecency'
>

/**
 * Mark `conversationId` as most recently used and drop the message caches of
 * conversations past the bound.
 *
 * Only message-scoped caches are evicted. The conversation list itself stays
 * intact, so an evicted conversation still renders in the sidebar and reloads
 * its messages on next open. Every asynchronous writer re-checks its own key
 * before publishing, so an in-flight page cannot resurrect an evicted
 * conversation's keys.
 */
function retainConversation(
  state: ConversationCacheState,
  conversationId: string,
  patch: Partial<ConversationCacheState>,
): ConversationCacheState {
  return retainScope(state, patch, {
    scopeId: conversationId,
    recencyKey: 'conversationRecency',
    scopedKeys: CONVERSATION_SCOPED_KEYS,
    limit: MAX_CACHED_CONVERSATIONS,
  }) as ConversationCacheState
}

/** Latch `hasAuthoredMessage`; the scan is skipped once the flag is set. */
function withDmAuthorship<T extends object>(
  state: { hasAuthoredMessage: boolean },
  patch: T,
  admitted: readonly DirectMessage[],
): T & { hasAuthoredMessage: boolean } {
  return {
    ...patch,
    hasAuthoredMessage: state.hasAuthoredMessage || admitted.some(authoredByLocalAccount),
  }
}

export const useDmStore = create<DmStore>((set, get) => ({
  conversationEntities: {},
  conversationOrder: [],
  conversations: [],
  requests: [],
  blockedAccounts: [],
  blockedAccountsNextCursor: null,
  messageEntities: {},
  messageOrder: {},
  messages: {},
  activeConversationId: null,
  isDmMode: false,
  conversationLoad: { status: 'idle', error: null, generation: 0 },
  requestLoad: { status: 'idle', error: null, generation: 0 },
  blockedAccountLoad: { status: 'idle', error: null, generation: 0 },
  messageLoads: {},
  loadingOlder: {},
  hasMoreOlder: {},
  browsingOlder: {},
  newerGapCount: {},
  conversationRecency: [],
  hasAuthoredMessage: false,

  setDmMode: (active) => set({ isDmMode: active }),

  setActiveConversation: (id) => set({ activeConversationId: id }),

  setConversations: (conversations) =>
    set((state) => {
      const normalized = normalizeConversations(conversations, state.conversationEntities)
      const unchanged =
        sameOrder(state.conversationOrder, normalized.conversationOrder) &&
        normalized.conversationOrder.every(
          (id) => state.conversationEntities[id] === normalized.conversationEntities[id],
        )
      if (unchanged) return state
      return normalized
    }),

  loadConversations: async () => {
    const generation = get().conversationLoad.generation + 1
    const hasLastGood = get().conversationLoad.status === 'loaded'
      || get().conversations.length > 0
    set({
      conversationLoad: {
        status: hasLastGood ? 'refreshing' : 'loading',
        error: null,
        generation,
      },
    })
    try {
      const incoming = await bridge.getDmConversations()
      set((state) => {
        if (state.conversationLoad.generation !== generation) return state
        const normalized = normalizeConversations(incoming, state.conversationEntities)
        const unchanged =
          sameOrder(state.conversationOrder, normalized.conversationOrder) &&
          normalized.conversationOrder.every(
            (id) => state.conversationEntities[id] === normalized.conversationEntities[id],
          )
        const conversationLoad = { status: 'loaded', error: null, generation } as const
        return unchanged ? { conversationLoad } : { ...normalized, conversationLoad }
      })
    } catch (err) {
      if (get().conversationLoad.generation === generation) {
        set({ conversationLoad: { status: 'failed', error: err, generation } })
      }
      throw err
    }
  },

  loadRequests: async () => {
    const generation = get().requestLoad.generation + 1
    const hasLastGood = get().requestLoad.status === 'loaded' || get().requests.length > 0
    set({
      requestLoad: {
        status: hasLastGood ? 'refreshing' : 'loading',
        error: null,
        generation,
      },
    })
    try {
      const requests = await bridge.getDmRequests()
      set((state) => (
        state.requestLoad.generation === generation
          ? {
              requests,
              requestLoad: { status: 'loaded', error: null, generation },
            }
          : state
      ))
    } catch (error) {
      set((state) => (
        state.requestLoad.generation === generation
          ? { requestLoad: { status: 'failed', error, generation } }
          : state
      ))
      throw error
    }
  },

  removeRequest: (roomId) => set((state) => ({
    requests: state.requests.filter((request) => request.roomId !== roomId),
  })),

  loadBlockedAccounts: async (reset = true) => {
    const current = get()
    const after = reset ? undefined : current.blockedAccountsNextCursor ?? undefined
    if (!reset && !after) return
    const generation = current.blockedAccountLoad.generation + 1
    const hasLastGood = current.blockedAccountLoad.status === 'loaded'
      || current.blockedAccounts.length > 0
    set({
      blockedAccountLoad: {
        status: hasLastGood ? 'refreshing' : 'loading',
        error: null,
        generation,
      },
    })
    try {
      const page = await bridge.getBlockedAccounts(after)
      set((state) => {
        if (state.blockedAccountLoad.generation !== generation) return state
        const incoming = reset
          ? page.accounts
          : [...state.blockedAccounts, ...page.accounts]
        const seen = new Set<string>()
        const blockedAccounts = incoming.filter((account) => {
          if (seen.has(account.userId)) return false
          seen.add(account.userId)
          return true
        })
        blockedAccounts.sort((left, right) => left.userId.localeCompare(right.userId))
        return {
          blockedAccounts,
          blockedAccountsNextCursor: page.nextCursor,
          blockedAccountLoad: { status: 'loaded', error: null, generation },
        }
      })
      if (
        get().blockedAccountLoad.generation === generation
        && get().blockedAccountLoad.status === 'loaded'
      ) {
        for (const account of page.accounts) get().suppressPeer(account.userId)
      }
    } catch (error) {
      set((state) => (
        state.blockedAccountLoad.generation === generation
          ? { blockedAccountLoad: { status: 'failed', error, generation } }
          : state
      ))
      throw error
    }
  },

  upsertBlockedAccount: (account) => {
    set((state) => {
      if (state.blockedAccounts.some((candidate) => candidate.userId === account.userId)) {
        return state
      }
      return {
        blockedAccounts: [...state.blockedAccounts, account]
          .sort((left, right) => left.userId.localeCompare(right.userId)),
      }
    })
    get().suppressPeer(account.userId)
  },

  removeBlockedAccount: (userId) => set((state) => ({
    blockedAccounts: state.blockedAccounts.filter((account) => account.userId !== userId),
  })),

  suppressPeer: (userId) => {
    const suppressedIds = get().conversationOrder.filter(
      (id) => get().conversationEntities[id]?.peers.some((peer) => peer.userId === userId),
    )
    set((state) => {
      const suppressed = new Set(suppressedIds)
      const conversationEntities = { ...state.conversationEntities }
      const messageEntities = { ...state.messageEntities }
      const messageOrder = { ...state.messageOrder }
      const messages = { ...state.messages }
      const messageLoads = { ...state.messageLoads }
      let loadingOlder = state.loadingOlder
      let hasMoreOlder = state.hasMoreOlder
      let browsingOlder = state.browsingOlder
      let newerGapCount = state.newerGapCount
      for (const conversationId of suppressedIds) {
        delete conversationEntities[conversationId]
        delete messageEntities[conversationId]
        delete messageOrder[conversationId]
        delete messages[conversationId]
        delete messageLoads[conversationId]
        loadingOlder = withoutConversation(loadingOlder, conversationId)
        hasMoreOlder = withoutConversation(hasMoreOlder, conversationId)
        browsingOlder = withoutConversation(browsingOlder, conversationId)
        newerGapCount = withoutConversation(newerGapCount, conversationId)
      }
      const conversationOrder = suppressedIds.length === 0
        ? state.conversationOrder
        : state.conversationOrder.filter((id) => !suppressed.has(id))
      return {
        conversationEntities,
        conversationOrder,
        conversations: conversationOrder.map((id) => conversationEntities[id]),
        messageEntities,
        messageOrder,
        messages,
        messageLoads,
        loadingOlder,
        hasMoreOlder,
        browsingOlder,
        newerGapCount,
        conversationRecency: suppressedIds.length === 0
          ? state.conversationRecency
          : state.conversationRecency.filter((id) => !suppressed.has(id)),
        activeConversationId: state.activeConversationId
          && suppressed.has(state.activeConversationId)
          ? null
          : state.activeConversationId,
        requests: state.requests.filter((request) => request.inviterUserId !== userId),
        // Invalidate any list request that began before the authoritative block
        // write completed; its stale response must not resurrect this peer.
        conversationLoad: {
          status: 'loaded',
          error: null,
          generation: state.conversationLoad.generation + 1,
        },
        requestLoad: {
          status: 'loaded',
          error: null,
          generation: state.requestLoad.generation + 1,
        },
      }
    })

    const messageStore = useMessageStore.getState()
    // Ignoring is account-wide in Matrix: hide already-rendered content from
    // shared rooms as well as the private room. The native store is untouched.
    messageStore.removeMessagesByAuthorAllChannels(userId)
    for (const conversationId of suppressedIds) messageStore.clearChannel(conversationId)
  },

  resetIgnoredUserProjection: () => {
    set((state) => ({
      conversationEntities: {},
      conversationOrder: [],
      conversations: [],
      requests: [],
      blockedAccounts: [],
      blockedAccountsNextCursor: null,
      messageEntities: {},
      messageOrder: {},
      messages: {},
      activeConversationId: null,
      conversationLoad: {
        status: 'idle',
        error: null,
        generation: state.conversationLoad.generation + 1,
      },
      requestLoad: {
        status: 'idle',
        error: null,
        generation: state.requestLoad.generation + 1,
      },
      blockedAccountLoad: {
        status: 'idle',
        error: null,
        generation: state.blockedAccountLoad.generation + 1,
      },
      messageLoads: {},
      loadingOlder: {},
      hasMoreOlder: {},
      browsingOlder: {},
      newerGapCount: {},
      conversationRecency: [],
    }))
    const messageStore = useMessageStore.getState()
    for (const channelId of [...messageStore.channelRecency]) {
      messageStore.clearChannel(channelId)
    }
  },

  loadMessages: async (conversationId, options) => {
    const current = get().messageLoads[conversationId]
    const generation = (current?.generation ?? 0) + 1
    const hasLastGood = current?.status === 'loaded'
      || Object.prototype.hasOwnProperty.call(get().messages, conversationId)
    // Opening a conversation is the recency signal: bump it here so a cold
    // open evicts the least recently used conversation before its page lands.
    set((state) => retainConversation(state, conversationId, {
      messageLoads: {
        ...state.messageLoads,
        [conversationId]: {
          status: hasLastGood ? 'refreshing' : 'loading',
          error: null,
          generation,
        },
      },
    }))
    try {
      const incoming = await bridge.getDmMessages(conversationId, DM_PAGE_SIZE)
      set((state) => {
        if (state.messageLoads[conversationId]?.generation !== generation) return state
        if (state.browsingOlder[conversationId] && !options?.resetToLatest) {
          const unseenLatestCount = incoming.filter(
            (message) => !state.messageEntities[conversationId]?.[message.id],
          ).length
          return {
            messageLoads: {
              ...state.messageLoads,
              [conversationId]: { status: 'loaded', error: null, generation },
            },
            newerGapCount: {
              ...state.newerGapCount,
              [conversationId]: Math.max(
                state.newerGapCount[conversationId] ?? 0,
                unseenLatestCount,
              ),
            },
          }
        }
        const normalized = normalizeMessages(
          incoming,
          state.messageEntities[conversationId] ?? {},
        )
        const currentOrder = state.messageOrder[conversationId] ?? []
        const unchanged =
          sameOrder(currentOrder, normalized.order) &&
          normalized.order.every(
            (id) => state.messageEntities[conversationId]?.[id] === normalized.entities[id],
          )
        const nextLoad = { status: 'loaded', error: null, generation } as const
        if (unchanged) {
          return {
            messageLoads: { ...state.messageLoads, [conversationId]: nextLoad },
          }
        }
        return withDmAuthorship(state, retainConversation(state, conversationId, {
          messageEntities: {
            ...state.messageEntities,
            [conversationId]: normalized.entities,
          },
          messageOrder: {
            ...state.messageOrder,
            [conversationId]: normalized.order,
          },
          messages: {
            ...state.messages,
            [conversationId]: normalized.messages,
          },
          messageLoads: { ...state.messageLoads, [conversationId]: nextLoad },
          hasMoreOlder: {
            ...state.hasMoreOlder,
            [conversationId]: incoming.length >= DM_PAGE_SIZE,
          },
          browsingOlder: { ...state.browsingOlder, [conversationId]: false },
          newerGapCount: { ...state.newerGapCount, [conversationId]: 0 },
        }), incoming)
      })
    } catch (err) {
      set((state) => (
        state.messageLoads[conversationId]?.generation === generation
          ? {
              messageLoads: {
                ...state.messageLoads,
                [conversationId]: { status: 'failed', error: err, generation },
              },
            }
          : state
      ))
      throw err
    }
  },

  loadOlderMessages: async (conversationId) => {
    if (get().loadingOlder[conversationId]) return
    if (get().hasMoreOlder[conversationId] === false) return
    if (!get().messages[conversationId]?.[0]) {
      await get().loadMessages(conversationId)
      return
    }

    // A snapshot taken before the guard write is already stale by the time it
    // is written back: a second conversation paginating concurrently would
    // clobber this conversation's in-flight flag, defeating the guard above.
    let cursor: DirectMessage | undefined
    set((current) => {
      cursor = current.messages[conversationId]?.[0]
      return { loadingOlder: { ...current.loadingOlder, [conversationId]: true } }
    })

    try {
      if (!cursor) return
      const anchorId = cursor.id
      const older = await bridge.getDmMessages(
        conversationId,
        DM_PAGE_SIZE,
        { timestamp: cursor.timestamp, id: cursor.id },
      )
      set((current) => {
        if (!current.loadingOlder[conversationId]) return current
        if (!current.messageEntities[conversationId]?.[anchorId]) return current

        const merged = mergeDirectMessages(
          current.messages[conversationId] ?? [],
          older,
        )
        const trimmedNewerCount = Math.max(
          0,
          merged.length - MAX_DM_HISTORY_WINDOW_SIZE,
        )
        const bounded = trimmedNewerCount > 0
          ? merged.slice(0, MAX_DM_HISTORY_WINDOW_SIZE)
          : merged
        const normalized = normalizeMessages(
          bounded,
          current.messageEntities[conversationId] ?? {},
        )
        return withDmAuthorship(current, retainConversation(current, conversationId, {
          messageEntities: {
            ...current.messageEntities,
            [conversationId]: normalized.entities,
          },
          messageOrder: {
            ...current.messageOrder,
            [conversationId]: normalized.order,
          },
          messages: {
            ...current.messages,
            [conversationId]: normalized.messages,
          },
          hasMoreOlder: {
            ...current.hasMoreOlder,
            [conversationId]: older.length >= DM_PAGE_SIZE,
          },
          browsingOlder: {
            ...current.browsingOlder,
            [conversationId]: true,
          },
          newerGapCount: {
            ...current.newerGapCount,
            [conversationId]:
              (current.newerGapCount[conversationId] ?? 0) + trimmedNewerCount,
          },
        }), older)
      })
    } finally {
      // Only clear the flag if the conversation is still tracked. If suppressPeer
      // removed it mid-fetch, its loadingOlder key was deleted and must not be
      // resurrected here.
      set((current) => (
        Object.prototype.hasOwnProperty.call(current.loadingOlder, conversationId)
          ? {
              loadingOlder: {
                ...current.loadingOlder,
                [conversationId]: false,
              },
            }
          : current
      ))
    }
  },

  mergeHistoricalMessages: (conversationId, incoming) => set((state) => {
    const merged = mergeDirectMessages(
      state.messages[conversationId] ?? [],
      incoming,
    )
    const trimmedNewerCount = Math.max(
      0,
      merged.length - MAX_DM_HISTORY_WINDOW_SIZE,
    )
    const bounded = trimmedNewerCount > 0
      ? merged.slice(0, MAX_DM_HISTORY_WINDOW_SIZE)
      : merged
    const normalized = normalizeMessages(
      bounded,
      state.messageEntities[conversationId] ?? {},
    )
    return withDmAuthorship(state, retainConversation(state, conversationId, {
      messageEntities: {
        ...state.messageEntities,
        [conversationId]: normalized.entities,
      },
      messageOrder: {
        ...state.messageOrder,
        [conversationId]: normalized.order,
      },
      messages: {
        ...state.messages,
        [conversationId]: normalized.messages,
      },
      browsingOlder: {
        ...state.browsingOlder,
        [conversationId]: true,
      },
      newerGapCount: {
        ...state.newerGapCount,
        [conversationId]:
          (state.newerGapCount[conversationId] ?? 0) + trimmedNewerCount,
      },
    }), incoming)
  }),

  addMessage: (message) =>
    set((state) => {
      const conversationId = message.conversationId
      // Dedup first, before the gap counter: a re-delivered event (sync resume /
      // reconnect replay) must not inflate the "new messages" badge while the
      // user is browsing older history. This mirrors the channel store's order.
      const currentEntities = state.messageEntities[conversationId] ?? {}
      if (currentEntities[message.id]) return state

      if (
        state.browsingOlder[conversationId]
        || (state.newerGapCount[conversationId] ?? 0) > 0
      ) {
        return withDmAuthorship(state, {
          newerGapCount: {
            ...state.newerGapCount,
            [conversationId]: (state.newerGapCount[conversationId] ?? 0) + 1,
          },
        }, [message])
      }

      // Insert in timestamp order rather than blindly appending: a late,
      // out-of-order arrival (federation lag) must land in its chronological
      // slot, matching the channel timeline store. The id check above already
      // covers the common echo; mergeDirectMessages keeps the window sorted.
      // The window is bounded here as well as on the history paths, otherwise
      // a long-running conversation grows without limit.
      const nextMessages = boundDmLatestWindow(
        mergeDirectMessages(state.messages[conversationId] ?? [], [message]),
      )
      const normalized = normalizeMessages(nextMessages, currentEntities)

      return withDmAuthorship(state, retainConversation(state, conversationId, {
        messageEntities: {
          ...state.messageEntities,
          [conversationId]: normalized.entities,
        },
        messageOrder: {
          ...state.messageOrder,
          [conversationId]: normalized.order,
        },
        messages: {
          ...state.messages,
          [conversationId]: normalized.messages,
        },
      }), [message])
    }),

  patchMessage: (conversationId, messageId, patch) =>
    set((state) => {
      const current = state.messageEntities[conversationId]?.[messageId]
      if (!current || !patchChanges(current, patch)) return state
      const next = { ...current, ...patch }
      const index = (state.messageOrder[conversationId] ?? []).indexOf(messageId)
      const messages = [...(state.messages[conversationId] ?? [])]
      if (index >= 0) messages[index] = next

      // A local echo confirmed here is the moment this account has provably
      // sent something, so latch the flag on the transition too.
      return withDmAuthorship(state, {
        messageEntities: {
          ...state.messageEntities,
          [conversationId]: {
            ...state.messageEntities[conversationId],
            [messageId]: next,
          },
        },
        messages: { ...state.messages, [conversationId]: messages },
      }, [next])
    }),

  updateReaction: (conversationId, messageId, emoji, userId, verb) =>
    set((state) => {
      const current = state.messageEntities[conversationId]?.[messageId]
      if (!current) return state
      const currentUsers = current.reactions?.[emoji] ?? []
      const users = new Set(currentUsers)
      if (verb === 'add') users.add(userId)
      else users.delete(userId)
      const nextUsers = [...users]
      if (
        nextUsers.length === currentUsers.length &&
        nextUsers.every((entry, index) => entry === currentUsers[index])
      ) {
        return state
      }

      const reactions = { ...(current.reactions ?? {}) }
      if (nextUsers.length > 0) reactions[emoji] = nextUsers
      else delete reactions[emoji]
      const next = { ...current, reactions }
      const index = (state.messageOrder[conversationId] ?? []).indexOf(messageId)
      const messages = [...(state.messages[conversationId] ?? [])]
      if (index >= 0) messages[index] = next

      return {
        messageEntities: {
          ...state.messageEntities,
          [conversationId]: {
            ...state.messageEntities[conversationId],
            [messageId]: next,
          },
        },
        messages: { ...state.messages, [conversationId]: messages },
      }
    }),

  upsertConversation: (incoming) =>
    set((state) => {
      const current = state.conversationEntities[incoming.id]
      const next = mergeEntity(current, incoming)
      if (current === next) return state

      if (!current) {
        return {
          conversationEntities: {
            ...state.conversationEntities,
            [incoming.id]: next,
          },
          conversationOrder: [incoming.id, ...state.conversationOrder],
          conversations: [next, ...state.conversations],
        }
      }

      const index = state.conversationOrder.indexOf(incoming.id)
      const conversations = [...state.conversations]
      if (index >= 0) conversations[index] = next
      return {
        conversationEntities: {
          ...state.conversationEntities,
          [incoming.id]: next,
        },
        conversations,
      }
    }),

  patchConversation: (id, patch) =>
    set((state) => {
      const current = state.conversationEntities[id]
      if (!current || !patchChanges(current, patch)) return state
      const next = { ...current, ...patch }
      const index = state.conversationOrder.indexOf(id)
      const conversations = [...state.conversations]
      if (index >= 0) conversations[index] = next
      return {
        conversationEntities: { ...state.conversationEntities, [id]: next },
        conversations,
      }
    }),
}))

export function useDmConversation(id: string | null | undefined) {
  return useDmStore((state) => (id ? state.conversationEntities[id] : undefined))
}


registerAccountReset('dms', () => {
  useDmStore.setState({
    conversationEntities: {},
    conversationOrder: [],
    conversations: [],
    requests: [],
    blockedAccounts: [],
    blockedAccountsNextCursor: null,
    messageEntities: {},
    messageOrder: {},
    messages: {},
    activeConversationId: null,
    isDmMode: false,
    conversationLoad: { status: 'idle', error: null, generation: 0 },
    requestLoad: { status: 'idle', error: null, generation: 0 },
    blockedAccountLoad: { status: 'idle', error: null, generation: 0 },
    messageLoads: {},
    loadingOlder: {},
    hasMoreOlder: {},
    browsingOlder: {},
    newerGapCount: {},
    conversationRecency: [],
    hasAuthoredMessage: false,
  })
})
