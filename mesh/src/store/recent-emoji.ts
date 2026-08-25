import { useSyncExternalStore } from 'react'
import { safeLocalStorageGet, safeLocalStorageSet } from '../lib/safe-storage'

/**
 * The user's recently used emoji, shared between the reaction picker and the
 * one-tap quick-react row so both stay in sync. Backed by localStorage under a
 * single key; every reaction (unicode glyph or `:shortcode:` custom emoji)
 * moves to the front, deduped and capped.
 */
const RECENTS_KEY = 'mesh:emoji:recent'
const RECENTS_LIMIT = 24

const listeners = new Set<() => void>()

function parseRecents(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string').slice(0, RECENTS_LIMIT)
  } catch {
    return []
  }
}

// getSnapshot must return a stable reference between changes, so cache the
// parsed array and only rebuild it when the stored string actually differs.
// Reading localStorage on every call (rather than a write-only cache) keeps the
// snapshot correct even when the store is seeded directly, which test setups do.
let cachedRaw: string | null = null
let cachedValue: string[] = []

function getSnapshot(): string[] {
  const raw = safeLocalStorageGet(RECENTS_KEY)
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedValue = parseRecents(raw)
  }
  return cachedValue
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function rememberEmoji(emoji: string): void {
  const next = [emoji, ...parseRecents(safeLocalStorageGet(RECENTS_KEY)).filter((c) => c !== emoji)]
    .slice(0, RECENTS_LIMIT)
  safeLocalStorageSet(RECENTS_KEY, JSON.stringify(next))
  // Refresh the cache immediately so subscribers re-render with the new value.
  cachedRaw = safeLocalStorageGet(RECENTS_KEY)
  cachedValue = next
  for (const listener of listeners) listener()
}

export function useRecentEmoji(): string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
