const MATRIX_INVITE_VERSION = '3'
const MANAGED_INVITE_VERSION = '4'
const MAX_INVITE_LENGTH = 4_096
const MAX_MATRIX_IDENTIFIER_LENGTH = 512
const MAX_SERVER_NAME_LENGTH = 255
const ADMISSION_CODE_PATTERN = /^[A-Za-z0-9_-]{32,64}$/

export interface MatrixCommunityInvite {
  kind: 'matrix'
  version: 3
  roomOrAlias: string
  via: string[]
  service: string | null
  original: string
}

export interface ManagedCommunityInvite {
  kind: 'managed'
  version: 4
  code: string
  apiOrigin: string
  original: string
}

export type CommunityInvite = MatrixCommunityInvite | ManagedCommunityInvite

function isMatrixRoomIdentifier(value: string): boolean {
  if (
    value.length < 4
    || value.length > MAX_MATRIX_IDENTIFIER_LENGTH
    || (value[0] !== '!' && value[0] !== '#')
    || /\s/.test(value)
  ) {
    return false
  }
  const separator = value.indexOf(':')
  return separator > 1 && separator < value.length - 1
}

function isServerName(value: string): boolean {
  return (
    value.length > 0
    && value.length <= MAX_SERVER_NAME_LENGTH
    && !/[\s/?#@]/.test(value)
    && (
      value.startsWith('[')
        ? /^\[[0-9a-f:.]+\](?::\d{1,5})?$/i.test(value)
        : /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(value)
    )
  )
}

export function normalizeCommunityService(value: string | null): string | null {
  if (!value) return null
  try {
    const service = new URL(value)
    const localDevelopmentService =
      service.protocol === 'http:'
      && (service.hostname === 'localhost' || service.hostname === '127.0.0.1' || service.hostname === '[::1]')
    if (service.protocol !== 'https:' && !localDevelopmentService) return null
    if (service.username || service.password || service.search || service.hash) return null
    return service.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function hasOnlySearchParameters(url: URL, allowed: ReadonlySet<string>): boolean {
  return [...url.searchParams.keys()].every((key) => allowed.has(key))
}

export function parseMatrixCommunityInvite(value: string): MatrixCommunityInvite | null {
  const input = value.trim()
  if (!input || input.length > MAX_INVITE_LENGTH) return null

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (
    url.protocol !== 'mesh:'
    || url.hostname.toLowerCase() !== 'join'
    || url.username
    || url.password
    || url.hash
    || url.searchParams.get('v') !== MATRIX_INVITE_VERSION
    || url.searchParams.get('kind') !== 'matrix'
  ) {
    return null
  }

  const roomOrAlias = url.searchParams.get('room')?.trim() ?? ''
  if (!isMatrixRoomIdentifier(roomOrAlias)) return null

  const via = [
    ...url.searchParams.getAll('via'),
    ...(url.searchParams.get('via')?.split(',') ?? []),
  ]
    .map((serverName) => serverName.trim())
    .filter(isServerName)
  const uniqueVia = [...new Set(via)].slice(0, 3)
  if (uniqueVia.length === 0) return null

  const serviceValue = url.searchParams.get('service')
  const service = normalizeCommunityService(serviceValue)
  if (serviceValue && !service) return null

  return {
    kind: 'matrix',
    version: 3,
    roomOrAlias,
    via: uniqueVia,
    service,
    original: input,
  }
}

export function parseManagedCommunityInvite(value: string): ManagedCommunityInvite | null {
  const input = value.trim()
  if (!input || input.length > MAX_INVITE_LENGTH) return null

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }

  if (url.protocol === 'mesh:') {
    if (
      url.hostname.toLowerCase() !== 'join'
      || (url.pathname !== '' && url.pathname !== '/')
      || url.username
      || url.password
      || url.hash
      || url.searchParams.get('v') !== MANAGED_INVITE_VERSION
      || url.searchParams.get('kind') !== 'managed'
      || !hasOnlySearchParameters(url, new Set(['v', 'kind', 'code', 'api']))
    ) {
      return null
    }
    const code = url.searchParams.get('code') ?? ''
    const apiOrigin = normalizeCommunityService(url.searchParams.get('api'))
    if (!ADMISSION_CODE_PATTERN.test(code) || !apiOrigin) return null
    return {
      kind: 'managed',
      version: 4,
      code,
      apiOrigin,
      original: input,
    }
  }

  const localDevelopmentInvite =
    url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  if (
    (url.protocol !== 'https:' && !localDevelopmentInvite)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    return null
  }
  const match = url.pathname.match(/^\/invite\/([A-Za-z0-9_-]{32,64})\/?$/)
  if (!match) return null
  return {
    kind: 'managed',
    version: 4,
    code: match[1],
    apiOrigin: url.origin,
    original: input,
  }
}

export function parseCommunityInvite(value: string): CommunityInvite | null {
  return parseManagedCommunityInvite(value) ?? parseMatrixCommunityInvite(value)
}

export function isMeshJoinLink(value: string): boolean {
  const input = value.trim()
  if (!input || input.length > MAX_INVITE_LENGTH) return false
  try {
    const url = new URL(input)
    return (
      url.protocol === 'mesh:'
      && url.hostname.toLowerCase() === 'join'
      && !url.username
      && !url.password
      && !url.hash
    )
  } catch {
    return false
  }
}
