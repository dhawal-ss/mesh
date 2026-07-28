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

export function recommendedServiceConfigError(value: string): string | null {
  const normalized = normalizeServiceAddress(value)
  if (!normalized) return 'No recommended service is configured for this build.'

  try {
    const url = new URL(normalized.includes('://') ? normalized : `https://${normalized}`)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const isLoopback = host.toLocaleLowerCase() === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
    if (url.username || url.password) {
      return 'The configured service address must not contain credentials.'
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
      return 'The configured service must use HTTPS.'
    }
    if (!value.includes('://') && (url.pathname !== '/' || url.search || url.hash)) {
      return 'The configured service address is invalid.'
    }
    return null
  } catch {
    return 'The configured service address is invalid.'
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
