const MATRIX_INVITE_VERSION = '3'
const LEGACY_ADMISSION_INVITE_VERSION = '4'
const COMMUNITY_INVITE_VERSION = '5'
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

export interface LegacyAdmissionCommunityInvite {
  kind: 'managed'
  version: 4
  code: string
  apiOrigin: string
  original: string
}

export interface CommunityInviteV5 {
  kind: 'community'
  version: 5
  roomOrAlias: string
  via: string[]
  communityService: string | null
  admissionOrigin: string | null
  admissionCode: string | null
  resumeUrl: string | null
  original: string
}

export type AdmissionCommunityInvite = LegacyAdmissionCommunityInvite | CommunityInviteV5
export type CommunityInvite = MatrixCommunityInvite | LegacyAdmissionCommunityInvite | CommunityInviteV5

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

function parseViaServers(url: URL): string[] {
  const via = url.searchParams.getAll('via')
    .flatMap((value) => value.split(','))
    .map((serverName) => serverName.trim())
    .filter(isServerName)
  return [...new Set(via)].slice(0, 3)
}

function normalizeResumeUrl(value: string | null): string | null {
  if (!value || value.length > 2_048) return null
  try {
    const resume = new URL(value)
    const localDevelopmentResume =
      resume.protocol === 'http:'
      && (resume.hostname === 'localhost'
        || resume.hostname === '127.0.0.1'
        || resume.hostname === '[::1]')
    if (
      (resume.protocol !== 'https:' && !localDevelopmentResume)
      || resume.username
      || resume.password
      || resume.hash
    ) {
      return null
    }
    return resume.toString()
  } catch {
    return null
  }
}

export function parseCommunityInviteV5(value: string): CommunityInviteV5 | null {
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
    || (url.pathname !== '' && url.pathname !== '/')
    || url.username
    || url.password
    || url.hash
    || url.searchParams.get('v') !== COMMUNITY_INVITE_VERSION
    || url.searchParams.get('kind') !== 'community'
    || !hasOnlySearchParameters(
      url,
      new Set([
        'v',
        'kind',
        'room',
        'via',
        'community_service',
        'admission',
        'code',
        'resume',
      ]),
    )
  ) {
    return null
  }

  const roomOrAlias = url.searchParams.get('room')?.trim() ?? ''
  const via = parseViaServers(url)
  if (!isMatrixRoomIdentifier(roomOrAlias) || via.length === 0) return null

  const communityServiceValue = url.searchParams.get('community_service')
  const communityService = normalizeCommunityService(communityServiceValue)
  if (communityServiceValue && !communityService) return null

  const admissionValue = url.searchParams.get('admission')
  const admissionOrigin = normalizeCommunityService(admissionValue)
  const admissionCode = url.searchParams.get('code')
  if (
    Boolean(admissionValue) !== Boolean(admissionCode)
    || (admissionValue && (!admissionOrigin || !ADMISSION_CODE_PATTERN.test(admissionCode ?? '')))
  ) {
    return null
  }

  const resumeValue = url.searchParams.get('resume')
  const resumeUrl = normalizeResumeUrl(resumeValue)
  if (resumeValue && !resumeUrl) return null

  return {
    kind: 'community',
    version: 5,
    roomOrAlias,
    via,
    communityService,
    admissionOrigin,
    admissionCode,
    resumeUrl,
    original: input,
  }
}

export function parseMatrixCommunityInvite(
  value: string,
): MatrixCommunityInvite | CommunityInviteV5 | null {
  const current = parseCommunityInviteV5(value)
  if (current) return current

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

  const uniqueVia = parseViaServers(url)
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

export function parseAdmissionCommunityInvite(value: string): AdmissionCommunityInvite | null {
  const current = parseCommunityInviteV5(value)
  if (current?.admissionOrigin && current.admissionCode) return current

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
      || url.searchParams.get('v') !== LEGACY_ADMISSION_INVITE_VERSION
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
  return parseAdmissionCommunityInvite(value) ?? parseMatrixCommunityInvite(value)
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
