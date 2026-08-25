import {
  safeLocalStorageGet,
  safeLocalStorageRemove,
  safeLocalStorageSet,
} from './safe-storage'
import { MESH_APP_VERSION } from './beta-release'

export const MAX_RUNTIME_ERROR_RECORDS = 20
export const MAX_RUNTIME_ERROR_REPORT_BYTES = 8 * 1024

const STORAGE_KEY = 'mesh-runtime-errors-v1'

export type RuntimeErrorSource =
  | 'app'
  | 'content'
  | 'feature'
  | 'window'
  | 'promise'

export interface RuntimeErrorRecord {
  occurredAt: string
  source: RuntimeErrorSource
  kind: string
}

export interface RuntimeErrorSummary {
  recordingEnabled: boolean
  storedCount: number
  recent: RuntimeErrorRecord[]
}

interface RuntimeErrorReport {
  schemaVersion: 1
  generatedAt: string
  appVersion: string
  errors: RuntimeErrorSummary
  privacy: {
    containsAccountIdentifiers: false
    containsRoomOrMessageContent: false
    containsFilesystemPaths: false
    containsCredentials: false
    automaticUpload: false
  }
}

const SAFE_ERROR_KINDS = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'AggregateError',
  'AbortError',
  'DataError',
  'InvalidStateError',
  'NetworkError',
  'NotAllowedError',
  'NotFoundError',
  'NotReadableError',
  'OperationError',
  'QuotaExceededError',
  'SecurityError',
  'TimeoutError',
])

let recordingEnabled = false
let listenersInstalled = false

function isRuntimeErrorSource(value: unknown): value is RuntimeErrorSource {
  return value === 'app'
    || value === 'content'
    || value === 'feature'
    || value === 'window'
    || value === 'promise'
}

function safeErrorKind(error: unknown): string {
  if (!error || typeof error !== 'object' || !('name' in error)) return 'UnknownError'
  const name = String(error.name)
  return SAFE_ERROR_KINDS.has(name) ? name : 'UnknownError'
}

function readRecords(): RuntimeErrorRecord[] {
  const serialized = safeLocalStorageGet(STORAGE_KEY)
  if (!serialized) return []
  try {
    const parsed = JSON.parse(serialized)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): RuntimeErrorRecord[] => {
      if (!entry || typeof entry !== 'object') return []
      const candidate = entry as Partial<RuntimeErrorRecord>
      if (
        typeof candidate.occurredAt !== 'string'
        || !Number.isFinite(Date.parse(candidate.occurredAt))
        || !isRuntimeErrorSource(candidate.source)
        || typeof candidate.kind !== 'string'
        || !SAFE_ERROR_KINDS.has(candidate.kind) && candidate.kind !== 'UnknownError'
      ) return []
      return [{
        occurredAt: new Date(candidate.occurredAt).toISOString(),
        source: candidate.source,
        kind: candidate.kind,
      }]
    }).slice(-MAX_RUNTIME_ERROR_RECORDS)
  } catch {
    return []
  }
}

function writeRecords(records: RuntimeErrorRecord[]): void {
  safeLocalStorageSet(
    STORAGE_KEY,
    JSON.stringify(records.slice(-MAX_RUNTIME_ERROR_RECORDS)),
  )
}

export function setRuntimeErrorRecordingEnabled(enabled: boolean): void {
  recordingEnabled = enabled
  if (!enabled) clearRuntimeErrorRecords()
}

export function isRuntimeErrorRecordingEnabled(): boolean {
  return recordingEnabled
}

export function captureRuntimeError(
  source: RuntimeErrorSource,
  error: unknown,
  now = new Date(),
): void {
  if (!recordingEnabled) return
  const records = readRecords()
  records.push({
    occurredAt: now.toISOString(),
    source,
    kind: safeErrorKind(error),
  })
  writeRecords(records)
}

export function clearRuntimeErrorRecords(): void {
  safeLocalStorageRemove(STORAGE_KEY)
}

export function getRuntimeErrorSummary(): RuntimeErrorSummary {
  const recent = recordingEnabled ? readRecords() : []
  return {
    recordingEnabled,
    storedCount: recent.length,
    recent,
  }
}

export function createRuntimeErrorReport(now = new Date()): RuntimeErrorReport {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    appVersion: MESH_APP_VERSION,
    errors: getRuntimeErrorSummary(),
    privacy: {
      containsAccountIdentifiers: false,
      containsRoomOrMessageContent: false,
      containsFilesystemPaths: false,
      containsCredentials: false,
      automaticUpload: false,
    },
  }
}

export function serializeRuntimeErrorReport(report: RuntimeErrorReport): string {
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (new TextEncoder().encode(serialized).byteLength > MAX_RUNTIME_ERROR_REPORT_BYTES) {
    throw new Error('The error report exceeded its local size limit.')
  }
  return serialized
}

export function saveRuntimeErrorReport(): void {
  const serialized = serializeRuntimeErrorReport(createRuntimeErrorReport())
  const blob = new Blob([serialized], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `mesh-errors-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function installRuntimeErrorListeners(onUnexpectedFailure?: () => void): () => void {
  if (listenersInstalled || typeof window === 'undefined') return () => {}

  const onWindowError = (event: ErrorEvent) => {
    captureRuntimeError('window', event.error)
    onUnexpectedFailure?.()
  }
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    captureRuntimeError('promise', event.reason)
    onUnexpectedFailure?.()
    event.preventDefault()
  }

  window.addEventListener('error', onWindowError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  listenersInstalled = true

  return () => {
    window.removeEventListener('error', onWindowError)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
    listenersInstalled = false
  }
}
