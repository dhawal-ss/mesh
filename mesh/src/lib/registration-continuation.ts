import {
  getSafeLocalStorage,
  safeStorageRead,
  safeStorageRemove,
  safeStorageSet,
  type StorageLike,
} from './safe-storage'

export const REGISTRATION_CONTINUATION_STORAGE_KEY =
  'mesh-registration-continuation-v1'
const USED_REGISTRATION_CORRELATIONS_STORAGE_KEY =
  'mesh-registration-continuation-used-v1'

export const REGISTRATION_CONTINUATION_TTL_MS = 2 * 60 * 60 * 1_000

const MAX_CLOCK_SKEW_MS = 60_000
const MAX_RECORD_BYTES = 2_048
const MAX_USED_RECORD_BYTES = 4_096
const MAX_USED_CORRELATIONS = 32
const SERVICE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SERVICE_ADDRESS_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const INVITATION_TARGET_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const CORRELATION_PATTERN = /^[A-Za-z0-9_-]{32,64}$/

export interface RegistrationContinuation {
  version: 1
  invitationTarget: string | null
  accountServiceId: string
  accountServiceAddress: string
  flowStep: 'external-registration'
  createdAt: number
  expiresAt: number
  correlation: string
}

export type RegistrationContinuationInspection =
  | { status: 'ready'; continuation: RegistrationContinuation }
  | { status: 'empty' | 'expired' | 'malformed' | 'replayed' | 'unavailable' }

export type RegistrationContinuationConsumption =
  | { status: 'consumed'; continuation: RegistrationContinuation }
  | {
      status:
        | 'empty'
        | 'expired'
        | 'malformed'
        | 'replayed'
        | 'unavailable'
        | 'mismatch'
    }

interface UsedCorrelation {
  correlation: string
  expiresAt: number
}

type UsedCorrelationsInspection =
  | { status: 'ready'; correlations: UsedCorrelation[] }
  | { status: 'malformed' }
  | { status: 'unavailable' }

function defaultStorage(): StorageLike | null {
  return getSafeLocalStorage()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validContinuation(
  value: unknown,
  now: number,
): value is RegistrationContinuation {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (
    keys.length !== 8
    || ![
      'version',
      'invitationTarget',
      'accountServiceId',
      'accountServiceAddress',
      'flowStep',
      'createdAt',
      'expiresAt',
      'correlation',
    ].every((key) => keys.includes(key))
  ) {
    return false
  }

  if (
    value.version !== 1
    || value.flowStep !== 'external-registration'
    || typeof value.accountServiceId !== 'string'
    || !SERVICE_ID_PATTERN.test(value.accountServiceId)
    || typeof value.accountServiceAddress !== 'string'
    || !SERVICE_ADDRESS_PATTERN.test(value.accountServiceAddress)
    || typeof value.correlation !== 'string'
    || !CORRELATION_PATTERN.test(value.correlation)
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.expiresAt)
  ) {
    return false
  }

  if (
    value.invitationTarget !== null
    && (
      typeof value.invitationTarget !== 'string'
      || !INVITATION_TARGET_PATTERN.test(value.invitationTarget)
    )
  ) {
    return false
  }

  return value.createdAt <= now + MAX_CLOCK_SKEW_MS
    && value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= REGISTRATION_CONTINUATION_TTL_MS
}

function randomCorrelation(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure continuation state is unavailable in this runtime.')
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function readUsedCorrelations(
  storage: StorageLike,
  now: number,
): UsedCorrelationsInspection {
  const read = safeStorageRead(storage, USED_REGISTRATION_CORRELATIONS_STORAGE_KEY)
  if (!read.ok) return { status: 'unavailable' }
  const raw = read.value
  if (!raw) return { status: 'ready', correlations: [] }
  if (raw.length > MAX_USED_RECORD_BYTES) {
    safeStorageRemove(storage, USED_REGISTRATION_CORRELATIONS_STORAGE_KEY)
    return { status: 'malformed' }
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('invalid used-correlation record')
    if (!parsed.every((candidate): candidate is UsedCorrelation => (
      isRecord(candidate)
      && Object.keys(candidate).length === 2
      && typeof candidate.correlation === 'string'
      && CORRELATION_PATTERN.test(candidate.correlation)
      && validTimestamp(candidate.expiresAt)
    ))) {
      throw new Error('invalid used-correlation entry')
    }
    return {
      status: 'ready',
      correlations: parsed
        .filter((candidate) => candidate.expiresAt > now)
        .slice(-MAX_USED_CORRELATIONS),
    }
  } catch {
    safeStorageRemove(storage, USED_REGISTRATION_CORRELATIONS_STORAGE_KEY)
    return { status: 'malformed' }
  }
}

function rememberUsedCorrelation(
  storage: StorageLike,
  continuation: RegistrationContinuation,
  now: number,
): boolean {
  const inspected = readUsedCorrelations(storage, now)
  if (inspected.status !== 'ready') return false
  const used = inspected.correlations
    .filter((candidate) => candidate.correlation !== continuation.correlation)
  used.push({
    correlation: continuation.correlation,
    expiresAt: Math.max(continuation.expiresAt, now + REGISTRATION_CONTINUATION_TTL_MS),
  })
  return safeStorageSet(
    storage,
    USED_REGISTRATION_CORRELATIONS_STORAGE_KEY,
    JSON.stringify(used.slice(-MAX_USED_CORRELATIONS)),
  )
}

export function createRegistrationContinuation(
  input: {
    invitationTarget: string | null
    accountServiceId: string
    accountServiceAddress: string
  },
  now = Date.now(),
  storage = defaultStorage(),
): RegistrationContinuation {
  if (!storage) {
    throw new Error('Mesh could not save the registration return on this device.')
  }
  if (readUsedCorrelations(storage, now).status !== 'ready') {
    throw new Error('Mesh could not save the registration return on this device.')
  }
  const continuation: RegistrationContinuation = {
    version: 1,
    invitationTarget: input.invitationTarget,
    accountServiceId: input.accountServiceId.trim(),
    accountServiceAddress: input.accountServiceAddress.trim().toLowerCase(),
    flowStep: 'external-registration',
    createdAt: now,
    expiresAt: now + REGISTRATION_CONTINUATION_TTL_MS,
    correlation: randomCorrelation(),
  }
  if (!validContinuation(continuation, now)) {
    throw new Error('Mesh refused to save invalid registration return state.')
  }

  if (!safeStorageSet(
    storage,
    REGISTRATION_CONTINUATION_STORAGE_KEY,
    JSON.stringify(continuation),
  )) {
    throw new Error('Mesh could not save the registration return on this device.')
  }
  return continuation
}

export function inspectRegistrationContinuation(
  now = Date.now(),
  storage = defaultStorage(),
): RegistrationContinuationInspection {
  if (!storage) return { status: 'unavailable' }

  const read = safeStorageRead(storage, REGISTRATION_CONTINUATION_STORAGE_KEY)
  if (!read.ok) return { status: 'unavailable' }
  const raw = read.value
  if (!raw) return { status: 'empty' }
  if (raw.length > MAX_RECORD_BYTES) {
    safeStorageRemove(storage, REGISTRATION_CONTINUATION_STORAGE_KEY)
    return { status: 'malformed' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    safeStorageRemove(storage, REGISTRATION_CONTINUATION_STORAGE_KEY)
    return { status: 'malformed' }
  }
  if (!validContinuation(parsed, now)) {
    safeStorageRemove(storage, REGISTRATION_CONTINUATION_STORAGE_KEY)
    return { status: 'malformed' }
  }
  if (parsed.expiresAt <= now) {
    rememberUsedCorrelation(storage, parsed, now)
    safeStorageRemove(storage, REGISTRATION_CONTINUATION_STORAGE_KEY)
    return { status: 'expired' }
  }
  const used = readUsedCorrelations(storage, now)
  if (used.status === 'unavailable') return { status: 'unavailable' }
  if (used.status === 'malformed') {
    safeStorageRemove(storage, REGISTRATION_CONTINUATION_STORAGE_KEY)
    return { status: 'malformed' }
  }
  if (used.correlations.some((candidate) => candidate.correlation === parsed.correlation)) {
    safeStorageRemove(storage, REGISTRATION_CONTINUATION_STORAGE_KEY)
    return { status: 'replayed' }
  }
  return { status: 'ready', continuation: parsed }
}

export function consumeRegistrationContinuation(
  expectedCorrelation: string,
  now = Date.now(),
  storage = defaultStorage(),
): RegistrationContinuationConsumption {
  const inspected = inspectRegistrationContinuation(now, storage)
  if (inspected.status !== 'ready') return inspected
  if (inspected.continuation.correlation !== expectedCorrelation) {
    return { status: 'mismatch' }
  }
  if (!storage) return { status: 'unavailable' }

  if (!rememberUsedCorrelation(storage, inspected.continuation, now)) {
    return { status: 'unavailable' }
  }
  // The replay tombstone is the security boundary. Removing the consumed
  // payload is privacy cleanup and remains best-effort once that tombstone is
  // durable; a leftover record will be rejected as replayed on the next read.
  safeStorageRemove(storage, REGISTRATION_CONTINUATION_STORAGE_KEY)
  return { status: 'consumed', continuation: inspected.continuation }
}

export function clearRegistrationContinuation(
  now = Date.now(),
  storage = defaultStorage(),
): void {
  if (!storage) return
  const inspected = inspectRegistrationContinuation(now, storage)
  if (inspected.status === 'ready') {
    rememberUsedCorrelation(storage, inspected.continuation, now)
  }
  safeStorageRemove(storage, REGISTRATION_CONTINUATION_STORAGE_KEY)
}
