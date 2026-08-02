import { describe, expect, it, vi } from 'vitest'
import {
  createSafeStorageAdapter,
  safeStorageRead,
  safeStorageGet,
  safeStorageRemove,
  safeStorageSet,
} from './safe-storage'

describe('safe storage', () => {
  it('treats storage denial as an unavailable optional cache', () => {
    const denied = {
      getItem: vi.fn(() => { throw new DOMException('denied', 'SecurityError') }),
      setItem: vi.fn(() => { throw new DOMException('denied', 'SecurityError') }),
      removeItem: vi.fn(() => { throw new DOMException('denied', 'SecurityError') }),
    }

    expect(safeStorageGet(denied, 'state')).toBeNull()
    expect(safeStorageRead(denied, 'state')).toEqual({ ok: false })
    expect(safeStorageSet(denied, 'state', '{}')).toBe(false)
    expect(safeStorageRemove(denied, 'state')).toBe(false)
  })

  it('treats quota failures as non-fatal and reports successful operations', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === 'full') throw new DOMException('quota', 'QuotaExceededError')
        values.set(key, value)
      },
      removeItem: (key: string) => { values.delete(key) },
    }

    expect(safeStorageSet(storage, 'state', '{"ok":true}')).toBe(true)
    expect(safeStorageGet(storage, 'state')).toBe('{"ok":true}')
    expect(safeStorageSet(storage, 'full', 'x')).toBe(false)
    expect(safeStorageRemove(storage, 'state')).toBe(true)
    expect(safeStorageGet(storage, 'state')).toBeNull()
  })

  it('adapts a changing or throwing storage provider to non-throwing methods', () => {
    const denied = {
      getItem: vi.fn(() => { throw new DOMException('denied', 'SecurityError') }),
      setItem: vi.fn(() => { throw new DOMException('quota', 'QuotaExceededError') }),
      removeItem: vi.fn(() => { throw new DOMException('denied', 'SecurityError') }),
    }
    const adapter = createSafeStorageAdapter(() => denied)

    expect(adapter.getItem('state')).toBeNull()
    expect(() => adapter.setItem('state', '{}')).not.toThrow()
    expect(() => adapter.removeItem('state')).not.toThrow()

    const unavailable = createSafeStorageAdapter(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(unavailable.getItem('state')).toBeNull()
    expect(() => unavailable.setItem('state', '{}')).not.toThrow()
  })
})
