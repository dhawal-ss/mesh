import { create } from 'zustand'
import type { DmConversation, DirectMessage } from '../types/ipc'
import * as bridge from '../lib/bridge'

interface DmStore {
  conversations: DmConversation[]
  activeConversationId: string | null
  messages: Record<string, DirectMessage[]>
  isDmMode: boolean

  setDmMode: (active: boolean) => void
  setActiveConversation: (id: string | null) => void
  loadConversations: () => Promise<void>
  loadMessages: (conversationId: string) => Promise<void>
  addMessage: (msg: DirectMessage) => void
  patchConversation: (id: string, patch: Partial<DmConversation>) => void
}

export const useDmStore = create<DmStore>((set) => ({
  conversations: [],
  activeConversationId: null,
  messages: {},
  isDmMode: false,

  setDmMode: (active: boolean) => set({ isDmMode: active }),

  setActiveConversation: (id: string | null) => set({ activeConversationId: id }),

  loadConversations: async () => {
    try {
      const conversations = await bridge.getDmConversations()
      set({ conversations })
    } catch (err) {
      console.error('Failed to load DM conversations:', err)
    }
  },

  loadMessages: async (conversationId: string) => {
    try {
      const msgs = await bridge.getDmMessages(conversationId, 50)
      set((state) => ({
        messages: { ...state.messages, [conversationId]: msgs },
      }))
    } catch (err) {
      console.error('Failed to load DM messages:', err)
    }
  },

  addMessage: (msg: DirectMessage) =>
    set((state) => {
      const existing = state.messages[msg.conversationId] ?? []
      if (existing.some((m) => m.id === msg.id)) return state

      return {
        messages: {
          ...state.messages,
          [msg.conversationId]: [...existing, msg],
        },
      }
    }),

  patchConversation: (id: string, patch: Partial<DmConversation>) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    })),
}))
