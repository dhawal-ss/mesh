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
})
