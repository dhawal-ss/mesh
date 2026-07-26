import { create } from 'zustand'

export const MAX_DRAFT_LENGTH = 16 * 1024
const MAX_DRAFTS = 128

interface DraftStore {
  drafts: Record<string, string>
  setDraft: (channelId: string, value: string) => void
  clearDraft: (channelId: string) => void
}

function normalizeDraft(value: string): string {
  return value.slice(0, MAX_DRAFT_LENGTH)
}

export const useDraftStore = create<DraftStore>((set) => ({
  drafts: {},

  setDraft: (channelId, value) => {
    if (!channelId) return
    const normalized = normalizeDraft(value)
    set((state) => {
      if (!normalized) {
        if (!(channelId in state.drafts)) return state
        const drafts = { ...state.drafts }
        delete drafts[channelId]
        return { drafts }
      }

      const drafts = { ...state.drafts, [channelId]: normalized }
      const ids = Object.keys(drafts)
      if (ids.length > MAX_DRAFTS) {
        for (const staleId of ids.slice(0, ids.length - MAX_DRAFTS)) delete drafts[staleId]
      }
      return { drafts }
    })
  },

  clearDraft: (channelId) =>
    set((state) => {
      if (!(channelId in state.drafts)) return state
      const drafts = { ...state.drafts }
      delete drafts[channelId]
      return { drafts }
    }),
}))
