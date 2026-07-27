import { create } from 'zustand'

export const MAX_DRAFT_BYTES = 16 * 1024
const MAX_DRAFTS = 128
const utf8Encoder = new TextEncoder()

interface DraftStore {
  drafts: Record<string, string>
  setDraft: (channelId: string, value: string) => void
  clearDraft: (channelId: string) => void
}

export function truncateDraft(value: string): string {
  if (utf8Encoder.encode(value).byteLength <= MAX_DRAFT_BYTES) return value

  const characters: string[] = []
  let bytes = 0
  for (const character of value) {
    const characterBytes = utf8Encoder.encode(character).byteLength
    if (bytes + characterBytes > MAX_DRAFT_BYTES) break
    characters.push(character)
    bytes += characterBytes
  }
  return characters.join('')
}

export const useDraftStore = create<DraftStore>((set) => ({
  drafts: {},

  setDraft: (channelId, value) => {
    if (!channelId) return
    const normalized = truncateDraft(value)
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
