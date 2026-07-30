export type AppErrorCode =
  | 'not_authenticated'
  | 'database_error'
  | 'network_unavailable'
  | 'crypto_error'
  | 'identity_error'
  | 'not_found'
  | 'rate_limited'
  | 'permission_denied'
  | 'media_permission_denied'
  | 'room_not_found'
  | 'not_encrypted'
  | 'decryption_failed'
  | 'serialization_error'
  | 'validation_error'
  | 'community_homeserver_unconfigured'
  | 'username_unavailable'
  | 'registration_terms_required'
  | 'registration_additional_auth_required'
  | 'registration_invitation_required'
  | 'registration_invitation_invalid'
  | 'registration_timed_out'
  | 'community_invite_invalid'
  | 'banned'
  | 'unsupported_operation'
  | 'login_cancelled'
  | 'login_timed_out'
  | 'unexpected_error'
  | 'server_error'
  | 'cancelled'
  | 'invalid_input'
  | 'unavailable'
  | 'unknown'

export interface BackendErrorPayload {
  code?: unknown
  detail?: unknown
  message?: unknown
  retryable?: unknown
}

export interface ErrorContext {
  operation?: string
  resource?: string
}

export interface ErrorDescription {
  title: string
  body: string
  action: string | null
}

const KNOWN_CODES = new Set<AppErrorCode>([
  'not_authenticated',
  'database_error',
  'network_unavailable',
  'crypto_error',
  'identity_error',
  'not_found',
  'rate_limited',
  'permission_denied',
  'media_permission_denied',
  'room_not_found',
  'not_encrypted',
  'decryption_failed',
  'serialization_error',
  'validation_error',
  'community_homeserver_unconfigured',
  'username_unavailable',
  'registration_terms_required',
  'registration_additional_auth_required',
  'registration_invitation_required',
  'registration_invitation_invalid',
  'registration_timed_out',
  'community_invite_invalid',
  'banned',
  'unsupported_operation',
  'login_cancelled',
  'login_timed_out',
  'unexpected_error',
  'server_error',
  'cancelled',
  'invalid_input',
  'unavailable',
  'unknown',
])

const WINDOWS_PATH = /(?:[a-z]:\\|\\\\)[^\s"'<>]+/gi
const UNIX_PATH = /(^|[\s("'=])\/(?:Users|home|var|tmp|private|opt|etc)\/[^\s"'<>]+/gi
const SECRET_VALUE = /((?:access[_-]?token|refresh[_-]?token|token|password|secret|authorization|bearer)[\s:=]+)([^\s,;]+)/gi
const URL_SECRET = /([?&](?:access_token|token|key|secret)=)[^&#\s]+/gi

function codeFromValue(value: unknown): AppErrorCode {
  if (typeof value !== 'string') return 'unknown'

  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()

  if (KNOWN_CODES.has(normalized as AppErrorCode)) {
    return normalized as AppErrorCode
  }

  switch (normalized) {
    case 'notauthenticated':
    case 'unauthenticated':
    case 'm_unauthorized':
      return 'not_authenticated'
    case 'networkunavailable':
    case 'offline':
      return 'network_unavailable'
    case 'ratelimited':
    case 'm_limit_exceeded':
      return 'rate_limited'
    case 'permissiondenied':
    case 'forbidden':
    case 'm_forbidden':
      return 'permission_denied'
    case 'roomnotfound':
    case 'm_not_found':
      return 'room_not_found'
    case 'notencryped':
    case 'notencrypted':
      return 'not_encrypted'
    case 'decryptionfailed':
      return 'decryption_failed'
    case 'servererror':
      return 'server_error'
    default:
      return 'unknown'
  }
}

function inferCode(detail: string): AppErrorCode {
  const message = detail.toLowerCase()
  if (
    message.includes('m_forbidden')
    || message.includes('permission denied')
    || message.includes('forbidden')
    || message.includes('status 403')
  ) {
    return 'permission_denied'
  }
  if (
    message.includes('not authenticated')
    || message.includes('authentication required')
    || message.includes('sign in required')
    || message.includes('m_unauthorized')
    || message.includes('status 401')
  ) {
    return 'not_authenticated'
  }
  if (
    message.includes('m_limit_exceeded')
    || message.includes('rate limit')
    || message.includes('too many requests')
    || message.includes('status 429')
  ) {
    return 'rate_limited'
  }
  if (
    message.includes('room not found')
    || message.includes('m_not_found')
    || message.includes('unknown room')
  ) {
    return 'room_not_found'
  }
  if (message.includes('decrypt')) return 'decryption_failed'
  if (message.includes('not encrypted') || message.includes('encryption unavailable')) {
    return 'not_encrypted'
  }
  if (message.includes('login timed out') || message.includes('sign-in timed out')) {
    return 'login_timed_out'
  }
  if (message.includes('login was cancelled') || message.includes('sign-in was cancelled')) {
    return 'login_cancelled'
  }
  if (
    message.includes('network')
    || message.includes('offline')
    || message.includes('connection refused')
    || message.includes('failed to connect')
    || message.includes('dns')
    || message.includes('fetch failed')
  ) {
    return 'network_unavailable'
  }
  if (message.includes('timed out') || message.includes('timeout')) return 'network_unavailable'
  if (message.includes('cancelled') || message.includes('canceled')) return 'cancelled'
  if (
    message.includes('invalid input')
    || message.includes('invalid request')
    || message.includes('malformed')
  ) {
    return 'invalid_input'
  }
  if (message.includes('unavailable') || message.includes('not configured')) return 'unavailable'
  return 'unknown'
}

function objectDetail(value: BackendErrorPayload): string {
  if (typeof value.detail === 'string' && value.detail.trim()) return value.detail.trim()
  if (typeof value.message === 'string' && value.message.trim()) return value.message.trim()
  try {
    return JSON.stringify(value)
  } catch {
    return 'Unknown error'
  }
}

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly detail: string
  readonly retryable: boolean

  constructor(
    code: AppErrorCode,
    detail: string,
    retryable =
    code === 'network_unavailable'
      || code === 'rate_limited'
      || code === 'registration_timed_out'
      || code === 'database_error'
      || code === 'server_error'
      || code === 'unexpected_error',
  ) {
    super(detail || 'Unknown error')
    this.name = 'AppError'
    this.code = code
    this.detail = detail || 'Unknown error'
    this.retryable = retryable
  }
}

/**
 * Normalize every rejection shape Tauri may return. Consumers can depend on a
 * real Error plus stable code/detail/retryable fields instead of branching on
 * strings, Error instances, and serialized Rust objects.
 */
export function normalizeError(cause: unknown): AppError {
  if (cause instanceof AppError) return cause

  if (cause instanceof Error) {
    const { message, name } = cause
    const detail = message.trim() || name || 'Unknown error'
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return new AppError('media_permission_denied', detail, false)
    }
    return new AppError(inferCode(detail), detail)
  }

  if (typeof cause === 'string') {
    const detail = cause.trim() || 'Unknown error'
    return new AppError(inferCode(detail), detail)
  }

  if (cause && typeof cause === 'object') {
    const payload = cause as BackendErrorPayload
    const detail = objectDetail(payload)
    const explicitCode = codeFromValue(payload.code)
    const code = explicitCode === 'unknown' ? inferCode(detail) : explicitCode
    const retryable =
      typeof payload.retryable === 'boolean'
        ? payload.retryable
        : code === 'network_unavailable'
          || code === 'rate_limited'
          || code === 'registration_timed_out'
          || code === 'database_error'
          || code === 'server_error'
          || code === 'unexpected_error'
    return new AppError(code, detail, retryable)
  }

  return new AppError('unknown', 'Unknown error', false)
}

export function errorDetail(cause: unknown): string {
  const { code, detail } = normalizeError(cause)
  const sanitized = detail
    .replace(WINDOWS_PATH, '[local path]')
    .replace(UNIX_PATH, '$1[local path]')
    .replace(SECRET_VALUE, '$1[redacted]')
    .replace(URL_SECRET, '$1[redacted]')
    .slice(0, 4_000)
  return `[${code}] ${sanitized}`
}

function operationBody(context: ErrorContext): string {
  return context.operation ? `Mesh couldn't ${context.operation}.` : 'Mesh could not finish that request.'
}

export function describeError(
  errorOrCode: unknown,
  context: ErrorContext = {},
): ErrorDescription {
  const normalizedCode = codeFromValue(errorOrCode)
  const isExplicitCode =
    typeof errorOrCode === 'string'
    && (normalizedCode !== 'unknown' || errorOrCode.trim().toLowerCase() === 'unknown')
  const error = isExplicitCode
    ? new AppError(normalizedCode, errorOrCode as string)
    : normalizeError(errorOrCode)
  const operation = operationBody(context)
  const resource = context.resource ?? 'conversation'

  switch (error.code) {
    case 'not_authenticated':
      return {
        title: 'Sign in required',
        body: `${operation} Sign in again, then retry.`,
        action: 'Sign in',
      }
    case 'network_unavailable':
      return {
        title: 'Connection interrupted',
        body: `${operation} Check your connection and try again.`,
        action: 'Try again',
      }
    case 'rate_limited':
      return {
        title: 'Try again shortly',
        body: `${operation} The service is receiving too many requests right now.`,
        action: 'Try again',
      }
    case 'permission_denied':
      return {
        title: 'Permission needed',
        body: `${operation} Your account does not have permission for this action.`,
        action: null,
      }
    case 'media_permission_denied':
      return {
        title: 'Microphone permission needed',
        body: `${operation} Allow microphone access for Mesh in your system settings, then try again.`,
        action: 'Try again',
      }
    case 'room_not_found':
    case 'not_found':
      return {
        title: `${resource[0]?.toUpperCase() ?? ''}${resource.slice(1)} unavailable`,
        body: `${operation} It may have been removed or you may no longer have access.`,
        action: 'Go back',
      }
    case 'not_encrypted':
      return {
        title: 'Secure messaging unavailable',
        body: `${operation} Mesh will not send this without the expected encryption.`,
        action: null,
      }
    case 'decryption_failed':
      return {
        title: 'Could not decrypt this item',
        body: 'Mesh does not have the keys needed to open it on this device.',
        action: 'Try again',
      }
    case 'crypto_error':
      return {
        title: 'Secure data unavailable',
        body: `${operation} Mesh could not complete the required encryption or decryption step.`,
        action: error.retryable ? 'Try again' : null,
      }
    case 'identity_error':
      return {
        title: 'Account identity unavailable',
        body: `${operation} Mesh could not use the account identity on this device.`,
        action: error.retryable ? 'Try again' : null,
      }
    case 'database_error':
      return {
        title: 'Local data unavailable',
        body: `${operation} Mesh could not read or save the required local data.`,
        action: error.retryable ? 'Try again' : null,
      }
    case 'serialization_error':
      return {
        title: 'Data could not be processed',
        body: `${operation} Mesh received data in an unexpected format.`,
        action: null,
      }
    case 'validation_error':
      return {
        title: 'Check the information',
        body: `${operation} Review the entered information and try again.`,
        action: 'Try again',
      }
    case 'community_homeserver_unconfigured':
      return {
        title: 'Community service unavailable',
        body: 'This community does not have an optional account service configured.',
        action: null,
      }
    case 'username_unavailable':
      return {
        title: 'Username unavailable',
        body: 'Choose another username and try again.',
        action: 'Try another',
      }
    case 'registration_terms_required':
      return {
        title: 'Terms acceptance required',
        body: 'The account service requires terms acceptance before creating this account.',
        action: null,
      }
    case 'registration_additional_auth_required':
      return {
        title: 'Additional verification required',
        body: 'The account service requires a verification step this version of Mesh cannot complete.',
        action: null,
      }
    case 'registration_invitation_required':
      return {
        title: 'Invitation required',
        body: 'Enter the invitation code you received, then try again.',
        action: 'Check invitation',
      }
    case 'registration_invitation_invalid':
      return {
        title: 'Invitation unavailable',
        body: 'This invitation is invalid, expired, or has already been used. Ask for a new invitation.',
        action: 'Check invitation',
      }
    case 'registration_timed_out':
      return {
        title: 'Account service did not respond',
        body: 'Account creation took too long. Check your connection and try again.',
        action: 'Try again',
      }
    case 'community_invite_invalid':
      return {
        title: 'Invitation unavailable',
        body: `${operation} Ask a community administrator for a new invitation link.`,
        action: null,
      }
    case 'banned':
      return {
        title: 'Access blocked',
        body: `${operation} This account is not allowed to perform that action.`,
        action: null,
      }
    case 'unsupported_operation':
      return {
        title: 'Action unavailable',
        body: `${operation} This action is not supported by the current service.`,
        action: null,
      }
    case 'login_cancelled':
      return {
        title: 'Sign-in cancelled',
        body: 'No account session was saved. Start sign-in again when you are ready.',
        action: 'Try again',
      }
    case 'login_timed_out':
      return {
        title: 'Sign-in timed out',
        body: 'The sign-in window did not finish in time. Check your connection and try again.',
        action: 'Try again',
      }
    case 'unexpected_error':
    case 'server_error':
      return {
        title: 'Service error',
        body: `${operation} The service returned an unexpected response.`,
        action: error.retryable ? 'Try again' : null,
      }
    case 'cancelled':
      return {
        title: 'Action cancelled',
        body: `${operation} Nothing else was changed.`,
        action: 'Try again',
      }
    case 'invalid_input':
      return {
        title: 'Check the information',
        body: `${operation} Review the entered information and try again.`,
        action: 'Try again',
      }
    case 'unavailable':
      return {
        title: 'Feature unavailable',
        body: `${operation} This feature is not available in the current configuration.`,
        action: null,
      }
    case 'unknown':
      return {
        title: 'Something went wrong',
        body: `${operation} Try again. If it keeps happening, open Diagnostics and copy the details.`,
        action: 'Try again',
      }
  }
}
