import { useEffect } from 'react'
import { create } from 'zustand'
import * as bridge from '../lib/bridge'
import type { ServerEmoji } from '../types/ipc'
import { mapSettledWithConcurrency } from '../lib/concurrency'

export interface LoadedServerEmoji extends ServerEmoji {
  imageUrl?: string
}

interface ServerEmojiStore {
  byCommunity: Record<string, LoadedServerEmoji[]>
  loading: Record<string, boolean>
  load: (communityId: string, force?: boolean) => Promise<void>
  removeLocal: (communityId: string, shortcode: string) => void
  clear: (communityId: string) => void
  clearAll: () => void
}

const inFlight = new Map<string, Promise<void>>()
const communityEpochs = new Map<string, number>()
let accountEpoch = 0
const EMPTY_EMOJI: LoadedServerEmoji[] = []

function loadIsCurrent(communityId: string, capturedAccountEpoch: number, capturedCommunityEpoch: number) {
  return accountEpoch === capturedAccountEpoch
    && (communityEpochs.get(communityId) ?? 0) === capturedCommunityEpoch
}

function revoke(entries: readonly LoadedServerEmoji[]) {
  for (const entry of entries) {
    if (entry.imageUrl) URL.revokeObjectURL(entry.imageUrl)
  }
}

export const useServerEmojiStore = create<ServerEmojiStore>((set, get) => ({
  byCommunity: {},
  loading: {},

  load: async (communityId, force = false) => {
    if (!bridge.isMatrixBackend()) return
    if (!force && get().byCommunity[communityId]) return
    const existing = inFlight.get(communityId)
    if (existing) return existing
    const capturedAccountEpoch = accountEpoch
    const capturedCommunityEpoch = communityEpochs.get(communityId) ?? 0

    let request!: Promise<void>
    request = (async () => {
      set((state) => ({
        loading: { ...state.loading, [communityId]: true },
      }))
      try {
        const metadata = await bridge.listServerEmoji(communityId)
        if (!loadIsCurrent(communityId, capturedAccountEpoch, capturedCommunityEpoch)) return
        const loaded = (
          await mapSettledWithConcurrency(metadata, 4, async (emoji) => {
            if (!loadIsCurrent(communityId, capturedAccountEpoch, capturedCommunityEpoch)) {
              return { ...emoji }
            }
            try {
              const bytes = await bridge.loadServerEmojiImage(
                communityId,
                emoji.shortcode,
              )
              if (!loadIsCurrent(communityId, capturedAccountEpoch, capturedCommunityEpoch)) {
                return { ...emoji }
              }
              return {
                ...emoji,
                imageUrl: URL.createObjectURL(
                  new Blob([bytes], { type: emoji.contentType }),
                ),
              }
            } catch {
              return { ...emoji }
            }
          }, () => loadIsCurrent(communityId, capturedAccountEpoch, capturedCommunityEpoch))
        ).map((result, index) => result.status === 'fulfilled' ? result.value : metadata[index])

        if (!loadIsCurrent(communityId, capturedAccountEpoch, capturedCommunityEpoch)) {
          revoke(loaded)
          return
        }
        set((state) => {
          revoke(state.byCommunity[communityId] ?? [])
          return {
            byCommunity: {
              ...state.byCommunity,
              [communityId]: loaded,
            },
            loading: { ...state.loading, [communityId]: false },
          }
        })
      } catch {
        if (!loadIsCurrent(communityId, capturedAccountEpoch, capturedCommunityEpoch)) return
        set((state) => ({
          byCommunity: {
            ...state.byCommunity,
            [communityId]: state.byCommunity[communityId] ?? [],
          },
          loading: { ...state.loading, [communityId]: false },
        }))
      } finally {
        if (inFlight.get(communityId) === request) inFlight.delete(communityId)
      }
    })()
    inFlight.set(communityId, request)
    return request
  },

  removeLocal: (communityId, shortcode) => set((state) => {
    const current = state.byCommunity[communityId] ?? []
    revoke(current.filter((emoji) => emoji.shortcode === shortcode))
    return {
      byCommunity: {
        ...state.byCommunity,
        [communityId]: current.filter((emoji) => emoji.shortcode !== shortcode),
      },
    }
  }),

  clear: (communityId) => {
    communityEpochs.set(communityId, (communityEpochs.get(communityId) ?? 0) + 1)
    inFlight.delete(communityId)
    set((state) => {
      revoke(state.byCommunity[communityId] ?? [])
      const byCommunity = { ...state.byCommunity }
      const loading = { ...state.loading }
      delete byCommunity[communityId]
      delete loading[communityId]
      return { byCommunity, loading }
    })
  },

  clearAll: () => {
    accountEpoch += 1
    communityEpochs.clear()
    inFlight.clear()
    set((state) => {
      for (const entries of Object.values(state.byCommunity)) revoke(entries)
      return { byCommunity: {}, loading: {} }
    })
  },
}))

export function useServerEmoji(communityId: string | null | undefined) {
  const entries = useServerEmojiStore((state) => (
    communityId ? state.byCommunity[communityId] ?? EMPTY_EMOJI : EMPTY_EMOJI
  ))
  const load = useServerEmojiStore((state) => state.load)

  useEffect(() => {
    if (communityId) void load(communityId)
  }, [communityId, load])

  return entries
}
