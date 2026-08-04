import { lazy, Suspense, useRef } from 'react'
import type { CommunityAdminSection, MeshRoute, YouSection } from '../../lib/mesh-navigation'
import { matrixProfileIdentity, resolveSenderIdentity } from '../../lib/matrixIdentity'
import * as bridge from '../../lib/bridge'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useIdentityStore } from '../../store/identity'
import { useMeshNavigationStore } from '../../store/navigation'
import { useShellStore } from '../../store/shell'
import { useVoiceStore } from '../../store/voice'
import { isBackupReminderDue, useSettingsStore } from '../../store/settings'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import type { UserSettingsTab } from '../settings/UserSettingsPanel'
import type { CreateCommunityTab } from '../community/CreateCommunityModal'
import { clearVolatileInviteLink, getVolatileInviteLink } from '../../lib/pending-invitation-runtime'
import { playInterfaceSound } from '../../lib/interface-sounds'

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

export function RouteSurface({ route }: { route: Exclude<MeshRoute, { kind: 'home' | 'room' | 'direct' | 'voice' }> }) {
  if (route.kind === 'community') return <CommunityLandingSurface communityId={route.communityId} />
  if (route.kind === 'communities') return <CommunitiesRouteSurface mode={route.mode} />
  if (route.kind === 'you') return <YouRouteSurface section={route.section} />
  if (route.kind === 'invitation') return <InvitationRouteSurface handle={route.handle} />
  return <CommunityAdminRouteSurface communityId={route.communityId} section={route.section} />
}

function CommunityLandingSurface({ communityId }: { communityId: string }) {
  const community = useCommunityStore((state) => state.communityEntities[communityId])
  const channels = useChannelStore((state) => state.channels)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const membersByRoom = useVoiceStore((state) => state.matrixRtcMembersByRoom)
  const currentVoiceRoom = useVoiceStore((state) => state.currentChannelId)
  const voicePeers = useVoiceStore((state) => state.peers)
  const voiceConnection = useVoiceStore((state) => state.connectionState)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const communityChannels = channels.filter((channel) => channel.communityId === communityId)
  const liveRooms = communityChannels.filter((channel) => {
    if (channel.channelType !== 'voice') return false
    if ((membersByRoom[channel.id]?.length ?? 0) > 0) return true
    return channel.id === currentVoiceRoom
      && voicePeers.length > 0
      && ['connected', 'reconnecting', 'degraded'].includes(voiceConnection)
  })
  const recentRooms = [...communityChannels]
    .filter((channel) => channel.channelType === 'text')
    .sort((left, right) => right.unreadCount - left.unreadCount)
    .slice(0, 5)

  if (!community) {
    return (
      <SimpleSurface
        title="Community unavailable"
        detail="This community is no longer available. Return Home and choose another destination."
        action={<Button onClick={() => navigate({ kind: 'home' })}>Back to Home</Button>}
      />
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto" aria-labelledby="mesh-community-heading">
      <SurfaceHeader
        id="mesh-community-heading"
        title={community.name}
        detail={`${community.memberCount} members · ${community.description || 'Choose where to jump in.'}`}
      />
      <RuledSection title="Live now" count={liveRooms.length}>
        {liveRooms.length === 0 ? (
          <RouteEmpty text="No parties live in this community right now." />
        ) : liveRooms.map((channel) => {
          const occupancy = Math.max(
            membersByRoom[channel.id]?.length ?? 0,
            channel.id === currentVoiceRoom ? voicePeers.length + 1 : 0,
          )
          return (
            <button
              key={channel.id}
              type="button"
              className="mesh-home-row w-full text-left hover:bg-surface-hover"
              onClick={() => {
                setActiveChannel(channel.id)
                navigate({ kind: 'voice', communityId, roomId: channel.id })
              }}
            >
              <Icon name="volume" size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-primary">{channel.name}</span>
                <span className="block text-meta text-muted">{occupancy} in party</span>
              </span>
              <span className="font-semibold text-accent">Open</span>
            </button>
          )
        })}
      </RuledSection>
      <RuledSection title="Recent rooms" count={recentRooms.length}>
        {recentRooms.length === 0 ? (
          <RouteEmpty text="Choose a room from the community navigation." />
        ) : recentRooms.map((channel) => (
          <button
            key={channel.id}
            type="button"
            className="mesh-home-row w-full text-left hover:bg-surface-hover"
            onClick={() => {
              setActiveChannel(channel.id)
              navigate({ kind: 'room', communityId, roomId: channel.id })
            }}
          >
            <Icon name="hash" size="md" />
            <span className="min-w-0 flex-1 truncate font-semibold text-primary">{channel.name}</span>
            {channel.unreadCount > 0 && (
              <span className="font-mono text-meta text-accent">{channel.unreadCount}</span>
            )}
          </button>
        ))}
      </RuledSection>
    </section>
  )
}

const COMMUNITY_MODES: Array<{
  mode: 'join' | 'browse' | 'create'
  title: string
  detail: string
  icon: IconName
  tab: CreateCommunityTab
}> = [
  {
    mode: 'join',
    title: 'Join with an invitation',
    detail: 'Open a community invitation and keep your account service choice separate.',
    icon: 'userPlus',
    tab: 'join',
  },
  {
    mode: 'browse',
    title: 'Browse communities',
    detail: 'Look through communities available from your current service.',
    icon: 'compass',
    tab: 'discover',
  },
  {
    mode: 'create',
    title: 'Create a community',
    detail: 'Start a community with rooms for your crew.',
    icon: 'plus',
    tab: 'create',
  },
]

function CommunitiesRouteSurface({ mode }: { mode: 'join' | 'browse' | 'create' }) {
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const currentEntry = COMMUNITY_MODES.find((entry) => entry.mode === mode) ?? COMMUNITY_MODES[0]
  const modeRefs = useRef<Partial<Record<typeof mode, HTMLButtonElement>>>({})

  const selectMode = (next: (typeof COMMUNITY_MODES)[number], focus = false) => {
    navigate({ kind: 'communities', mode: next.mode }, { replace: true })
    if (focus) window.requestAnimationFrame(() => modeRefs.current[next.mode]?.focus())
  }

  const moveModeFocus = (event: React.KeyboardEvent<HTMLButtonElement>, current: typeof mode) => {
    const currentIndex = COMMUNITY_MODES.findIndex((entry) => entry.mode === current)
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
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="mesh-communities-heading">
      <SurfaceHeader
        id="mesh-communities-heading"
        title="Communities"
        detail="Join a crew, find a public space, or start your own."
      />
      <label className="border-b border-border-subtle bg-surface-sunken px-party-gutter py-3 text-xs font-medium text-secondary md:hidden">
        Community action
        <select
          value={mode}
          onChange={(event) => {
            const next = COMMUNITY_MODES.find((entry) => entry.mode === event.target.value)
            if (next) selectMode(next)
          }}
          className="mt-1 block min-h-11 w-full rounded-control border border-border-control bg-surface-raised px-3 text-sm text-primary"
        >
          {COMMUNITY_MODES.map((entry) => <option key={entry.mode} value={entry.mode}>{entry.title}</option>)}
        </select>
      </label>
      <div className="grid min-h-0 flex-1 md:grid-cols-[250px_minmax(0,1fr)]">
        <nav className="hidden min-h-0 border-r border-border-subtle bg-surface-sunken px-3 py-3 md:block" aria-label="Community actions">
          <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-1">
            {COMMUNITY_MODES.map((entry) => (
              <button
                key={entry.mode}
                ref={(element) => { modeRefs.current[entry.mode] = element ?? undefined }}
                type="button"
                role="tab"
                aria-selected={mode === entry.mode}
                tabIndex={mode === entry.mode ? 0 : -1}
                className={`min-h-11 rounded-control px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  mode === entry.mode ? 'bg-accent/15 text-primary' : 'text-secondary hover:bg-surface-hover hover:text-primary'
                }`}
                onClick={() => selectMode(entry)}
                onKeyDown={(event) => moveModeFocus(event, entry.mode)}
              >
                <span className="flex items-center gap-2 text-sm font-semibold"><Icon name={entry.icon} size="sm" />{entry.title}</span>
                <span className="mt-1 block text-caption text-muted">{entry.detail}</span>
              </button>
            ))}
          </div>
        </nav>
        <main className="min-h-0 overflow-hidden" aria-labelledby={`mesh-communities-mode-${currentEntry.mode}`}>
          <h2 id={`mesh-communities-mode-${currentEntry.mode}`} className="sr-only">{currentEntry.title}</h2>
          <Suspense fallback={<SimpleSurface title={`Opening ${currentEntry.title}`} detail="Keeping the community action ready." />}>
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
        </main>
      </div>
    </section>
  )
}

const YOU_SECTIONS: Array<{
  section: YouSection
  settingsSection: UserSettingsTab
  title: string
  detail: string
}> = [
  { section: 'profile', settingsSection: 'profile', title: 'Profile', detail: 'Name, avatar, and how people see you.' },
  { section: 'account', settingsSection: 'account', title: 'Account', detail: 'Your account service and recovery status.' },
  { section: 'appearance', settingsSection: 'appearance', title: 'Appearance', detail: 'Theme, density, and Party Room accents.' },
  { section: 'notifications', settingsSection: 'notifications', title: 'Notifications', detail: 'Alerts, quiet hours, and message privacy.' },
  { section: 'privacy-voice', settingsSection: 'privacy', title: 'Privacy and voice', detail: 'Presence, receipts, and voice preferences.' },
  { section: 'safety-devices', settingsSection: 'devices', title: 'Safety and devices', detail: 'Security, sessions, and trusted devices.' },
  { section: 'advanced', settingsSection: 'advanced', title: 'Advanced', detail: 'Signal Check and compatible service details.' },
]

function InvitationRouteSurface({ handle }: { handle: string }) {
  const pending = useShellStore((state) => state.pendingInvitation)
  const communityName = pending?.handle === handle
    ? pending.communityName?.trim() || 'your community'
    : 'your community'
  return (
    <Suspense
      fallback={(
        <SimpleSurface
          title={`Opening invitation to ${communityName}`}
          detail="Keeping this destination ready while the invitation surface opens."
        />
      )}
    >
      <InvitationSurface handle={handle} />
    </Suspense>
  )
}

function YouRouteSurface({ section }: { section: YouSection }) {
  const storedIdentity = useIdentityStore((state) => state.identity)
  const setIdentity = useIdentityStore((state) => state.setIdentity)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const setSecurityOpen = useShellStore((state) => state.setSecurityOpen)
  const backupReminderDue = useSettingsStore((state) => isBackupReminderDue(state.backup))
  const matrixMode = bridge.isMatrixBackend()
  const matrixAccountId = matrixMode ? bridge.getMatrixUserId() : null
  const identity = resolveSenderIdentity(storedIdentity, matrixAccountId)
  const sectionRefs = useRef<Partial<Record<YouSection, HTMLButtonElement>>>({})
  const currentEntry = YOU_SECTIONS.find((entry) => entry.section === section) ?? YOU_SECTIONS[0]

  const selectSection = (next: (typeof YOU_SECTIONS)[number], focus = false) => {
    navigate({ kind: 'you', section: next.section }, { replace: true })
    if (focus) window.requestAnimationFrame(() => sectionRefs.current[next.section]?.focus())
  }

  const moveSectionFocus = (event: React.KeyboardEvent<HTMLButtonElement>, current: YouSection) => {
    const currentIndex = YOU_SECTIONS.findIndex((entry) => entry.section === current)
    let nextIndex = currentIndex
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % YOU_SECTIONS.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + YOU_SECTIONS.length) % YOU_SECTIONS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = YOU_SECTIONS.length - 1
    else return
    event.preventDefault()
    selectSection(YOU_SECTIONS[nextIndex], true)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="mesh-you-heading">
      <SurfaceHeader
        id="mesh-you-heading"
        title="You"
        detail={identity?.displayName ? `${identity.displayName} · Your Mesh` : 'Your Mesh'}
      />
      <label className="border-b border-border-subtle bg-surface-sunken px-party-gutter py-3 text-xs font-medium text-secondary md:hidden">
        You section
        <select
          value={section}
          onChange={(event) => {
            const next = YOU_SECTIONS.find((entry) => entry.section === event.target.value)
            if (next) selectSection(next)
          }}
          className="mt-1 block min-h-11 w-full rounded-control border border-border-control bg-surface-raised px-3 text-sm text-primary"
        >
          {YOU_SECTIONS.map((entry) => <option key={entry.section} value={entry.section}>{entry.title}</option>)}
        </select>
      </label>
      <div className="grid min-h-0 flex-1 md:grid-cols-[250px_minmax(0,1fr)]">
        <nav className="hidden min-h-0 border-r border-border-subtle bg-surface-sunken px-3 py-3 md:block" aria-label="You sections">
          <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-1">
            {YOU_SECTIONS.map((entry) => (
              <button
                key={entry.section}
                ref={(element) => { sectionRefs.current[entry.section] = element ?? undefined }}
                type="button"
                role="tab"
                aria-selected={section === entry.section}
                tabIndex={section === entry.section ? 0 : -1}
                className={`min-h-11 rounded-control px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  section === entry.section ? 'bg-accent/15 text-primary' : 'text-secondary hover:bg-surface-hover hover:text-primary'
                }`}
                onClick={() => selectSection(entry)}
                onKeyDown={(event) => moveSectionFocus(event, entry.section)}
              >
                <span className="block text-sm font-semibold">{entry.title}</span>
                <span className="mt-0.5 block text-caption text-muted">{entry.detail}</span>
              </button>
            ))}
          </div>
        </nav>
        <main className="min-h-0 overflow-hidden" aria-labelledby={`mesh-you-section-${currentEntry.section}`}>
          <h2 id={`mesh-you-section-${currentEntry.section}`} className="sr-only">{currentEntry.title}</h2>
          <Suspense
            fallback={<SimpleSurface title={`Opening ${currentEntry.title}`} detail="Keeping your saved settings available while this section opens." />}
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
              backupReminderDue={backupReminderDue}
              onTestNotification={async () => {
                await bridge.sendTestNotification()
                await playInterfaceSound('message-direct', { preview: true })
              }}
            />
          </Suspense>
        </main>
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
  { section: 'rooms-voice', title: 'Rooms and voice', detail: 'Create and organize places for your crew.' },
  { section: 'invitations', title: 'Invitations', detail: 'Create destination-owned ways to join.' },
  { section: 'discovery-access', title: 'Discovery and access', detail: 'Listing, approval, and join rules.' },
  { section: 'moderation', title: 'Moderation', detail: 'Confirmed actions and per-room outcomes.' },
  { section: 'emoji', title: 'Emoji', detail: 'Community emoji, validation, and privacy.' },
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
        action={<Button onClick={() => navigate({ kind: 'home' })}>Back to Home</Button>}
      />
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="mesh-community-admin-heading">
      <SurfaceHeader
        id="mesh-community-admin-heading"
        title="Community administration"
        detail={`${community.name} · Changes stay limited to the permissions this community reports.`}
        action={(
          <Button variant="secondary" size="sm" onClick={() => navigate({ kind: 'community', communityId })}>
            Back to community
          </Button>
        )}
      />
      <label className="border-b border-border-subtle bg-surface-sunken px-party-gutter py-3 text-xs font-medium text-secondary md:hidden">
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
      <div className="grid min-h-0 flex-1 md:grid-cols-[250px_minmax(0,1fr)]">
        <nav className="hidden min-h-0 overflow-y-auto border-r border-border-subtle bg-surface-sunken px-3 py-3 md:block" aria-label="Community administration sections">
          <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-1">
            {COMMUNITY_ADMIN_SECTIONS.map((entry) => (
              <button
                key={entry.section}
                ref={(element) => { sectionRefs.current[entry.section] = element ?? undefined }}
                type="button"
                role="tab"
                aria-selected={section === entry.section}
                tabIndex={section === entry.section ? 0 : -1}
                className={`min-h-11 rounded-control px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  section === entry.section ? 'bg-accent/15 text-primary' : 'text-secondary hover:bg-surface-hover hover:text-primary'
                }`}
                onClick={() => selectSection(entry)}
                onKeyDown={(event) => moveSectionFocus(event, entry.section)}
              >
                <span className="block text-sm font-semibold">{entry.title}</span>
                <span className="mt-0.5 block text-caption text-muted">{entry.detail}</span>
              </button>
            ))}
          </div>
        </nav>
        <main className="min-h-0 overflow-hidden" aria-labelledby={`mesh-community-admin-section-${currentEntry.section}`}>
          <h2 id={`mesh-community-admin-section-${currentEntry.section}`} className="sr-only">
            {currentEntry.title} for {community.name}
          </h2>
          <Suspense fallback={<SimpleSurface title={`Opening ${currentEntry.title}`} detail="Checking your current community permissions." />}>
            <CommunitySettings
              embedded
              isOpen
              activeSection={currentEntry.section}
              onClose={() => navigate({ kind: 'community', communityId })}
            />
          </Suspense>
        </main>
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
  detail: string
  action?: React.ReactNode
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="mesh-simple-route-heading">
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
  detail: string
  action?: React.ReactNode
}) {
  return (
    <header className="flex h-party-header flex-shrink-0 items-center gap-3 border-b border-border-subtle px-party-gutter">
      <div className="min-w-0 flex-1">
        <h1
          id={id}
          data-mesh-route-heading
          tabIndex={-1}
          className="truncate text-title font-semibold tracking-tight text-primary outline-none"
        >
          {title}
        </h1>
        <p className="truncate text-meta text-muted">{detail}</p>
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
      <div className="flex items-center gap-2 border-b border-border-subtle px-party-gutter py-2">
        <h2 id={id} className="text-caption font-semibold uppercase tracking-eyebrow text-secondary">
          {title}
        </h2>
        <span className="font-mono text-meta text-muted">{count}</span>
      </div>
      {children}
    </section>
  )
}

function RouteEmpty({ text }: { text: string }) {
  return <p className="border-b border-border-subtle px-party-gutter py-4 text-sm text-muted">{text}</p>
}
