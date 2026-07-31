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

function defaultStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
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

function readUsedCorrelations(storage: Storage, now: number): UsedCorrelation[] {
  let raw: string | null
  try {
    raw = storage.getItem(USED_REGISTRATION_CORRELATIONS_STORAGE_KEY)
  } catch {
    return []
  }
  if (!raw || raw.length > MAX_USED_RECORD_BYTES) {
    if (raw) storage.removeItem(USED_REGISTRATION_CORRELATIONS_STORAGE_KEY)
    return []
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('invalid used-correlation record')
    return parsed
      .filter((candidate): candidate is UsedCorrelation => (
        isRecord(candidate)
        && Object.keys(candidate).length === 2
        && typeof candidate.correlation === 'string'
        && CORRELATION_PATTERN.test(candidate.correlation)
        && validTimestamp(candidate.expiresAt)
        && candidate.expiresAt > now
      ))
      .slice(-MAX_USED_CORRELATIONS)
  } catch {
    storage.removeItem(USED_REGISTRATION_CORRELATIONS_STORAGE_KEY)
    return []
  }
}

function rememberUsedCorrelation(
  storage: Storage,
  continuation: RegistrationContinuation,
  now: number,
): void {
  const used = readUsedCorrelations(storage, now)
    .filter((candidate) => candidate.correlation !== continuation.correlation)
  used.push({
    correlation: continuation.correlation,
    expiresAt: Math.max(continuation.expiresAt, now + REGISTRATION_CONTINUATION_TTL_MS),
  })
  storage.setItem(
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

  try {
    storage.setItem(
      REGISTRATION_CONTINUATION_STORAGE_KEY,
      JSON.stringify(continuation),
    )
  } catch {
    throw new Error('Mesh could not save the registration return on this device.')
  }
  return continuation
}

export function inspectRegistrationContinuation(
  now = Date.now(),
  storage = defaultStorage(),
): RegistrationContinuationInspection {
  if (!storage) return { status: 'unavailable' }

  let raw: string | null
  try {
    raw = storage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
  } catch {
    return { status: 'unavailable' }
  }
  if (!raw) return { status: 'empty' }
  if (raw.length > MAX_RECORD_BYTES) {
    storage.removeItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
    return { status: 'malformed' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    storage.removeItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
    return { status: 'malformed' }
  }
  if (!validContinuation(parsed, now)) {
    storage.removeItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
    return { status: 'malformed' }
  }
  if (parsed.expiresAt <= now) {
    rememberUsedCorrelation(storage, parsed, now)
    storage.removeItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
    return { status: 'expired' }
  }
  if (
    readUsedCorrelations(storage, now)
      .some((candidate) => candidate.correlation === parsed.correlation)
  ) {
    storage.removeItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
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

  try {
    rememberUsedCorrelation(storage, inspected.continuation, now)
    storage.removeItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
  } catch {
    return { status: 'unavailable' }
  }
  return { status: 'consumed', continuation: inspected.continuation }
}

export function clearRegistrationContinuation(
  now = Date.now(),
  storage = defaultStorage(),
): void {
  if (!storage) return
  const inspected = inspectRegistrationContinuation(now, storage)
  try {
    if (inspected.status === 'ready') {
      rememberUsedCorrelation(storage, inspected.continuation, now)
    }
    storage.removeItem(REGISTRATION_CONTINUATION_STORAGE_KEY)
  } catch {
    // Best-effort cleanup is appropriate when storage has become unavailable.
  }
}
