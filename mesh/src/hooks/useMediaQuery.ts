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
export const COMPACT_VIEWPORT_QUERY = '(max-width: 799px)'
