import { useEffect } from 'react'
import { create } from 'zustand'

import * as bridge from '../lib/bridge'
import {
  admitAvatar,
  isMxcUri,
  MAX_CACHED_AVATARS,
  touchAvatar,
} from '../lib/matrix-avatar-source'
import { registerAccountReset } from '../lib/account-reset-registry'

/*
    Resolved profile pictures, keyed by MXC URI.

    Keyed by URI rather than by user: the URI already changes when someone
    replaces their picture, so a new address is a new entry and a stale one ages
    out on its own. Keying by user would need an invalidation signal Mesh does
    not have.
*/

type AvatarStatus = 'loading' | 'ready' | 'failed'

interface AvatarEntry {
  status: AvatarStatus
  /** An object URL while `ready`, `null` otherwise. */
  objectUrl: string | null
}

interface MatrixAvatarStore {
  entries: Record<string, AvatarEntry>
  /** Most recently used first. See `admitAvatar`. */
  recency: string[]
  /**
   * Starts resolving `mxcUri` unless it is already resolved or in flight.
   *
   * Deliberately returns nothing: callers read the result out of `entries`, so
   * one load serves every element showing the same picture.
   */
  resolve: (mxcUri: string) => void
  /** Revokes every held object URL and empties the cache. */
  clearAll: () => void
}

/*
    In-flight loads live outside the store, exactly as `custom-emoji.ts` does
    it. A promise is not renderer state and putting one in the store would make
    every subscriber re-render when it settles rather than when the bytes are
    ready.
*/
const inFlight = new Map<string, Promise<void>>()

/*
    Which pictures are on screen, counted because many elements can show the
    same one. Eviction skips these: revoking an object URL an `img` is still
    using leaves a broken image, and `Avatar` renders that as the generated
    mark, so the picture would vanish from a row that is looking at it with
    nothing to explain why. Outside the store for the same reason as `inFlight`:
    a mount count is not something a subscriber should re-render for.
*/
const mountedAvatars = new Map<string, number>()

/**
 * Holds `mxcUri` on screen until the matching `releaseAvatar`.
 *
 * `useResolvedAvatarImage` is the caller; anything else rendering a resolved
 * picture without that hook has to pair these itself.
 */
export function retainAvatar(mxcUri: string): void {
  mountedAvatars.set(mxcUri, (mountedAvatars.get(mxcUri) ?? 0) + 1)
}

/** Releases one hold taken by `retainAvatar`. */
export function releaseAvatar(mxcUri: string): void {
  const held = mountedAvatars.get(mxcUri)
  if (held === undefined) return
  if (held > 1) mountedAvatars.set(mxcUri, held - 1)
  else mountedAvatars.delete(mxcUri)
}

function revokeObjectUrl(url: string | null): void {
  if (!url) return
  // jsdom, and any non-browser host, has no object-URL implementation.
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  URL.revokeObjectURL(url)
}

export const useMatrixAvatarStore = create<MatrixAvatarStore>((set, get) => ({
  entries: {},
  recency: [],

  resolve: (mxcUri) => {
    if (!isMxcUri(mxcUri)) return
    const existing = get().entries[mxcUri]
    if (existing) {
      // A hit still counts as use, or a picture that stays on screen ages out
      // while entries nobody is looking at survive.
      set((state) => ({ recency: touchAvatar(state.recency, mxcUri) }))
      return
    }
    if (inFlight.has(mxcUri)) return
    /*
        Outside a Matrix session there is nothing to ask. Recording `failed`
        rather than leaving the entry absent matters: absent means "not tried
        yet", so an element would ask again on every render.
    */
    if (!bridge.isMatrixBackend()) {
      set((state) => ({
        entries: { ...state.entries, [mxcUri]: { status: 'failed', objectUrl: null } },
      }))
      return
    }

    set((state) => {
      const { recency, evicted } = admitAvatar(
        state.recency,
        mxcUri,
        MAX_CACHED_AVATARS,
        new Set(mountedAvatars.keys()),
      )
      const entries = { ...state.entries, [mxcUri]: { status: 'loading' as const, objectUrl: null } }
      for (const key of evicted) {
        revokeObjectUrl(entries[key]?.objectUrl ?? null)
        delete entries[key]
      }
      return { entries, recency }
    })

    const request = (async () => {
      try {
        const bytes = await bridge.matrixLoadProfileAvatar(mxcUri)
        // Always PNG: `load_profile_avatar_image` re-encodes whatever the
        // sender uploaded before it reaches the renderer.
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        set((state) => {
          /*
              An eviction or an account switch can land between the request and
              its bytes. Writing the entry back then would resurrect a key the
              cache already dropped and leak the object URL with it, since
              nothing would revoke it afterwards.
          */
          if (!state.entries[mxcUri]) {
            revokeObjectUrl(objectUrl)
            return state
          }
          return {
            entries: { ...state.entries, [mxcUri]: { status: 'ready', objectUrl } },
          }
        })
      } catch {
        /*
            A picture that will not load is not an error a person can act on:
            they see the generated mark, which is what they saw before anyone
            set a picture. Recording the failure stops the retry loop.
        */
        set((state) => (
          state.entries[mxcUri]
            ? { entries: { ...state.entries, [mxcUri]: { status: 'failed', objectUrl: null } } }
            : state
        ))
      } finally {
        inFlight.delete(mxcUri)
      }
    })()
    inFlight.set(mxcUri, request)
  },

  clearAll: () => {
    for (const entry of Object.values(get().entries)) revokeObjectUrl(entry.objectUrl)
    inFlight.clear()
    set({ entries: {}, recency: [] })
  },
}))

/**
 * The image source an element should use for `imageUrl`.
 *
 * A non-MXC value is returned unchanged, so this is safe to call for any image
 * source. An MXC URI returns the resolved object URL once it is ready, and
 * `null` while it loads or after it fails, which `Avatar` renders as the
 * generated mark rather than as an error.
 */
export function useResolvedAvatarImage(
  imageUrl: string | null | undefined,
): string | null | undefined {
  const needsResolving = isMxcUri(imageUrl)
  const resolve = useMatrixAvatarStore((state) => state.resolve)
  const resolved = useMatrixAvatarStore((state) => (
    needsResolving ? state.entries[imageUrl as string]?.objectUrl ?? null : null
  ))

  useEffect(() => {
    if (!needsResolving) return
    const mxcUri = imageUrl as string
    // Held for as long as this element is mounted, so a busier screen elsewhere
    // cannot evict the picture out from under it.
    retainAvatar(mxcUri)
    resolve(mxcUri)
    return () => releaseAvatar(mxcUri)
  }, [needsResolving, imageUrl, resolve])

  return needsResolving ? resolved : imageUrl
}

registerAccountReset('matrix-avatars', () => {
  // Profile pictures are blob object URLs; see custom-emoji for why both the
  // memory and the content matter.
  useMatrixAvatarStore.getState().clearAll()
})
