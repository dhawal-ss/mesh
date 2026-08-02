import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REGISTRATION_CONTINUATION_STORAGE_KEY,
  REGISTRATION_CONTINUATION_TTL_MS,
  clearRegistrationContinuation,
  consumeRegistrationContinuation,
  createRegistrationContinuation,
  inspectRegistrationContinuation,
} from './registration-continuation'

describe('registration continuation', () => {
  const now = 1_786_000_000_000

  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('persists only bounded, non-secret resume state', () => {
    const continuation = createRegistrationContinuation({
      invitationTarget: 'd283967b-e094-460c-bf06-fbe068c21d5b',
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    }, now)

    const raw = window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(raw).not.toContain('mesh://')
    expect(raw).not.toContain('registration_token')
    expect(raw).not.toContain('password')
    expect(continuation.expiresAt).toBe(now + REGISTRATION_CONTINUATION_TTL_MS)
    expect(inspectRegistrationContinuation(now)).toEqual({
      status: 'ready',
      continuation,
    })
  })

  it('expires fail closed and clears the pending record', () => {
    createRegistrationContinuation({
      invitationTarget: null,
      accountServiceId: 'tchncs-de',
      accountServiceAddress: 'tchncs.de',
    }, now)

    expect(inspectRegistrationContinuation(now + REGISTRATION_CONTINUATION_TTL_MS))
      .toEqual({ status: 'expired' })
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBeNull()
  })

  it('rejects malformed persisted state without exposing it', () => {
    window.localStorage.setItem(
      REGISTRATION_CONTINUATION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        invitationTarget: 'mesh://join?secret=do-not-store',
        accountServiceId: 'matrix-org',
      }),
    )

    expect(inspectRegistrationContinuation(now)).toEqual({ status: 'malformed' })
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBeNull()
  })

  it('consumes a matching correlation exactly once and rejects replay', () => {
    const continuation = createRegistrationContinuation({
      invitationTarget: 'opaque-native-handle',
      accountServiceId: 'quassel-io',
      accountServiceAddress: 'quassel.io',
    }, now)
    const savedRecord = window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)

    expect(consumeRegistrationContinuation(continuation.correlation, now)).toEqual({
      status: 'consumed',
      continuation,
    })
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBeNull()

    window.localStorage.setItem(
      REGISTRATION_CONTINUATION_STORAGE_KEY,
      savedRecord ?? '',
    )
    expect(inspectRegistrationContinuation(now)).toEqual({ status: 'replayed' })
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBeNull()
  })

  it('does not consume a newer continuation through a stale correlation', () => {
    const continuation = createRegistrationContinuation({
      invitationTarget: null,
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    }, now)

    expect(consumeRegistrationContinuation(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      now,
    )).toEqual({ status: 'mismatch' })
    expect(inspectRegistrationContinuation(now)).toEqual({
      status: 'ready',
      continuation,
    })
  })

  it('clears active continuation state and tombstones its correlation', () => {
    const continuation = createRegistrationContinuation({
      invitationTarget: null,
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    }, now)
    const savedRecord = window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)

    clearRegistrationContinuation(now)
    window.localStorage.setItem(
      REGISTRATION_CONTINUATION_STORAGE_KEY,
      savedRecord ?? '',
    )

    expect(continuation.correlation).toHaveLength(48)
    expect(inspectRegistrationContinuation(now)).toEqual({ status: 'replayed' })
  })

  it('fails closed when the replay ledger cannot be read', () => {
    createRegistrationContinuation({
      invitationTarget: 'opaque-native-handle',
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    }, now)
    const savedRecord = window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
    const storage = {
      getItem: vi.fn((key: string) => {
        if (key === REGISTRATION_CONTINUATION_STORAGE_KEY) return savedRecord
        throw new DOMException('denied', 'SecurityError')
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }

    expect(inspectRegistrationContinuation(now, storage)).toEqual({ status: 'unavailable' })
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('does not start a continuation when the replay ledger is unavailable', () => {
    const storage = {
      getItem: vi.fn(() => { throw new DOMException('denied', 'SecurityError') }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }

    expect(() => createRegistrationContinuation({
      invitationTarget: null,
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    }, now, storage)).toThrow('could not save the registration return')
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('does not report a continuation consumed when its replay tombstone cannot be written', () => {
    const continuation = createRegistrationContinuation({
      invitationTarget: null,
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    }, now)
    const savedRecord = window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
    const values = new Map<string, string>()
    if (savedRecord) values.set(REGISTRATION_CONTINUATION_STORAGE_KEY, savedRecord)
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        if (key !== REGISTRATION_CONTINUATION_STORAGE_KEY) {
          throw new DOMException('quota', 'QuotaExceededError')
        }
        values.set(key, value)
      }),
      removeItem: vi.fn((key: string) => { values.delete(key) }),
    }

    expect(consumeRegistrationContinuation(continuation.correlation, now, storage))
      .toEqual({ status: 'unavailable' })
    expect(values.get(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBe(savedRecord)
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('consumes after the replay tombstone is durable even if payload cleanup is denied', () => {
    const continuation = createRegistrationContinuation({
      invitationTarget: null,
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    }, now)
    const savedRecord = window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
    const values = new Map<string, string>()
    if (savedRecord) values.set(REGISTRATION_CONTINUATION_STORAGE_KEY, savedRecord)
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
      removeItem: vi.fn(() => { throw new DOMException('denied', 'SecurityError') }),
    }

    expect(consumeRegistrationContinuation(continuation.correlation, now, storage)).toEqual({
      status: 'consumed',
      continuation,
    })
    expect(inspectRegistrationContinuation(now, storage)).toEqual({ status: 'replayed' })
  })

  it('handles malformed and expired records when cleanup is denied', () => {
    const cleanupDenied = {
      getItem: vi.fn((key: string) => (
        key === REGISTRATION_CONTINUATION_STORAGE_KEY ? '{not-json' : null
      )),
      setItem: vi.fn(() => { throw new DOMException('quota', 'QuotaExceededError') }),
      removeItem: vi.fn(() => { throw new DOMException('denied', 'SecurityError') }),
    }
    expect(() => inspectRegistrationContinuation(now, cleanupDenied)).not.toThrow()
    expect(inspectRegistrationContinuation(now, cleanupDenied)).toEqual({ status: 'malformed' })

    createRegistrationContinuation({
      invitationTarget: null,
      accountServiceId: 'tchncs-de',
      accountServiceAddress: 'tchncs.de',
    }, now)
    const savedRecord = window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
    const expiredCleanupDenied = {
      getItem: vi.fn((key: string) => (
        key === REGISTRATION_CONTINUATION_STORAGE_KEY ? savedRecord : null
      )),
      setItem: vi.fn(() => { throw new DOMException('quota', 'QuotaExceededError') }),
      removeItem: vi.fn(() => { throw new DOMException('denied', 'SecurityError') }),
    }

    expect(inspectRegistrationContinuation(
      now + REGISTRATION_CONTINUATION_TTL_MS,
      expiredCleanupDenied,
    )).toEqual({ status: 'expired' })
    expect(() => clearRegistrationContinuation(now, expiredCleanupDenied)).not.toThrow()
  })

  it('invalidates the active continuation when the replay ledger is malformed', () => {
    createRegistrationContinuation({
      invitationTarget: null,
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    }, now)
    const savedRecord = window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
    const values = new Map<string, string>([
      [REGISTRATION_CONTINUATION_STORAGE_KEY, savedRecord ?? ''],
      ['mesh-registration-continuation-used-v1', '[{"correlation":"invalid"}]'],
    ])
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
      removeItem: vi.fn((key: string) => { values.delete(key) }),
    }

    expect(inspectRegistrationContinuation(now, storage)).toEqual({ status: 'malformed' })
    expect(values.has(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBe(false)
  })
})
