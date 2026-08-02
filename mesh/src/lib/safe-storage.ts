export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type StorageReadResult =
  | { ok: true; value: string | null }
  | { ok: false }

type StorageKind = 'localStorage' | 'sessionStorage'

function browserStorage(kind: StorageKind): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window[kind]
  } catch {
    // Browsers can deny the storage property itself in hardened/private contexts.
    return null
  }
}

export function getSafeLocalStorage(): Storage | null {
  return browserStorage('localStorage')
}

export function getSafeSessionStorage(): Storage | null {
  return browserStorage('sessionStorage')
}

export function safeStorageGet(
  storage: StorageLike | null | undefined,
  key: string,
): string | null {
  const result = safeStorageRead(storage, key)
  return result.ok ? result.value : null
}

export function safeStorageRead(
  storage: StorageLike | null | undefined,
  key: string,
): StorageReadResult {
  try {
    if (!storage) return { ok: false }
    return { ok: true, value: storage.getItem(key) }
  } catch {
    return { ok: false }
  }
}

export function safeStorageSet(
  storage: StorageLike | null | undefined,
  key: string,
  value: string,
): boolean {
  try {
    if (!storage) return false
    storage.setItem(key, value)
    return true
  } catch {
    // Quota, privacy, and policy failures must not take down the app shell.
    return false
  }
}

export function safeStorageRemove(
  storage: StorageLike | null | undefined,
  key: string,
): boolean {
  try {
    if (!storage) return false
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

export function safeLocalStorageGet(key: string): string | null {
  return safeStorageGet(getSafeLocalStorage(), key)
}

export function safeLocalStorageSet(key: string, value: string): boolean {
  return safeStorageSet(getSafeLocalStorage(), key, value)
}

export function safeLocalStorageRemove(key: string): boolean {
  return safeStorageRemove(getSafeLocalStorage(), key)
}

export function safeSessionStorageGet(key: string): string | null {
  return safeStorageGet(getSafeSessionStorage(), key)
}

export function safeSessionStorageSet(key: string, value: string): boolean {
  return safeStorageSet(getSafeSessionStorage(), key, value)
}

export function safeSessionStorageRemove(key: string): boolean {
  return safeStorageRemove(getSafeSessionStorage(), key)
}

/**
 * Adapt browser storage to APIs such as Zustand persistence that expect
 * storage methods not to throw. The browser storage object is resolved for
 * every operation because privacy policy can change while the app is open.
 */
export function createSafeStorageAdapter(
  getStorage: () => StorageLike | null | undefined,
): StorageLike {
  const storage = () => {
    try {
      return getStorage()
    } catch {
      return null
    }
  }
  return {
    getItem: (key) => safeStorageGet(storage(), key),
    setItem: (key, value) => { safeStorageSet(storage(), key, value) },
    removeItem: (key) => { safeStorageRemove(storage(), key) },
  }
}
