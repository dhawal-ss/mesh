export type AppErrorCode =
  | 'not_authenticated'
  | 'database_error'
  | 'network_unavailable'
  | 'crypto_error'
  | 'identity_error'
  | 'not_found'
  | 'account_not_found'
  | 'rate_limited'
  | 'permission_denied'
  | 'media_permission_denied'
  | 'media_device_not_found'
  | 'media_device_not_readable'
  | 'media_constraints_unmet'
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
  | 'community_invite_requires_native_open'
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
  mediaKind?: MediaDeviceKind
}

export type MediaDeviceKind = 'microphone' | 'camera'

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
  'account_not_found',
  'rate_limited',
  'permission_denied',
  'media_permission_denied',
  'media_device_not_found',
  'media_device_not_readable',
  'media_constraints_unmet',
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
  'community_invite_requires_native_open',
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
    || message.includes('m_unknown_token')
    || message.includes('unknown token')
    || message.includes('status 401')
    || message.includes('[401')
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
    if (name === 'NotFoundError') {
      return new AppError('media_device_not_found', detail, false)
    }
    if (name === 'NotReadableError') {
      return new AppError('media_device_not_readable', detail, true)
    }
    if (name === 'OverconstrainedError') {
      return new AppError('media_constraints_unmet', detail, false)
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

/*
 * The operation clause, or nothing.
 *
 * This used to fall back to "Mesh could not finish that request." whenever a
 * caller passed no operation, which is almost the exact wording of the default
 * title. Every generic failure therefore reached the screen as "Mesh could not
 * finish the request. Mesh could not finish that request. Try again." at the
 * eight call sites that join the two halves. Saying nothing is better than
 * saying the title again.
 */
function operationBody(context: ErrorContext): string {
  return context.operation ? `Mesh couldn't ${context.operation}.` : ''
}

function mediaDeviceLabel(kind: MediaDeviceKind = 'microphone'): string {
  return kind === 'camera' ? 'Camera' : 'Microphone'
}

function mediaDeviceName(kind: MediaDeviceKind = 'microphone'): string {
  return kind === 'camera' ? 'camera' : 'microphone'
}

function describeErrorParts(
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
        title: `${mediaDeviceLabel(context.mediaKind)} permission needed`,
        body: `${operation} Allow ${mediaDeviceName(context.mediaKind)} access for Mesh in your system settings, then try again.`,
        action: 'Try again',
      }
    case 'media_device_not_found':
      return {
        title: `${mediaDeviceLabel(context.mediaKind)} not found`,
        body: `${operation} Connect a ${mediaDeviceName(context.mediaKind)} and make sure your system can see it, then try again.`,
        action: 'Try again',
      }
    case 'media_device_not_readable':
      return {
        title: `${mediaDeviceLabel(context.mediaKind)} is in use`,
        body: `${operation} Close other apps using your ${mediaDeviceName(context.mediaKind)}, then try again.`,
        action: 'Try again',
      }
    case 'media_constraints_unmet':
      return {
        title: `${mediaDeviceLabel(context.mediaKind)} settings unavailable`,
        body: `${operation} Choose another ${mediaDeviceName(context.mediaKind)} or check its system settings, then try again.`,
        action: 'Try again',
      }
    case 'room_not_found':
    case 'not_found':
      return {
        title: `${resource[0]?.toUpperCase() ?? ''}${resource.slice(1)} unavailable`,
        body: `${operation} It may have been removed or you may no longer have access.`,
        action: 'Go back',
      }
    case 'account_not_found':
      // Deliberately not the not_found copy above. Nothing was removed and no
      // access was lost: the address names nobody, which is almost always a
      // typo, and "Go back" is the wrong thing to offer somebody who should
      // read what they typed again.
      return {
        title: 'No account at that address',
        body: `${operation} Check the address, including the part after the colon, and try again.`,
        action: null,
      }
    case 'not_encrypted':
      return {
        title: 'Message protection unavailable',
        body: `${operation} Mesh will not send this until protection is available.`,
        action: null,
      }
    case 'decryption_failed':
      return {
        title: 'Item unavailable on this device',
        body: 'This device cannot open it yet. Review your signed-in devices, then try again.',
        action: 'Try again',
      }
    case 'crypto_error':
      return {
        title: 'Protected data unavailable',
        body: `${operation} Mesh could not complete the required protection step.`,
        action: error.retryable ? 'Try again' : null,
      }
    case 'identity_error':
      return {
        title: 'Account unavailable on this device',
        body: `${operation} Mesh could not use this account on this device.`,
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
        title: 'Community account service unavailable',
        body: 'This community does not have an optional account service configured.',
        action: null,
      }
    case 'username_unavailable':
      return {
        title: 'Username unavailable',
        body: 'Choose another username and try again.',
        action: 'Try another',
      }
    // Both of these used to end the only flow the product promises is zero
    // config, install to first message, with a statement of what Mesh cannot do
    // and no way forward. Signing in with an account made elsewhere, and picking
    // a different account service, are both first-class paths, so say so.
    case 'registration_terms_required':
      return {
        title: 'Terms acceptance required',
        body: 'This service needs its terms accepted first. Create the account there, then sign in.',
        action: null,
      }
    case 'registration_additional_auth_required':
      return {
        title: 'Additional verification required',
        body: 'This service needs an extra check. Create the account there, then sign in.',
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
    case 'community_invite_requires_native_open':
      return {
        title: 'Open this invitation with Mesh',
        body: 'Use the invitation link itself so Mesh can use its one-time invitation safely.',
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
        title: 'Mesh could not finish the request',
        body: `${operation} Try again, or open Connection check if this keeps happening.`,
        action: 'Try again',
      }
  }
}

/**
 * The public description, with the body normalised.
 *
 * Cases compose their body as `${operation} <guidance>`, and the operation is
 * now empty whenever a caller names no operation, so the raw string can begin
 * with a space or carry a double one. Tidying it here keeps every case template
 * readable instead of making forty of them defensive.
 */
export function describeError(
  errorOrCode: unknown,
  context: ErrorContext = {},
): ErrorDescription {
  const parts = describeErrorParts(errorOrCode, context)
  return { ...parts, body: parts.body.replace(/\s{2,}/g, ' ').trim() }
}

/**
 * A failure as one line: what happened, then what to do.
 *
 * Eight call sites built this by hand with `${title}. ${body}`, which is how
 * the same sentence came to be printed twice. One function means the shape is
 * decided once, and `src/lib/errors.test.ts` holds it inside the same limit the
 * copy density gate enforces on written strings.
 */
export function describeErrorLine(
  errorOrCode: unknown,
  context: ErrorContext = {},
): string {
  return errorLine(describeError(errorOrCode, context))
}

/** The same one line, for a caller that already has the description. */
export function errorLine({ title, body }: ErrorDescription): string {
  if (!body) return `${title}.`
  return `${title}. ${body}`
}
