import { create } from 'zustand'
import type {
  BlockedAccountDto,
  DmConversation,
  DmRequestDto,
  DirectMessage,
} from '../types/ipc'
import * as bridge from '../lib/bridge'
import { patchChanges } from '../lib/state'
import { useMessageStore } from './messages'

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
  loadMessages: (conversationId: string) => Promise<void>
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

function sameOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index])
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
      (id) => get().conversationEntities[id]?.peerPublicKey === userId,
    )
    set((state) => {
      const suppressed = new Set(suppressedIds)
      const conversationEntities = { ...state.conversationEntities }
      const messageEntities = { ...state.messageEntities }
      const messageOrder = { ...state.messageOrder }
      const messages = { ...state.messages }
      const messageLoads = { ...state.messageLoads }
      for (const conversationId of suppressedIds) {
        delete conversationEntities[conversationId]
        delete messageEntities[conversationId]
        delete messageOrder[conversationId]
        delete messages[conversationId]
        delete messageLoads[conversationId]
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
    }))
    const messageStore = useMessageStore.getState()
    for (const channelId of [...messageStore.channelRecency]) {
      messageStore.clearChannel(channelId)
    }
  },

  loadMessages: async (conversationId) => {
    const current = get().messageLoads[conversationId]
    const generation = (current?.generation ?? 0) + 1
    const hasLastGood = current?.status === 'loaded'
      || Object.prototype.hasOwnProperty.call(get().messages, conversationId)
    set((state) => ({
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
      const incoming = await bridge.getDmMessages(conversationId, 50)
      set((state) => {
        if (state.messageLoads[conversationId]?.generation !== generation) return state
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
        return {
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
        }
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

  addMessage: (message) =>
    set((state) => {
      const conversationId = message.conversationId
      const currentEntities = state.messageEntities[conversationId] ?? {}
      if (currentEntities[message.id]) return state

      return {
        messageEntities: {
          ...state.messageEntities,
          [conversationId]: { ...currentEntities, [message.id]: message },
        },
        messageOrder: {
          ...state.messageOrder,
          [conversationId]: [...(state.messageOrder[conversationId] ?? []), message.id],
        },
        messages: {
          ...state.messages,
          [conversationId]: [...(state.messages[conversationId] ?? []), message],
        },
      }
    }),

  patchMessage: (conversationId, messageId, patch) =>
    set((state) => {
      const current = state.messageEntities[conversationId]?.[messageId]
      if (!current || !patchChanges(current, patch)) return state
      const next = { ...current, ...patch }
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

export function useActiveDmConversation() {
  return useDmStore((state) =>
    state.activeConversationId
      ? state.conversationEntities[state.activeConversationId]
      : undefined,
  )
}
