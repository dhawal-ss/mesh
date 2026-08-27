import { useCallback, useSyncExternalStore } from 'react'

/**
 * Subscribe to a media query as external state.
 *
 * Deliberately not an effect + setState pair: the compact/expanded decision has
 * to be correct on the very first render, and reading it during render avoids
 * the cascading-render warning that a `useEffect(() => setState(...))` version
 * produces.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )

  const getSnapshot = useCallback(() => {
    if (typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  }, [query])

  // The server snapshot is only reached in non-DOM test renders.
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** The breakpoint below which room navigation collapses into a drawer. */
/*
 * The width below which the room list is a drawer rather than a column.
 *
 * It rises with the list: an M3 row is a 56px pill carrying a leading glyph, a
 * headline and a trailing badge, so the list is 340px where it was 250px. At
 * the 800px minimum window a docked list left the conversation 336px and the
 * room name in the app bar truncated on its own title.
 */
export const COMPACT_VIEWPORT_QUERY = '(max-width: 999px)'

/** The breakpoint below which room context is presented as a modal drawer. */
export const ROOM_CONTEXT_COMPACT_QUERY = '(max-width: 1100px)'
