import { useEffect } from 'react'
import { create } from 'zustand'
import * as bridge from '../lib/bridge'
import type { ServerEmoji } from '../types/ipc'
import { registerAccountReset } from '../lib/account-reset-registry'

export interface LoadedServerEmoji extends ServerEmoji {
  imageUrl: string
}

interface ServerEmojiStore {
  byCommunity: Record<string, LoadedServerEmoji[]>
  loading: Record<string, boolean>
  /** Least-recently-loaded first; bounds how many communities stay resident. */
  communityRecency: string[]
  load: (communityId: string, force?: boolean) => Promise<void>
  clear: (communityId: string) => void
  clearAll: () => void
}

const inFlight = new Map<string, Promise<void>>()
const EMPTY_EMOJI: LoadedServerEmoji[] = []

/**
 * Emoji images are decoded into blob object URLs, which live off the JS heap
 * and are only released by an explicit revoke. Three communities is enough to
 * keep switching between neighbouring servers instant without pinning every
 * server a session ever touched.
 */
const MAX_CACHED_EMOJI_COMMUNITIES = 3

/** Ceiling on decoded emoji bytes held for a single community. */
const MAX_COMMUNITY_EMOJI_BYTES = 8 * 1024 * 1024

/** Assumed cost of an entry whose server-declared size is missing or absurd. */
const ASSUMED_EMOJI_BYTES = 64 * 1024

function revoke(entries: readonly LoadedServerEmoji[]) {
  for (const entry of entries) URL.revokeObjectURL(entry.imageUrl)
}

function declaredBytes(emoji: ServerEmoji): number {
  return Number.isFinite(emoji.sizeBytes) && emoji.sizeBytes > 0
    ? emoji.sizeBytes
    : ASSUMED_EMOJI_BYTES
}

/**
 * Take entries in server order until the next one would cross the byte cap.
 *
 * Stopping rather than skipping keeps the admitted set a stable prefix, so a
 * community whose pack is over budget shows the same emoji on every load.
 */
function admitWithinByteCap(metadata: readonly ServerEmoji[]): ServerEmoji[] {
  const admitted: ServerEmoji[] = []
  let totalBytes = 0
  for (const emoji of metadata) {
    const size = declaredBytes(emoji)
    if (totalBytes + size > MAX_COMMUNITY_EMOJI_BYTES) break
    totalBytes += size
    admitted.push(emoji)
  }
  return admitted
}

export const useServerEmojiStore = create<ServerEmojiStore>((set, get) => ({
  byCommunity: {},
  loading: {},
  communityRecency: [],

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
          await Promise.all(admitWithinByteCap(metadata).map(async (emoji) => {
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
          return retainEmojiCommunity(state, communityId, {
            byCommunity: {
              ...state.byCommunity,
              [communityId]: loaded,
            },
            loading: { ...state.loading, [communityId]: false },
          })
        })
      } catch {
        set((state) => retainEmojiCommunity(state, communityId, {
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
    return {
      byCommunity,
      loading,
      communityRecency: state.communityRecency.filter((id) => id !== communityId),
    }
  }),

  clearAll: () => set((state) => {
    for (const entries of Object.values(state.byCommunity)) revoke(entries)
    return { byCommunity: {}, loading: {}, communityRecency: [] }
  }),
}))

type EmojiCacheState = Pick<ServerEmojiStore, 'byCommunity' | 'loading' | 'communityRecency'>

function retainEmojiCommunity(
  state: EmojiCacheState,
  communityId: string,
  patch: Pick<EmojiCacheState, 'byCommunity' | 'loading'>,
): EmojiCacheState {
  const communityRecency = [
    ...state.communityRecency.filter((cachedId) => cachedId !== communityId),
    communityId,
  ]
  const evictedIds = communityRecency.slice(0, -MAX_CACHED_EMOJI_COMMUNITIES)
  if (evictedIds.length === 0) {
    return { ...patch, communityRecency }
  }

  const byCommunity = { ...patch.byCommunity }
  const loading = { ...patch.loading }
  for (const evictedId of evictedIds) {
    revoke(byCommunity[evictedId] ?? [])
    delete byCommunity[evictedId]
    delete loading[evictedId]
  }
  return {
    byCommunity,
    loading,
    communityRecency: communityRecency.slice(-MAX_CACHED_EMOJI_COMMUNITIES),
  }
}

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

registerAccountReset('custom-emoji', () => {
  // Emoji images are blob object URLs: without an explicit revoke they stay
  // resident off-heap for the life of the process, across account switches. A
  // resolved image is also readable content the next account has no claim to,
  // so dropping it is not only a memory concern.
  useServerEmojiStore.getState().clearAll()
})
