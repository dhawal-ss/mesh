import { create } from 'zustand'
import type { DmConversation, DirectMessage } from '../types/ipc'
import * as bridge from '../lib/bridge'
import { patchChanges } from '../lib/state'

interface DmStore {
  /** Normalized conversation source of truth. */
  conversationEntities: Record<string, DmConversation>
  conversationOrder: string[]
  /** Ordered compatibility snapshot for conversation list consumers. */
  conversations: DmConversation[]
  /** Normalized message source of truth, scoped by conversation. */
  messageEntities: Record<string, Record<string, DirectMessage>>
  messageOrder: Record<string, string[]>
  /** Ordered compatibility snapshots for message-list consumers. */
  messages: Record<string, DirectMessage[]>
  activeConversationId: string | null
  isDmMode: boolean

  setDmMode: (active: boolean) => void
  setActiveConversation: (id: string | null) => void
  setConversations: (conversations: DmConversation[]) => void
  loadConversations: () => Promise<void>
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
  messageEntities: {},
  messageOrder: {},
  messages: {},
  activeConversationId: null,
  isDmMode: false,

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
    try {
      get().setConversations(await bridge.getDmConversations())
    } catch (err) {
      console.error('Failed to load DM conversations:', err)
    }
  },

  loadMessages: async (conversationId) => {
    try {
      const incoming = await bridge.getDmMessages(conversationId, 50)
      set((state) => {
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
        if (unchanged) return state
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
        }
      })
    } catch (err) {
      console.error('Failed to load DM messages:', err)
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
