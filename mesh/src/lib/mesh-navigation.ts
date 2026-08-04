export const MESH_NAVIGATION_SCHEMA_VERSION = 1
export const MAX_MESH_ROUTE_HISTORY = 40
export const MAX_MESH_RECENT_DESTINATIONS = 12

export type CommunitiesMode = 'join' | 'browse' | 'create'
export type DetailsTab = 'people' | 'pins' | 'files'
export type YouSection =
  | 'profile'
  | 'account'
  | 'appearance'
  | 'notifications'
  | 'privacy-voice'
  | 'safety-devices'
  | 'advanced'
export type CommunityAdminSection =
  | 'general'
  | 'people-roles'
  | 'rooms-voice'
  | 'invitations'
  | 'discovery-access'
  | 'moderation'
  | 'emoji'
  | 'danger'

export type MeshSignalSubject = {
  kind: 'community' | 'room' | 'voice' | 'service' | 'device'
  id: string
}

export type MeshPane =
  | { kind: 'party'; roomId: string }
  | { kind: 'details'; tab: DetailsTab }
  | { kind: 'thread'; rootEventId: string }
  | { kind: 'safety' }
  | { kind: 'signal'; subject: MeshSignalSubject }

export type MeshRoute =
  | { kind: 'home' }
  | { kind: 'communities'; mode: CommunitiesMode }
  | { kind: 'community'; communityId: string }
  | { kind: 'room'; communityId: string; roomId: string; pane?: MeshPane }
  | { kind: 'direct'; conversationId: string; pane?: MeshPane }
  | { kind: 'voice'; communityId: string; roomId: string }
  | { kind: 'invitation'; handle: string }
  | { kind: 'you'; section: YouSection }
  | { kind: 'community-admin'; communityId: string; section: CommunityAdminSection }

export type MeshRecentRoute = Extract<
  MeshRoute,
  { kind: 'community' | 'room' | 'direct' | 'voice' }
>

export interface MeshRecentDestination {
  route: MeshRecentRoute
  lastOpenedAt: number
}

export interface MeshNavigationSnapshot {
  schemaVersion: typeof MESH_NAVIGATION_SCHEMA_VERSION
  accountId: string
  entries: MeshRoute[]
  index: number
  recents: MeshRecentDestination[]
}

const COMMUNITIES_MODES = new Set<CommunitiesMode>(['join', 'browse', 'create'])
const DETAILS_TABS = new Set<DetailsTab>(['people', 'pins', 'files'])
const YOU_SECTIONS = new Set<YouSection>([
  'profile',
  'account',
  'appearance',
  'notifications',
  'privacy-voice',
  'safety-devices',
  'advanced',
])
const ADMIN_SECTIONS = new Set<CommunityAdminSection>([
  'general',
  'people-roles',
  'rooms-voice',
  'invitations',
  'discovery-access',
  'moderation',
  'emoji',
  'danger',
])
const SIGNAL_SUBJECT_KINDS = new Set<MeshSignalSubject['kind']>([
  'community',
  'room',
  'voice',
  'service',
  'device',
])

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function isInvitationHandle(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function isMeshPane(value: unknown): value is MeshPane {
  if (!value || typeof value !== 'object') return false
  const pane = value as Partial<MeshPane>
  if (pane.kind === 'party') return isBoundedId(pane.roomId)
  if (pane.kind === 'details') return DETAILS_TABS.has(pane.tab as DetailsTab)
  if (pane.kind === 'thread') return isBoundedId(pane.rootEventId)
  if (pane.kind === 'safety') return true
  if (pane.kind !== 'signal' || !pane.subject || typeof pane.subject !== 'object') return false
  const subject = pane.subject as Partial<MeshSignalSubject>
  return SIGNAL_SUBJECT_KINDS.has(subject.kind as MeshSignalSubject['kind'])
    && isBoundedId(subject.id)
}

export function isMeshRoute(value: unknown): value is MeshRoute {
  if (!value || typeof value !== 'object') return false
  const route = value as Partial<MeshRoute>
  if (route.kind === 'home') return true
  if (route.kind === 'communities') {
    return COMMUNITIES_MODES.has(route.mode as CommunitiesMode)
  }
  if (route.kind === 'community') return isBoundedId(route.communityId)
  if (route.kind === 'room') {
    return isBoundedId(route.communityId)
      && isBoundedId(route.roomId)
      && (route.pane === undefined || isMeshPane(route.pane))
  }
  if (route.kind === 'direct') {
    return isBoundedId(route.conversationId)
      && (route.pane === undefined || isMeshPane(route.pane))
  }
  if (route.kind === 'voice') {
    return isBoundedId(route.communityId) && isBoundedId(route.roomId)
  }
  if (route.kind === 'invitation') return isInvitationHandle(route.handle)
  if (route.kind === 'you') return YOU_SECTIONS.has(route.section as YouSection)
  if (route.kind === 'community-admin') {
    return isBoundedId(route.communityId)
      && ADMIN_SECTIONS.has(route.section as CommunityAdminSection)
  }
  return false
}

export function meshRouteKey(route: MeshRoute): string {
  if (route.kind === 'home') return 'home'
  if (route.kind === 'communities') return `communities:${route.mode}`
  if (route.kind === 'community') return `community:${route.communityId}`
  if (route.kind === 'room') return `room:${route.communityId}:${route.roomId}:${paneKey(route.pane)}`
  if (route.kind === 'direct') return `direct:${route.conversationId}:${paneKey(route.pane)}`
  if (route.kind === 'voice') return `voice:${route.communityId}:${route.roomId}`
  if (route.kind === 'invitation') return `invitation:${route.handle}`
  if (route.kind === 'you') return `you:${route.section}`
  return `community-admin:${route.communityId}:${route.section}`
}

function paneKey(pane: MeshPane | undefined): string {
  if (!pane) return 'none'
  if (pane.kind === 'party') return `party:${pane.roomId}`
  if (pane.kind === 'details') return `details:${pane.tab}`
  if (pane.kind === 'thread') return `thread:${pane.rootEventId}`
  if (pane.kind === 'safety') return 'safety'
  return `signal:${pane.subject.kind}:${pane.subject.id}`
}

export function emptyMeshNavigation(accountId: string): MeshNavigationSnapshot {
  return {
    schemaVersion: MESH_NAVIGATION_SCHEMA_VERSION,
    accountId,
    entries: [{ kind: 'home' }],
    index: 0,
    recents: [],
  }
}

export function currentMeshRoute(state: MeshNavigationSnapshot): MeshRoute {
  return state.entries[state.index] ?? { kind: 'home' }
}

export function navigateMesh(
  state: MeshNavigationSnapshot,
  route: MeshRoute,
  options: { replace?: boolean; now?: number } = {},
): MeshNavigationSnapshot {
  if (!isMeshRoute(route)) return state
  const current = currentMeshRoute(state)
  if (meshRouteKey(current) === meshRouteKey(route)) return state

  let entries: MeshRoute[]
  let index: number
  if (options.replace) {
    entries = [...state.entries]
    entries[state.index] = route
    index = state.index
  } else {
    entries = [...state.entries.slice(0, state.index + 1), route]
    if (entries.length > MAX_MESH_ROUTE_HISTORY) {
      entries = entries.slice(entries.length - MAX_MESH_ROUTE_HISTORY)
    }
    index = entries.length - 1
  }

  return {
    ...state,
    entries,
    index,
    recents: updateRecents(state.recents, route, options.now ?? Date.now()),
  }
}

export function moveMeshHistory(
  state: MeshNavigationSnapshot,
  offset: -1 | 1,
): MeshNavigationSnapshot {
  const index = Math.max(0, Math.min(state.entries.length - 1, state.index + offset))
  return index === state.index ? state : { ...state, index }
}

export function closeMeshPane(state: MeshNavigationSnapshot): MeshNavigationSnapshot {
  const route = currentMeshRoute(state)
  if (route.kind !== 'room' && route.kind !== 'direct') return state
  if (!route.pane) return state
  const { pane: _pane, ...primaryRoute } = route
  return navigateMesh(state, primaryRoute, { replace: true })
}

function updateRecents(
  recents: MeshRecentDestination[],
  route: MeshRoute,
  now: number,
): MeshRecentDestination[] {
  if (!['community', 'room', 'direct', 'voice'].includes(route.kind)) return recents
  const recentRoute = route as MeshRecentRoute
  const key = meshRouteKey(recentRoute)
  return [
    { route: recentRoute, lastOpenedAt: Number.isFinite(now) ? now : 0 },
    ...recents.filter((recent) => meshRouteKey(recent.route) !== key),
  ].slice(0, MAX_MESH_RECENT_DESTINATIONS)
}

export function meshNavigationStorageKey(accountId: string): string {
  return `mesh-navigation-v1:${encodeURIComponent(accountId)}`
}

export function serializeMeshNavigation(state: MeshNavigationSnapshot): string {
  return JSON.stringify(state)
}

export function restoreMeshNavigation(
  serialized: string | null,
  accountId: string,
): MeshNavigationSnapshot {
  if (!serialized) return emptyMeshNavigation(accountId)
  try {
    const value = JSON.parse(serialized) as Partial<MeshNavigationSnapshot>
    if (
      value.schemaVersion !== MESH_NAVIGATION_SCHEMA_VERSION
      || value.accountId !== accountId
      || !Array.isArray(value.entries)
      || !Array.isArray(value.recents)
    ) {
      return emptyMeshNavigation(accountId)
    }
    const entries = value.entries.filter(isMeshRoute).slice(-MAX_MESH_ROUTE_HISTORY)
    if (entries.length === 0) return emptyMeshNavigation(accountId)
    const index = typeof value.index === 'number' && Number.isInteger(value.index)
      ? Math.max(0, Math.min(entries.length - 1, value.index))
      : entries.length - 1
    const recents = value.recents
      .filter(isRecentDestination)
      .slice(0, MAX_MESH_RECENT_DESTINATIONS)
    return {
      schemaVersion: MESH_NAVIGATION_SCHEMA_VERSION,
      accountId,
      entries,
      index,
      recents,
    }
  } catch {
    return emptyMeshNavigation(accountId)
  }
}

function isRecentDestination(value: unknown): value is MeshRecentDestination {
  if (!value || typeof value !== 'object') return false
  const recent = value as Partial<MeshRecentDestination>
  return typeof recent.lastOpenedAt === 'number'
    && isMeshRoute(recent.route)
    && ['community', 'room', 'direct', 'voice'].includes(recent.route.kind)
}
