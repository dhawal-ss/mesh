export const CONTEXT_SIDEBAR_WIDTH_KEY = 'mesh-layout-context-sidebar-width'
export const ROOM_CONTEXT_WIDTH_KEY = 'mesh-layout-room-context-width'
export const ROOM_CONTEXT_OPEN_KEY = 'mesh-layout-room-context-open'

export function clampPanelWidth(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

export function readStoredPanelWidth(
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof window === 'undefined') return fallback
  try {
    const stored = Number(window.localStorage.getItem(key))
    return Number.isFinite(stored)
      ? clampPanelWidth(stored, minimum, maximum)
      : fallback
  } catch {
    return fallback
  }
}

export function writeStoredPanelWidth(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // Layout remains usable when storage is disabled.
  }
}

export function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  try {
    const value = window.localStorage.getItem(key)
    return value === null ? fallback : value === 'true'
  } catch {
    return fallback
  }
}

export function writeStoredBoolean(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // Layout remains usable when storage is disabled.
  }
}
