import { errorDetail, normalizeError } from '../../lib/errors'

const LOOPBACK_ADDRESS = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i

export type MatrixSignInMode = 'recommended' | 'advanced'

/**
 * Turn the shortcuts people naturally type into an SDK-ready server input.
 * Remote domains stay scheme-less so matrix-rust-sdk can perform .well-known
 * discovery; local development addresses get their safe loopback HTTP URL.
 */
export function normalizeServiceAddress(value: string): string {
  const address = value.trim().replace(/\/+$/, '')
  if (!address) return ''
  if (LOOPBACK_ADDRESS.test(address)) return `http://${address}`
  return address
}

export function serviceFromUsername(value: string): string | null {
  const username = value.trim()
  if (!username.startsWith('@')) return null
  const separator = username.indexOf(':')
  if (separator <= 1 || separator === username.length - 1) return null
  return username.slice(separator + 1)
}

export function resolveServiceAddress(
  mode: MatrixSignInMode,
  username: string,
  customAddress: string,
  recommendedAddress: string,
): string {
  if (mode === 'recommended') {
    return normalizeServiceAddress(recommendedAddress)
  }

  return normalizeServiceAddress(customAddress)
    || normalizeServiceAddress(serviceFromUsername(username) ?? '')
}

export function displayServiceAddress(value: string): string {
  const normalized = normalizeServiceAddress(value)
  if (!normalized) return ''

  try {
    const url = new URL(normalized.includes('://') ? normalized : `https://${normalized}`)
    return url.host
  } catch {
    return normalized
  }
}

export function serviceAddressConfigError(value: string): string | null {
  const rawAddress = value.trim()
  if (/[\u0000-\u0020\u007f]/.test(rawAddress)) {
    return 'That service address is invalid. Enter one like matrix.org or https://matrix.example.org.'
  }

  const normalized = normalizeServiceAddress(value)
  if (!normalized) return 'No account service is configured for this build.'

  try {
    const url = new URL(normalized.includes('://') ? normalized : `https://${normalized}`)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!host || url.hostname.includes('%')) {
      return 'That service address is invalid. Enter one like matrix.org or https://matrix.example.org.'
    }
    const isLoopback = host.toLocaleLowerCase() === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
    if (url.username || url.password) {
      return 'The configured service address must not contain credentials.'
    }
    if (url.search || url.hash) {
      return 'The configured service address must not contain a query or link fragment.'
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
      return 'The configured service must use HTTPS.'
    }
    if (!value.includes('://') && (url.pathname !== '/' || url.search || url.hash)) {
      return 'That service address is invalid. Enter one like matrix.org or https://matrix.example.org.'
    }
    return null
  } catch {
    return 'That service address is invalid. Enter one like matrix.org or https://matrix.example.org.'
  }
}

export type ServiceFailureKind =
  | 'dns'
  | 'tls'
  | 'http_status'
  | 'malformed_well_known'
  | 'timeout'
  | 'other'

export function classifyServiceFailure(cause: unknown): ServiceFailureKind {
  const message = normalizeError(cause).detail.toLowerCase()
  if (message.includes('timed out') || message.includes('timeout')) return 'timeout'
  if (
    message.includes('dns')
    || message.includes('name resolution')
    || message.includes('could not resolve')
    || message.includes('no such host')
    || message.includes('getaddrinfo')
  ) {
    return 'dns'
  }
  if (
    message.includes('tls')
    || message.includes('ssl')
    || message.includes('certificate')
    || message.includes('handshake')
  ) {
    return 'tls'
  }
  if (
    message.includes('well-known')
    || message.includes('well known')
    || (
      message.includes('discovery')
      && (message.includes('json') || message.includes('invalid') || message.includes('malformed'))
    )
  ) {
    return 'malformed_well_known'
  }
  if (
    /\b(?:status|http(?:\s+status)?|response)\s*[:=]?\s*[45]\d{2}\b/.test(message)
    || message.includes('m_forbidden')
    || message.includes('m_not_found')
    || message.includes('m_unauthorized')
  ) {
    return 'http_status'
  }
  return 'other'
}

export function friendlyServiceError(cause: unknown, operation: string): string {
  const prefix = `Mesh couldn't ${operation}.`
  switch (classifyServiceFailure(cause)) {
    case 'dns':
      return `${prefix} The account service could not be found. Check the address and your connection, then try again.`
    case 'tls':
      return `${prefix} The account service did not prove that the connection was private. Check the address or choose another service.`
    case 'http_status':
      return `${prefix} The account service could not complete the request. Try again later, check its status, or choose another service.`
    case 'malformed_well_known':
      // `.well-known` belongs in the Technical details block, not in the lead
      // sentence of a default-path error.
      return `${prefix} Mesh couldn’t read this service’s setup information. Choose another service, or ask whoever runs it to check its configuration.`
    case 'timeout':
      return `${prefix} The account service took too long to respond. Check your connection or try again.`
    case 'other':
      return `${prefix} Check your connection or choose another service, then try again.`
  }
}

export function friendlySignInError(cause: unknown): string {
  const error = normalizeError(cause)
  if (error.code === 'login_cancelled' || error.code === 'cancelled') {
    return 'Sign-in was cancelled. No account session was saved.'
  }
  if (error.code === 'login_timed_out') {
    return 'Sign-in took too long. Check your connection or service address, then try again.'
  }
  if (error.code === 'not_authenticated' || error.code === 'permission_denied') {
    return 'That username or password did not work. Check both and try again.'
  }
  if (classifyServiceFailure(cause) !== 'other') {
    return friendlyServiceError(cause, 'sign you in')
  }
  if (error.code === 'network_unavailable') {
    return 'We could not reach your messaging service. Check your connection and try again.'
  }

  const technical = error.detail
  const message = technical.toLowerCase()
  if (message.includes('sign-in was cancelled') || message.includes('login was cancelled')) {
    return 'Sign-in was cancelled. No account session was saved.'
  }
  if (message.includes('sign-in timed out') || message.includes('login timed out')) {
    return 'Sign-in took too long. Check your connection or service address, then try again.'
  }
  if (
    message.includes('m_forbidden')
    || message.includes('forbidden')
    || message.includes('invalid username')
    || message.includes('invalid password')
    || message.includes('403')
  ) {
    return 'That username or password did not work. Check both and try again.'
  }
  if (
    message.includes('invalid matrix server')
    || message.includes('invalid homeserver')
    || message.includes('homeserver url')
  ) {
    return 'We could not understand that service address. Try a domain like chat.example.com.'
  }
  if (
    message.includes('network')
    || message.includes('dns')
    || message.includes('connect')
    || message.includes('request')
    || message.includes('discovery')
    || message.includes('offline')
  ) {
    return 'We could not reach your messaging service. Check your connection and try again.'
  }
  return 'We could not sign you in. Check your details and try again.'
}

export function technicalSignInError(cause: unknown): string {
  return errorDetail(cause)
}
