import { safeLocalStorageGet, safeLocalStorageSet } from './safe-storage'

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
  const serialized = safeLocalStorageGet(key)
  if (serialized === null) return fallback
  const stored = Number(serialized)
  return Number.isFinite(stored)
    ? clampPanelWidth(stored, minimum, maximum)
    : fallback
}

export function writeStoredPanelWidth(key: string, value: number) {
  safeLocalStorageSet(key, String(value))
}

export function readStoredBoolean(key: string, fallback: boolean): boolean {
  const value = safeLocalStorageGet(key)
  return value === null ? fallback : value === 'true'
}

export function writeStoredBoolean(key: string, value: boolean) {
  safeLocalStorageSet(key, String(value))
}
