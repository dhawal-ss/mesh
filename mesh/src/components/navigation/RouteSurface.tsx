import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type {
  CommunitiesMode,
  CommunityAdminSection,
  MeshRecentDestination,
  MeshRoute,
  YouSection,
} from '../../lib/mesh-navigation'
import { matrixProfileIdentity, resolveSenderIdentity } from '../../lib/matrixIdentity'
import * as bridge from '../../lib/bridge'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useMeshNavigationStore } from '../../store/navigation'
import { useShellStore } from '../../store/shell'
import { useVoiceStore } from '../../store/voice'
import { isBackupReminderDue, isRoomSilenced, useSettingsStore } from '../../store/settings'
import {
  attentionFirst,
  calloutsFirst,
  type MutedLookup,
} from '../../lib/attention-ranking'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import { SectionHeader } from '../ui/Primitives'
import type { UserSettingsTab } from '../settings/UserSettingsPanel'
import type { CreateCommunityTab } from '../community/CreateCommunityModal'
import { clearVolatileInviteLink, getVolatileInviteLink } from '../../lib/pending-invitation-runtime'
import { playInterfaceSound } from '../../lib/interface-sounds'
import { shouldExposeVoiceRoutes } from '../../lib/voice-runtime'
import type { Channel } from '../../types/ipc'

const InvitationSurface = lazy(() =>
  import('../onboarding/InvitationConfirmation').then((module) => ({
    default: module.InvitationSurface,
  })),
)

const UserSettingsPanel = lazy(() =>
  import('../settings/UserSettingsPanel').then((module) => ({
    default: module.UserSettingsPanel,
  })),
)

const CreateCommunityModal = lazy(() =>
  import('../community/CreateCommunityModal').then((module) => ({
    default: module.CreateCommunityModal,
  })),
)

const CommunitySettings = lazy(() =>
  import('../community/CommunitySettings').then((module) => ({
    default: module.CommunitySettings,
  })),
)

export function RouteSurface({
  route,
  onSignInRequired,
}: {
  route: Exclude<MeshRoute, { kind: 'home' | 'inbox' | 'room' | 'direct-list' | 'direct' | 'voice' }>
  onSignInRequired: () => void
}) {
  if (route.kind === 'community') return <CommunityDeskSurface communityId={route.communityId} />
  if (route.kind === 'communities') return <CommunitiesRouteSurface mode={route.mode} />
  if (route.kind === 'you') return <YouRouteSurface section={route.section} />
  if (route.kind === 'invitation') {
    return <InvitationRouteSurface handle={route.handle} onSignInRequired={onSignInRequired} />
  }
  return <CommunityAdminRouteSurface communityId={route.communityId} section={route.section} />
}

function CommunityDeskSurface({ communityId }: { communityId: string }) {
  const community = useCommunityStore((state) => state.communityEntities[communityId])
  const channels = useChannelStore((state) => state.channels)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const membersByRoom = useVoiceStore((state) => state.matrixRtcMembersByRoom)
  const currentVoiceRoom = useVoiceStore((state) => state.currentChannelId)
  const voicePeers = useVoiceStore((state) => state.peers)
  const voiceConnection = useVoiceStore((state) => state.connectionState)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const navigationRecents = useMeshNavigationStore((state) => state.recents)
  const communityChannels = channels.filter((channel) => channel.communityId === communityId)
  const voiceRoutesEnabled = shouldExposeVoiceRoutes(
    bridge.isMatrixBackend(),
    bridge.getBackendStatusSnapshot(),
  )
  const liveRooms = voiceRoutesEnabled ? communityChannels.filter((channel) => {
    if (channel.channelType !== 'voice') return false
    if ((membersByRoom[channel.id]?.length ?? 0) > 0) return true
    return channel.id === currentVoiceRoom
      && voicePeers.length > 0
      && ['connected', 'reconnecting', 'degraded'].includes(voiceConnection)
  }) : []
  const notifications = useSettingsStore((state) => state.notifications)
  const isMuted = (channel: Channel) => isRoomSilenced(notifications, channel.id, communityId)
  const recentRooms = recentCommunityTextRooms(channels, navigationRecents, communityId)
  const shownRooms = communityDeskTextRooms(
    channels,
    navigationRecents,
    communityId,
    undefined,
    isMuted,
  )
  const [featuredRoom, ...additionalRooms] = shownRooms
  const textRoomCount = communityChannels.filter((channel) => channel.channelType === 'text').length
  const hiddenRoomCount = Math.max(0, textRoomCount - shownRooms.length)

  const openTextRoom = (channel: Channel) => {
    setActiveChannel(channel.id)
    navigate({ kind: 'room', communityId, roomId: channel.id })
  }

  if (!community) {
    return (
      <SimpleSurface
        title="Community unavailable"
        detail="This community is no longer available."
        action={<Button onClick={() => navigate({ kind: 'home' })}>Back to home</Button>}
      />
    )
  }

  return (
    <section className="mesh-dm-landing flex min-h-0 flex-1 items-start overflow-y-auto" aria-labelledby="mesh-community-heading">
      <div className="mesh-dm-landing-inner w-full">
        <header className="mesh-dm-landing-header grid gap-5 border-b border-border-subtle pb-7">
          <div>
            <p className="font-mono text-caption font-semibold lowercase tracking-eyebrow text-content-secondary">
              Community · {formatCommunityRole(community.role)}
            </p>
            <h1
              id="mesh-community-heading"
              data-mesh-route-heading
              tabIndex={-1}
              className="mesh-dm-landing-title mt-3 font-semibold text-primary outline-none"
            >
              {community.name}
            </h1>
            <p className="mt-4 max-w-2xl text-sm text-secondary">
              {community.description || 'A place to talk, share, and spend time together.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-meta text-muted">
            <span>{community.memberCount} members</span>
            <span>{textRoomCount} {textRoomCount === 1 ? 'room' : 'rooms'}</span>
          </div>
        </header>

        {featuredRoom ? (
          <button
            type="button"
            className="mesh-dm-lead grid w-full gap-4 border-b border-border-subtle text-left"
            onClick={() => openTextRoom(featuredRoom)}
            aria-label={`Open room ${featuredRoom.name}`}
          >
            <span className="mesh-dm-lead-index font-mono text-caption font-semibold lowercase tracking-eyebrow text-content-secondary">
              01 · {recentRooms.length > 0 ? 'Continue' : 'Start here'}
              {featuredRoom.unreadCount > 0 ? ` · ${featuredRoom.unreadCount} unread` : ''}
            </span>
            <span className="flex h-12 w-12 items-center justify-center border border-border-subtle text-accent">
              <Icon name="hash" size="lg" />
            </span>
            <span className="mesh-dm-lead-copy min-w-0">
              <span className="mesh-dm-lead-title block truncate font-semibold text-primary">
                {featuredRoom.name}
              </span>
              <span className="mt-1 block max-w-2xl text-sm text-secondary">
                {featuredRoom.unreadCount > 0
                  ? `${featuredRoom.unreadCount} unread ${featuredRoom.unreadCount === 1 ? 'message' : 'messages'} waiting.`
                  : recentRooms.length > 0
                    ? 'Your most recently opened room.'
                    : 'A good place to begin.'}
              </span>
            </span>
            <span className="mesh-dm-lead-action flex items-center gap-3 font-semibold text-primary">
              Open room
              <Icon name="arrowRight" size="sm" />
            </span>
          </button>
        ) : (
          <div className="border-b border-border-subtle py-8">
            <p className="font-semibold text-primary">No rooms yet</p>
            <p className="mt-1 text-sm text-muted">Rooms will appear here when they are added.</p>
          </div>
        )}

        {additionalRooms.length > 0 && (
          <section className="mesh-dm-landing-recent" aria-labelledby="mesh-community-rooms-heading">
            <SectionHeader
              id="mesh-community-rooms-heading"
              headingLevel={2}
              title="More rooms"
              count={additionalRooms.length}
              className="border-b border-border-subtle py-2"
            />
            {additionalRooms.map((channel, index) => (
              <button
                key={channel.id}
                type="button"
                className="mesh-dm-landing-row flex w-full items-center gap-3 border-b border-border-subtle text-left hover:bg-surface-hover"
                onClick={() => openTextRoom(channel)}
                aria-label={`Open room ${channel.name}`}
              >
                <span className="font-mono text-meta text-accent">{String(index + 2).padStart(2, '0')}</span>
                <Icon name="hash" size="sm" className="text-muted" />
                <span className="min-w-0 flex-1 truncate font-semibold text-primary">{channel.name}</span>
                {channel.unreadCount > 0 && (
                  <span className="font-mono text-meta text-accent">{Math.min(channel.unreadCount, 999)}</span>
                )}
                <Icon name="arrowRight" size="sm" className="text-muted" />
              </button>
            ))}
            {hiddenRoomCount > 0 && (
              // The desk is a shortlist, not the room index. Saying so keeps the
              // room count in the header from reading as a miscount.
              <p className="border-b border-border-subtle py-2 font-mono text-meta text-muted">
                {hiddenRoomCount} more {hiddenRoomCount === 1 ? 'room' : 'rooms'} in the room list
              </p>
            )}
          </section>
        )}

        {voiceRoutesEnabled && <div className="mt-6">
          <RuledSection title="Live now" count={liveRooms.length}>
            {liveRooms.length === 0 ? (
              <RouteEmpty text="Open a voice room to start a call." />
            ) : liveRooms.map((channel) => {
              const occupancy = Math.max(
                membersByRoom[channel.id]?.length ?? 0,
                channel.id === currentVoiceRoom ? voicePeers.length + 1 : 0,
              )
              return (
                <button
                  key={channel.id}
                  type="button"
                  className="mesh-home-row flex w-full items-center gap-3 border-b border-border-subtle text-left hover:bg-surface-hover"
                  onClick={() => {
                    setActiveChannel(channel.id)
                    navigate({ kind: 'voice', communityId, roomId: channel.id })
                  }}
                >
                  <Icon name="volume" size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-primary">{channel.name}</span>
                    <span className="block text-meta text-muted">{occupancy} in call</span>
                  </span>
                  <span className="font-semibold text-accent">Open</span>
                </button>
              )
            })}
          </RuledSection>
        </div>}
      </div>
    </section>
  )
}

function formatCommunityRole(role: 'owner' | 'admin' | 'member') {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

export function recentCommunityTextRooms(
  channels: Channel[],
  recents: MeshRecentDestination[],
  communityId: string,
  limit = 5,
): Channel[] {
  const channelsById = new Map(channels.map((channel) => [channel.id, channel] as const))
  const seen = new Set<string>()

  return [...recents]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .flatMap((recent) => {
      if (recent.route.kind !== 'room' || recent.route.communityId !== communityId) return []
      const channel = channelsById.get(recent.route.roomId)
      if (!channel || channel.channelType !== 'text' || seen.has(channel.id)) return []
      seen.add(channel.id)
      return [channel]
    })
    .slice(0, Math.max(0, limit))
}

export function communityDeskTextRooms(
  channels: Channel[],
  recents: MeshRecentDestination[],
  communityId: string,
  limit = 5,
  isMuted: MutedLookup<Channel> = () => false,
): Channel[] {
  const recentRooms = recentCommunityTextRooms(channels, recents, communityId, limit)
  const seen = new Set(recentRooms.map((channel) => channel.id))
  const remainingRooms = channels.filter((channel) => (
    channel.communityId === communityId
    && channel.channelType === 'text'
    && !seen.has(channel.id)
  ))
  // Recents keep their navigation recency; only a callout is allowed to jump
  // that queue. The remainder arrives in server order, which carries no meaning
  // for this person, so a room waiting on them goes ahead of one they have read
  // Otherwise the cap below can drop the only room that needed opening.
  return [
    ...calloutsFirst(recentRooms, isMuted),
    ...attentionFirst(remainingRooms, isMuted),
  ].slice(0, Math.max(0, limit))
}

export function starterCommunityTextRooms(
  channels: Channel[],
  communityId: string,
  limit = 3,
): Channel[] {
  return channels
    .filter((channel) => (
      channel.communityId === communityId && channel.channelType === 'text'
    ))
    .slice(0, Math.max(0, limit))
}

type CommunityActionKey = 'find' | 'join' | 'create'

/**
 * The community actions this surface offers.
 *
 * `route` is the mode this action restores from `MeshRoute`. Finding a
 * community has none yet: `CommunitiesMode` in `src/lib/mesh-navigation.ts`
 * only knows `join` and `create`, so Find is selectable but not yet
 * deep-linkable. Adding `discover` to that union makes it a full route with no
 * other change here.
 */
const COMMUNITY_MODES: Array<{
  key: CommunityActionKey
  route: CommunitiesMode | null
  title: string
  detail: string
  icon: IconName
  tab: CreateCommunityTab
}> = [
  {
    key: 'find',
    route: null,
    title: 'Find a community',
    detail: 'Search the public communities your account service lists.',
    icon: 'compass',
    tab: 'discover',
  },
  {
    key: 'join',
    route: 'join',
    title: 'Join with an invitation',
    detail: 'Open a community invitation and keep your account service choice separate.',
    icon: 'userPlus',
    tab: 'join',
  },
  {
    key: 'create',
    route: 'create',
    title: 'Create a community',
    detail: 'Start a community with rooms for your members.',
    icon: 'plus',
    tab: 'create',
  },
]

function CommunitiesRouteSurface({ mode }: { mode: CommunitiesMode }) {
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const routeEntry = COMMUNITY_MODES.find((entry) => entry.route === mode) ?? COMMUNITY_MODES[1]
  // Find has no route of its own yet, so the selection is held here. Any route
  // change wins over it, which keeps history and restore behaving.
  const [routelessKey, setRoutelessKey] = useState<CommunityActionKey | null>(null)
  const currentEntry = COMMUNITY_MODES.find((entry) => entry.key === routelessKey) ?? routeEntry
  const modeRefs = useRef<Partial<Record<CommunityActionKey, HTMLButtonElement>>>({})

  useEffect(() => {
    setRoutelessKey(null)
  }, [mode])

  const selectMode = (next: (typeof COMMUNITY_MODES)[number], focus = false) => {
    setRoutelessKey(next.route ? null : next.key)
    if (next.route) navigate({ kind: 'communities', mode: next.route }, { replace: true })
    if (focus) window.requestAnimationFrame(() => modeRefs.current[next.key]?.focus())
  }

  const moveModeFocus = (event: React.KeyboardEvent<HTMLButtonElement>, current: CommunityActionKey) => {
    const currentIndex = COMMUNITY_MODES.findIndex((entry) => entry.key === current)
    let nextIndex = currentIndex
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % COMMUNITY_MODES.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + COMMUNITY_MODES.length) % COMMUNITY_MODES.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = COMMUNITY_MODES.length - 1
    else return
    event.preventDefault()
    selectMode(COMMUNITY_MODES[nextIndex], true)
  }

  return (
    <section className="mesh-route-surface flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="mesh-communities-heading">
      <SurfaceHeader
        id="mesh-communities-heading"
        title="Communities"
      />
      <label className="border-b border-border-subtle bg-surface-sunken px-shell-gutter py-3 text-xs font-medium text-secondary md:hidden">
        Community action
        <select
          value={currentEntry.key}
          onChange={(event) => {
            const next = COMMUNITY_MODES.find((entry) => entry.key === event.target.value)
            if (next) selectMode(next)
          }}
          className="mt-1 block min-h-11 w-full rounded-control border border-border-control bg-surface-raised px-3 text-sm text-primary"
        >
          {COMMUNITY_MODES.map((entry) => <option key={entry.key} value={entry.key}>{entry.title}</option>)}
        </select>
      </label>
      <div className="grid min-h-0 flex-1 md:grid-cols-route">
        <nav className="mesh-route-navigation hidden min-h-0 border-r border-border-subtle bg-surface-sunken px-3 py-3 md:block" aria-label="Community actions">
          <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-1">
            {COMMUNITY_MODES.map((entry) => (
              <button
                key={entry.key}
                ref={(element) => { modeRefs.current[entry.key] = element ?? undefined }}
                id={`mesh-communities-tab-${entry.key}`}
                type="button"
                role="tab"
                aria-selected={currentEntry.key === entry.key}
                aria-controls="mesh-communities-panel"
                tabIndex={currentEntry.key === entry.key ? 0 : -1}
                className={`mesh-route-tab min-h-11 rounded-control px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
                  currentEntry.key === entry.key ? 'bg-container-accent text-primary' : 'text-secondary hover:bg-surface-hover hover:text-primary'
                }`}
                onClick={() => selectMode(entry)}
                onKeyDown={(event) => moveModeFocus(event, entry.key)}
              >
                <span className="flex items-center gap-2 text-sm font-semibold"><Icon name={entry.icon} size="sm" />{entry.title}</span>
              </button>
            ))}
          </div>
        </nav>
        <div
          id="mesh-communities-panel"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`mesh-communities-tab-${currentEntry.key}`}
          className="mesh-route-main min-h-0 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-3xl px-shell-gutter py-6">
            <div className="mb-5">
              <p className="text-caption font-semibold lowercase tracking-eyebrow text-content-secondary">Community action</p>
              <h2 className="mt-1 text-title font-semibold text-primary">
                {currentEntry.title}
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-muted">{currentEntry.detail}</p>
            </div>
            <Suspense fallback={<SimpleSurface title={`Opening ${currentEntry.title}`} />}>
              <CreateCommunityModal
                embedded
                isOpen
                initialInvite={getVolatileInviteLink()}
                activeTab={currentEntry.tab}
                onTabChange={(tab) => {
                  const next = COMMUNITY_MODES.find((entry) => entry.tab === tab)
                  if (next) selectMode(next)
                }}
                onClose={() => {
                  clearVolatileInviteLink()
                  const communityId = useCommunityStore.getState().activeCommunityId ?? activeCommunityId
                  navigate(communityId ? { kind: 'community', communityId } : { kind: 'home' })
                }}
              />
            </Suspense>
          </div>
        </div>
      </div>
    </section>
  )
}

const YOU_SECTIONS: Array<{
  section: Exclude<YouSection, 'privacy-voice'>
  settingsSection: UserSettingsTab
  title: string
  detail: string
}> = [
  { section: 'account', settingsSection: 'account', title: 'Account', detail: 'Your account service and recovery status.' },
  { section: 'notifications', settingsSection: 'notifications', title: 'Notifications', detail: 'Alerts, quiet hours, and message privacy.' },
  { section: 'appearance', settingsSection: 'appearance', title: 'Appearance', detail: 'Theme, spacing, and accent colors.' },
  { section: 'audio-video', settingsSection: 'audio-video', title: 'Audio and video', detail: 'Input, output, camera, and call preferences.' },
  { section: 'profile', settingsSection: 'profile', title: 'Profile', detail: 'Name, avatar, and how people see you.' },
  { section: 'privacy', settingsSection: 'privacy', title: 'Privacy', detail: 'Presence, receipts, and conversation privacy.' },
  { section: 'safety-devices', settingsSection: 'devices', title: 'Safety and devices', detail: 'Security, sessions, and trusted devices.' },
  { section: 'beta', settingsSection: 'beta', title: 'Beta', detail: 'Version, feedback, known issues, updates, and privacy.' },
  { section: 'advanced', settingsSection: 'advanced', title: 'Advanced', detail: 'Connection check and account service details.' },
]

const PRIMARY_YOU_SECTION_IDS = new Set<YouSection>([
  'account',
  'notifications',
  'appearance',
  'audio-video',
])

const PRIMARY_YOU_SECTIONS = YOU_SECTIONS.filter((entry) => (
  PRIMARY_YOU_SECTION_IDS.has(entry.section)
))

function InvitationRouteSurface({
  handle,
  onSignInRequired,
}: {
  handle: string
  onSignInRequired: () => void
}) {
  const pending = useShellStore((state) => state.pendingInvitation)
  const communityName = pending?.handle === handle
    ? pending.communityName?.trim() || 'your community'
    : 'your community'
  return (
    <Suspense
      fallback={(
        <SimpleSurface
          title={`Opening invitation to ${communityName}`}
        />
      )}
    >
      <InvitationSurface handle={handle} onSignInRequired={onSignInRequired} />
    </Suspense>
  )
}

function YouRouteSurface({ section }: { section: YouSection }) {
  const storedIdentity = useIdentityStore((state) => state.identity)
  const setIdentity = useIdentityStore((state) => state.setIdentity)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const setSecurityOpen = useShellStore((state) => state.setSecurityOpen)
  const setFeedbackOpen = useShellStore((state) => state.setFeedbackOpen)
  const backupReminderDue = useSettingsStore((state) => isBackupReminderDue(state.backup))
  const matrixMode = bridge.isMatrixBackend()
  const matrixAccountId = matrixMode ? bridge.getMatrixUserId() : null
  const identity = resolveSenderIdentity(storedIdentity, matrixAccountId)
  // Audio and video is call copy and nothing else. UserSettingsPanel already
  // drops that tab where a call cannot be opened, so the route has to drop it
  // too: otherwise the nav keeps offering a destination whose panel silently
  // falls back to Account, and the header names a section the body is not.
  const voiceRoutesEnabled = matrixMode
    && shouldExposeVoiceRoutes(matrixMode, bridge.getBackendStatusSnapshot())
  const primaryYouSections = voiceRoutesEnabled
    ? PRIMARY_YOU_SECTIONS
    : PRIMARY_YOU_SECTIONS.filter((entry) => entry.section !== 'audio-video')
  const effectiveSection = section === 'privacy-voice'
    ? 'privacy'
    : section === 'audio-video' && !voiceRoutesEnabled
      ? 'account'
      : section
  const sectionRefs = useRef<Partial<Record<YouSection, HTMLButtonElement>>>({})
  const currentEntry = YOU_SECTIONS.find((entry) => entry.section === effectiveSection) ?? YOU_SECTIONS[0]
  const currentPrimaryEntry = primaryYouSections.find((entry) => (
    entry.section === effectiveSection
  ))

  const selectSection = (next: (typeof YOU_SECTIONS)[number], focus = false) => {
    navigate({ kind: 'you', section: next.section }, { replace: true })
    if (focus) window.requestAnimationFrame(() => sectionRefs.current[next.section]?.focus())
  }

  const moveSectionFocus = (event: React.KeyboardEvent<HTMLButtonElement>, current: YouSection) => {
    const currentIndex = primaryYouSections.findIndex((entry) => entry.section === current)
    let nextIndex = currentIndex
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % primaryYouSections.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + primaryYouSections.length) % primaryYouSections.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = primaryYouSections.length - 1
    else return
    event.preventDefault()
    selectSection(primaryYouSections[nextIndex], true)
  }

  return (
    <section className="mesh-route-surface flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="mesh-you-heading">
      <SurfaceHeader
        id="mesh-you-heading"
        title="You"
        detail={identity?.displayName}
      />
      <div className="border-b border-border-subtle bg-surface-sunken px-shell-gutter py-3 md:hidden">
        {currentPrimaryEntry ? (
          <>
            <label htmlFor="mesh-you-section" className="block text-xs font-medium text-secondary">
              Settings section
            </label>
            <select
              id="mesh-you-section"
              value={effectiveSection}
              onChange={(event) => {
                const next = primaryYouSections.find((entry) => entry.section === event.target.value)
                if (next) selectSection(next)
              }}
              className="mt-1 block min-h-11 w-full rounded-control border border-border-control bg-surface-raised px-3 text-sm text-primary"
            >
              {primaryYouSections.map((entry) => <option key={entry.section} value={entry.section}>{entry.title}</option>)}
            </select>
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => selectSection(primaryYouSections[0])}
          >
            Back to account
          </Button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 md:grid-cols-route">
        <nav className="mesh-route-navigation hidden min-h-0 border-r border-border-subtle bg-surface-sunken px-3 py-3 md:block" aria-label="You sections">
          {!currentPrimaryEntry && (
            <Button
              variant="ghost"
              size="sm"
              className="mb-3 w-full justify-start"
              onClick={() => selectSection(primaryYouSections[0])}
            >
              Back to account
            </Button>
          )}
          <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-1">
            {primaryYouSections.map((entry) => (
              <button
                key={entry.section}
                ref={(element) => { sectionRefs.current[entry.section] = element ?? undefined }}
                id={`mesh-you-tab-${entry.section}`}
                type="button"
                role="tab"
                aria-selected={effectiveSection === entry.section}
                aria-controls="mesh-you-panel"
                tabIndex={effectiveSection === entry.section ? 0 : -1}
                className={`mesh-route-tab min-h-11 rounded-control px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
                  effectiveSection === entry.section ? 'bg-container-accent text-primary' : 'text-secondary hover:bg-surface-hover hover:text-primary'
                }`}
                onClick={() => selectSection(entry)}
                onKeyDown={(event) => moveSectionFocus(event, entry.section)}
              >
                <span className="block text-sm font-semibold">{entry.title}</span>
              </button>
            ))}
          </div>
        </nav>
        {/*
          Named with aria-label rather than a hidden heading. Each settings
          panel already renders its own visible heading with the same words, so
          a screen-reader user met "Advanced" twice in a row and the region
          owned two headings of the same name. It is not named by its tab
          either: five of the nine sections are reachable without one, so an
          aria-labelledby would dangle exactly where this panel opens most.
        */}
        <div
          id="mesh-you-panel"
          role="tabpanel"
          tabIndex={0}
          aria-label={currentEntry.title}
          className="mesh-route-main min-h-0 overflow-hidden"
        >
          <Suspense
            fallback={<SimpleSurface title={`Opening ${currentEntry.title}`} />}
          >
            <UserSettingsPanel
              key={currentEntry.settingsSection}
              embedded
              open
              onClose={() => navigate({ kind: 'home' })}
              identity={identity}
              matrixAccountId={matrixAccountId}
              matrixMode={matrixMode}
              activeSection={currentEntry.settingsSection}
              onSectionChange={(settingsSection) => {
                const next = YOU_SECTIONS.find((entry) => entry.settingsSection === settingsSection)
                if (next) selectSection(next)
              }}
              onUpdateDisplayName={async (displayName) => {
                const profile = await bridge.matrixUpdateProfileDisplayName(displayName)
                setIdentity(matrixProfileIdentity(profile))
              }}
              onOpenSecurity={() => setSecurityOpen(true)}
              onOpenFeedback={() => setFeedbackOpen(true)}
              backupReminderDue={backupReminderDue}
              onTestNotification={async () => {
                await bridge.sendTestNotification()
                await playInterfaceSound('message-direct', { preview: true })
              }}
            />
          </Suspense>
        </div>
      </div>
    </section>
  )
}

const COMMUNITY_ADMIN_SECTIONS: Array<{
  section: CommunityAdminSection
  title: string
  detail: string
}> = [
  { section: 'general', title: 'General', detail: 'Name, description, image, and service facts.' },
  { section: 'people-roles', title: 'People and roles', detail: 'Membership, moderation, and verified role impact.' },
  { section: 'rooms-voice', title: 'Rooms and voice', detail: 'Create and organize places for your members.' },
  { section: 'invitations', title: 'Invitations', detail: 'Create destination-owned ways to join.' },
  { section: 'discovery-access', title: 'Join requests', detail: 'Approve or decline people asking to join.' },
  { section: 'moderation', title: 'Moderation', detail: 'Confirmed actions and per-room outcomes.' },
  { section: 'danger', title: 'Danger', detail: 'Leave or legacy local deletion with confirmation.' },
]

function CommunityAdminRouteSurface({
  communityId,
  section,
}: {
  communityId: string
  section: CommunityAdminSection
}) {
  const community = useCommunityStore((state) => state.communityEntities[communityId])
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const sectionRefs = useRef<Partial<Record<CommunityAdminSection, HTMLButtonElement>>>({})
  const currentEntry = COMMUNITY_ADMIN_SECTIONS.find((entry) => entry.section === section)
    ?? COMMUNITY_ADMIN_SECTIONS[0]

  const selectSection = (next: (typeof COMMUNITY_ADMIN_SECTIONS)[number], focus = false) => {
    navigate({ kind: 'community-admin', communityId, section: next.section }, { replace: true })
    if (focus) window.requestAnimationFrame(() => sectionRefs.current[next.section]?.focus())
  }

  const moveSectionFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: CommunityAdminSection,
  ) => {
    const currentIndex = COMMUNITY_ADMIN_SECTIONS.findIndex((entry) => entry.section === current)
    let nextIndex = currentIndex
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % COMMUNITY_ADMIN_SECTIONS.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + COMMUNITY_ADMIN_SECTIONS.length) % COMMUNITY_ADMIN_SECTIONS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = COMMUNITY_ADMIN_SECTIONS.length - 1
    else return
    event.preventDefault()
    selectSection(COMMUNITY_ADMIN_SECTIONS[nextIndex], true)
  }

  if (!community) {
    return (
      <SimpleSurface
        title="Community administration unavailable"
        detail="This community is no longer available from your current account."
        action={<Button onClick={() => navigate({ kind: 'home' })}>Back to home</Button>}
      />
    )
  }

  return (
    <section className="mesh-route-surface flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="mesh-community-admin-heading">
      <SurfaceHeader
        id="mesh-community-admin-heading"
        title="Community administration"
        detail={`${community.name} · Changes stay limited to the permissions this community reports.`}
        action={(
          <Button
            variant="secondary"
            size="sm"
            aria-label="Back to community"
            onClick={() => navigate({ kind: 'community', communityId })}
          >
            <span aria-hidden="true" className="sm:hidden">Back</span>
            <span className="hidden sm:inline">Back to community</span>
          </Button>
        )}
      />
      <label className="border-b border-border-subtle bg-surface-sunken px-shell-gutter py-3 text-xs font-medium text-secondary md:hidden">
        Administration section
        <select
          value={section}
          onChange={(event) => {
            const next = COMMUNITY_ADMIN_SECTIONS.find((entry) => entry.section === event.target.value)
            if (next) selectSection(next)
          }}
          className="mt-1 block min-h-11 w-full rounded-control border border-border-control bg-surface-raised px-3 text-sm text-primary"
        >
          {COMMUNITY_ADMIN_SECTIONS.map((entry) => (
            <option key={entry.section} value={entry.section}>{entry.title}</option>
          ))}
        </select>
      </label>
      <div className="grid min-h-0 flex-1 md:grid-cols-route">
        <nav className="mesh-route-navigation hidden min-h-0 overflow-y-auto border-r border-border-subtle bg-surface-sunken px-3 py-3 md:block" aria-label="Community administration sections">
          <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-1">
            {COMMUNITY_ADMIN_SECTIONS.map((entry) => (
              <button
                key={entry.section}
                ref={(element) => { sectionRefs.current[entry.section] = element ?? undefined }}
                id={`mesh-community-admin-tab-${entry.section}`}
                type="button"
                role="tab"
                aria-selected={section === entry.section}
                aria-controls="mesh-community-admin-panel"
                tabIndex={section === entry.section ? 0 : -1}
                className={`mesh-route-tab min-h-11 rounded-control px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
                  section === entry.section ? 'bg-container-accent text-primary' : 'text-secondary hover:bg-surface-hover hover:text-primary'
                }`}
                onClick={() => selectSection(entry)}
                onKeyDown={(event) => moveSectionFocus(event, entry.section)}
              >
                <span className="block text-sm font-semibold">{entry.title}</span>
              </button>
            ))}
          </div>
        </nav>
        <div
          id="mesh-community-admin-panel"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`mesh-community-admin-tab-${currentEntry.section}`}
          className="mesh-route-main min-h-0 overflow-hidden"
        >
          {/* Kept for heading order: the settings body below opens at h3. */}
          <h2 className="sr-only">{currentEntry.title} for {community.name}</h2>
          <Suspense fallback={<SimpleSurface title={`Opening ${currentEntry.title}`} />}>
            <CommunitySettings
              embedded
              isOpen
              activeSection={currentEntry.section}
              onClose={() => navigate({ kind: 'community', communityId })}
            />
          </Suspense>
        </div>
      </div>
    </section>
  )
}

function SimpleSurface({
  title,
  detail,
  action,
}: {
  title: string
  detail?: string
  action?: React.ReactNode
}) {
  return (
    <section className="mesh-route-surface flex min-h-0 flex-1 flex-col" aria-labelledby="mesh-simple-route-heading">
      <SurfaceHeader id="mesh-simple-route-heading" title={title} detail={detail} action={action} />
    </section>
  )
}

function SurfaceHeader({
  id,
  title,
  detail,
  action,
}: {
  id: string
  title: string
  /** Only when a reader would act differently for having read it. */
  detail?: string
  action?: React.ReactNode
}) {
  return (
    <header className="mesh-route-header flex flex-shrink-0 items-center gap-3 border-b border-border-subtle px-shell-gutter py-2">
      <div className="min-w-0 flex-1">
        <h1
          id={id}
          data-mesh-route-heading
          tabIndex={-1}
          className="text-title font-semibold text-primary outline-none sm:truncate"
        >
          {title}
        </h1>
        {detail && <p className="text-meta text-muted sm:truncate">{detail}</p>}
      </div>
      {action}
    </header>
  )
}

function RuledSection({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  const id = `mesh-route-${title.toLocaleLowerCase().replace(/\s+/g, '-')}`
  return (
    <section aria-labelledby={id}>
      <SectionHeader
        id={id}
        headingLevel={2}
        title={title}
        count={count}
        className="border-b border-border-subtle px-shell-gutter py-2"
      />
      {children}
    </section>
  )
}

function RouteEmpty({ text }: { text: string }) {
  return <p className="border-b border-border-subtle px-shell-gutter py-4 text-sm text-muted">{text}</p>
}
