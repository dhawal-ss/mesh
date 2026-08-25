import { useSyncExternalStore } from 'react'
import { useSettingsStore } from '../store/settings'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribe(onStoreChange: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY)
  mediaQuery.addEventListener('change', onStoreChange)
  return () => mediaQuery.removeEventListener('change', onStoreChange)
}

function snapshot() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(REDUCED_MOTION_QUERY).matches
}

export function useReducedMotionPreference() {
  const operatingSystemPrefersReducedMotion = useSyncExternalStore(subscribe, snapshot, () => false)
  const meshReducedMotion = useSettingsStore((state) => state.appearance.reduceMotion)
  return operatingSystemPrefersReducedMotion || meshReducedMotion
}
