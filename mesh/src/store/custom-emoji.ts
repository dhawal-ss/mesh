import { useEffect } from 'react'
import { create } from 'zustand'
import * as bridge from '../lib/bridge'
import type { ServerEmoji } from '../types/ipc'

export interface LoadedServerEmoji extends ServerEmoji {
  imageUrl: string
}

interface ServerEmojiStore {
  byCommunity: Record<string, LoadedServerEmoji[]>
  loading: Record<string, boolean>
  load: (communityId: string, force?: boolean) => Promise<void>
  clear: (communityId: string) => void
}

const inFlight = new Map<string, Promise<void>>()
const EMPTY_EMOJI: LoadedServerEmoji[] = []

function revoke(entries: readonly LoadedServerEmoji[]) {
  for (const entry of entries) URL.revokeObjectURL(entry.imageUrl)
}

export const useServerEmojiStore = create<ServerEmojiStore>((set, get) => ({
  byCommunity: {},
  loading: {},

  load: async (communityId, force = false) => {
    if (!bridge.isMatrixBackend()) return
    if (!force && get().byCommunity[communityId]) return
    const existing = inFlight.get(communityId)
    if (existing) return existing

    const request = (async () => {
      set((state) => ({
        loading: { ...state.loading, [communityId]: true },
      }))
      try {
        const metadata = await bridge.listServerEmoji(communityId)
        const loaded = (
          await Promise.all(metadata.map(async (emoji) => {
            try {
              const bytes = await bridge.loadServerEmojiImage(
                communityId,
                emoji.shortcode,
              )
              return {
                ...emoji,
                imageUrl: URL.createObjectURL(
                  new Blob([bytes], { type: emoji.contentType }),
                ),
              }
            } catch {
              return null
            }
          }))
        ).filter((emoji): emoji is LoadedServerEmoji => emoji !== null)

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
        set((state) => ({
          byCommunity: {
            ...state.byCommunity,
            [communityId]: state.byCommunity[communityId] ?? [],
          },
          loading: { ...state.loading, [communityId]: false },
        }))
      } finally {
        inFlight.delete(communityId)
      }
    })()
    inFlight.set(communityId, request)
    return request
  },

  clear: (communityId) => set((state) => {
    revoke(state.byCommunity[communityId] ?? [])
    const byCommunity = { ...state.byCommunity }
    const loading = { ...state.loading }
    delete byCommunity[communityId]
    delete loading[communityId]
    return { byCommunity, loading }
  }),
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
