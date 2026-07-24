import { create } from 'zustand'

interface TypingUser {
  author: string
  displayName: string
  expiresAt: number
}

interface TypingStore {
  /** Map of channelId -> array of currently typing users */
  typingByChannel: Record<string, TypingUser[]>
  /** Record a typing event from a remote user */
  setTyping: (channelId: string, author: string, displayName: string) => void
  /** Remove expired entries for a channel */
  pruneExpired: (channelId: string) => void
  /** Get the display names of users typing in a channel */
  getTypingUsers: (channelId: string) => string[]
}

/** Typing indicators expire after 6 seconds if not refreshed */
const TYPING_EXPIRY_MS = 6000

export const useTypingStore = create<TypingStore>((set, get) => ({
  typingByChannel: {},

  setTyping: (channelId, author, displayName) => {
    set((state) => {
      const existing = state.typingByChannel[channelId] ?? []
      const expiresAt = Date.now() + TYPING_EXPIRY_MS

      // Update existing entry or add new one
      const filtered = existing.filter((u) => u.author !== author)
      filtered.push({ author, displayName, expiresAt })

      return {
        typingByChannel: {
          ...state.typingByChannel,
          [channelId]: filtered,
        },
      }
    })
  },

  pruneExpired: (channelId) => {
    set((state) => {
      const existing = state.typingByChannel[channelId] ?? []
      const now = Date.now()
      const active = existing.filter((u) => u.expiresAt > now)

      if (active.length === existing.length) return state

      return {
        typingByChannel: {
          ...state.typingByChannel,
          [channelId]: active,
        },
      }
    })
  },

  getTypingUsers: (channelId) => {
    const existing = get().typingByChannel[channelId] ?? []
    const now = Date.now()
    return existing.filter((u) => u.expiresAt > now).map((u) => u.displayName)
  },
}))
