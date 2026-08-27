import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { CommunitySidebar } from './CommunitySidebar'
import { ChannelSidebar } from './ChannelSidebar'
import { ContentArea } from './ContentArea'
import { DmSidebar } from './DmSidebar'
import { DmView } from '../chat/DmView'
import { useCommunitySync } from '../../hooks/useCommunitySync'
import { useChannelStore, type CommunityRefreshState } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useDmStore, type LoadStatus } from '../../store/dms'
import { dmPrimaryPeerName } from '../../types/ipc'
import { useIdentityStore } from '../../store/identity'
import { useMessageStore } from '../../store/messages'
import { useSettingsStore } from '../../store/settings'
import { useShellStore } from '../../store/shell'
import * as bridge from '../../lib/bridge'
import { ScopedErrorBoundary } from '../ui/ScopedErrorBoundary'
import { Icon, type IconName } from '../ui/Icon'
import { useNotificationSync } from '../../hooks/useNotificationSync'
import {
  matrixLinkPhaseFor,
  useNetworkStore,
  type MatrixLinkPhase,
} from '../../store/network'
import { AnimatePresence, motion } from '../../lib/lazy-motion'
import type { Variants } from '../../lib/motion'
import { motionOffsets, transitions } from '../../lib/motion'
import { Button } from '../ui/Button'
import { TooltipProvider } from '../ui/Tooltip'
import { COMPACT_VIEWPORT_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import {
  useQueuedMessageSync,
  type QueuedMessageSyncStatus,
} from '../../hooks/useQueuedMessageSync'
import { useFirstSessionRecoveryReminder } from '../../hooks/useFirstSessionRecoveryReminder'
import { useIgnoredUserSync } from '../../hooks/useIgnoredUserSync'
import { CONTEXT_SIDEBAR_WIDTH_KEY } from '../../lib/layout-preferences'
import { usePersistentPanelWidth } from '../../hooks/usePersistentPanelWidth'
import { disposeSubscription } from '../../lib/subscription-cleanup'
import { PanelResizeHandle } from './PanelResizeHandle'
import { NetworkStatus } from '../ui/NetworkStatus'
import {
  isVisibleMeshRegion,
  MESH_REGION_SELECTOR,
  nextMeshRegion,
} from '../../lib/region-navigation'
import { VoiceAudioSink } from '../voice/VoiceAudioSink'
import { VoiceDock } from '../voice/VoiceDock'
import { VoiceEngineProvider } from '../voice/VoiceEngineProvider'
import { HomeSurface } from '../home/HomeSurface'
import { InboxSurface } from '../home/InboxSurface'
import { useCurrentMeshRoute, useMeshNavigationStore } from '../../store/navigation'
import { useOnboardingChecklistStore } from '../../store/onboarding-checklist'
import { useRoomOrganizationStore } from '../../store/room-organization'
import { useRoomShapeStore } from '../../store/room-shape'
import { RouteSurface } from '../navigation/RouteSurface'
import { UserPanel } from './UserPanel'
import { shouldExposeVoiceRoutes } from '../../lib/voice-runtime'

const CommandPalette = lazy(() =>
  import('../navigation/CommandPalette').then((module) => ({ default: module.CommandPalette })),
)

export function hasAuthoritativeSavedRoomSnapshot(
  kind: 'room' | 'dm',
  conversationStatus: LoadStatus,
  roomStatus?: CommunityRefreshState['status'],
): boolean {
  return kind === 'dm' ? conversationStatus === 'loaded' : roomStatus === 'loaded'
}

export function QueuedMessageSyncNotice({
  status,
  onRetry,
}: {
  status: QueuedMessageSyncStatus
  onRetry: () => void
}) {
  const failed = status === 'failed' || status === 'retrying-failed'
  const degraded = status === 'degraded' || status === 'retrying-degraded'
  const retrying = status === 'retrying-failed' || status === 'retrying-degraded'
  if (!degraded && !failed) return null

  return (
    <div
      role={failed ? 'alert' : 'status'}
      className="mesh-shell-notice flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-marker-container px-4 py-2 text-center text-body-sm text-on-marker-container"
    >
      <span>
        {failed
          ? 'Mesh couldn’t restore saved messages.'
          : 'Saved messages are visible, but their status may not update yet.'}
      </span>
      <button
        type="button"
        className="font-semibold text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        onClick={onRetry}
        disabled={retrying}
      >
        {retrying ? 'Trying again…' : 'Try again'}
      </button>
    </div>
  )
}

/**
 * How long the connection has to stay degraded before the shell says anything.
 *
 * A sync that recovers inside this window is not news, and a band that flashes
 * for a second is worse than no band. Four seconds is roughly one status poll
 * plus its jitter, so a single missed poll never reaches the screen.
 */
const CONNECTION_BAND_GRACE_MS = 4_000

/**
 * How long the connection has to stay healthy before the band leaves.
 *
 * This is the anti-flap half. Without it a connection that recovers for one
 * second and dies again removes and re-adds a shell-level band, which is the
 * single most distracting thing this feature could do. The cost is that the
 * band can linger for up to three seconds after a real recovery. That is well
 * inside the noise of the signal it reports: the native side only marks a sync
 * stale after ninety seconds, and the renderer polls it every five.
 */
const CONNECTION_BAND_EXIT_HOLD_MS = 3_000

/**
 * Live regions are only reliable when the region is in the DOM before its text
 * changes. This one is mounted for the life of the shell; the delay covers the
 * case where the band and the shell mount together, and matches the delay the
 * offline queue strip already uses.
 */
const CONNECTION_ANNOUNCE_DELAY_MS = 400

export type DegradedConnectionPhase = Exclude<MatrixLinkPhase, 'online'>

const connectionBandMotion = {
  initial: { opacity: 0, y: -motionOffsets.tight },
  animate: { opacity: 1, y: 0, transition: transitions.base },
  exit: { opacity: 0, y: -motionOffsets.tight, transition: transitions.fast },
} satisfies Variants

interface ConnectionBandCopy {
  /*
    Amber is transient and will clear on its own; coral cannot clear without
    the person. The band is the shell's one exception surface, and these are
    the only two things it has to say about severity.
  */
  tone: 'marker' | 'danger'
  icon: IconName
  lead: string
  detail: string
  action: string
  announcement: string
}

/*
 * Three states, three recovery paths. They are not collapsed into one message
 * because the honest advice differs: one is waiting, one is worth a manual
 * check, and one cannot recover without the person.
 *
 * This band is the one visible surface that says what happens to a message
 * sent while the link is down. The rail indicator reports state only, so the
 * two never tell the same person two different stories.
 *
 * `announcement` is the screen-reader equivalent of the whole band, control
 * included, and is deliberately fuller than the visible `lead` plus `detail`.
 */
const CONNECTION_BAND_COPY: Record<DegradedConnectionPhase, ConnectionBandCopy> = {
  reconnecting: {
    tone: 'marker',
    icon: 'refresh',
    lead: 'Reconnecting to your account service.',
    detail: 'Anything you send is saved and goes out automatically.',
    action: 'Reconnect now',
    announcement:
      'Reconnecting to your account service. Messages you send are saved and will go out automatically.',
  },
  unreachable: {
    tone: 'marker',
    icon: 'triangleAlert',
    lead: 'Mesh could not check your connection.',
    detail: 'Anything you send is saved and goes out automatically.',
    action: 'Check now',
    announcement:
      'Mesh could not check your connection. Messages you send are saved and will go out automatically.',
  },
  'signed-out': {
    tone: 'danger',
    icon: 'lock',
    lead: 'This device is signed out.',
    detail: 'Sign in again to reconnect your account.',
    action: 'Sign in',
    announcement: 'This device is signed out. Sign in again to reconnect your account.',
  },
}

/*
 * The band is a tonal container, so it carries the paired ink for its whole
 * subtree rather than tinting one word inside a neutral strip. Amber is
 * transient; coral cannot clear without the person.
 */
const connectionBandLeadTone: Record<'marker' | 'danger', string> = {
  marker: 'bg-marker-container text-on-marker-container',
  danger: 'bg-error-container text-on-error-container',
}

/**
 * Turn a raw link phase into the phase the shell is allowed to show.
 *
 * Both edges are damped: entry waits out {@link CONNECTION_BAND_GRACE_MS}, exit
 * waits out {@link CONNECTION_BAND_EXIT_HOLD_MS}, and a phase change while the
 * band is already visible swaps the copy without removing and re-adding it.
 * Every state write happens inside a timer, so nothing here re-renders the
 * shell synchronously from an effect.
 */
export function useDampedConnectionPhase(
  phase: MatrixLinkPhase | null,
): DegradedConnectionPhase | null {
  const degraded: DegradedConnectionPhase | null =
    phase && phase !== 'online' ? phase : null
  const [banded, setBanded] = useState<DegradedConnectionPhase | null>(null)

  useEffect(() => {
    if (degraded === null) {
      if (banded === null) return
      const timer = window.setTimeout(() => setBanded(null), CONNECTION_BAND_EXIT_HOLD_MS)
      return () => window.clearTimeout(timer)
    }
    if (banded === degraded) return
    // Already on screen: swap the copy on the next tick rather than waiting out
    // the full grace period again, which would leave stale advice in place.
    const delay = banded === null ? CONNECTION_BAND_GRACE_MS : 0
    const timer = window.setTimeout(() => setBanded(degraded), delay)
    return () => window.clearTimeout(timer)
  }, [banded, degraded])

  return banded
}

/**
 * The text for the shell's permanent connection status region.
 *
 * Returns the empty string until the phase has held for
 * {@link CONNECTION_ANNOUNCE_DELAY_MS}, so the region is never populated in the
 * same tick it appears in and a phase that immediately changes again is only
 * announced once, in its settled form.
 */
export function useDelayedConnectionAnnouncement(
  phase: DegradedConnectionPhase | null,
): string {
  const [announced, setAnnounced] = useState('')

  useEffect(() => {
    const next = phase ? CONNECTION_BAND_COPY[phase].announcement : ''
    const timer = window.setTimeout(() => setAnnounced(next), CONNECTION_ANNOUNCE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  return announced
}

export function ConnectionBand({
  phase,
  onSignInRequired,
}: {
  phase: DegradedConnectionPhase
  onSignInRequired: () => void
}) {
  const copy = CONNECTION_BAND_COPY[phase]
  const [retrying, setRetrying] = useState(false)
  // Scoped to the phase it happened in, so a failed reconnect never carries its
  // apology over into a different state. Derived rather than reset in an effect.
  const [retryFailedFor, setRetryFailedFor] = useState<DegradedConnectionPhase | null>(null)
  const retryFailed = retryFailedFor === phase

  const retry = useCallback(() => {
    if (phase === 'signed-out') {
      onSignInRequired()
      return
    }
    setRetrying(true)
    setRetryFailedFor(null)
    void reconnectMatrixSession()
      .catch((error) => {
        console.warn('Manual reconnect did not restore the account session.', error)
        setRetryFailedFor(phase)
      })
      .finally(() => setRetrying(false))
  }, [onSignInRequired, phase])

  return (
    <motion.div
      variants={connectionBandMotion}
      initial="initial"
      animate="animate"
      exit="exit"
      data-notice-tone={copy.tone}
      data-connection-phase={phase}
      /*
        Not a live region. The retry control inside it changes label while a
        reconnect is in flight, and a live region here would read the whole
        band out again every time that happened. The one polite announcement
        lives in the shell's permanent status region instead.
      */
      className={`mesh-connection-band mesh-shell-notice flex flex-shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-center text-body-sm ${connectionBandLeadTone[copy.tone]}`}
    >
      <Icon name={copy.icon} size="sm" className="flex-shrink-0" />
      <span className="min-w-0">
        <span className="font-semibold">{copy.lead}</span>{' '}
        {copy.detail}
        {retryFailed ? ' That did not work.' : ''}
      </span>
      <Button
        variant="text"
        tone={copy.tone}
        size="sm"
        loading={retrying}
        onClick={retry}
      >
        {retrying ? 'Trying again…' : copy.action}
      </Button>
    </motion.div>
  )
}

/**
 * The real recovery path, not a control that hides its own banner.
 *
 * Step one re-reads the backend status directly. That alone is worth the
 * button: the status poll backs off exponentially to five minutes after
 * repeated failures and pauses entirely while the window is hidden, so the
 * app's own next check can be a long way out.
 *
 * Step two only runs when that fresh read confirms a signed-in session whose
 * sync is not running, and it is the only lever the renderer has that actually
 * restarts the sync loop: `matrix_restore_session` rebuilds the client from the
 * stored session, syncs once, and reinstalls the runtime. It is not free, it
 * cancels in-flight native reads and clears destructive-action grants, which is
 * why it is behind an explicit press and behind a confirmed stall.
 */
async function reconnectMatrixSession(): Promise<void> {
  const network = useNetworkStore.getState()
  let status = await bridge.getBackendStatus()
  if (status.kind === 'matrix' && status.authenticated && !status.syncRunning) {
    status = await bridge.matrixRestoreSession()
  }
  if (status.kind !== 'matrix') return
  network.setStatus({
    state: status.authenticated
      ? status.syncRunning ? 'connected' : 'disconnected'
      : 'connecting',
    peerCount: 0,
    averageLatency: 0,
  })
  network.setMatrixLink(matrixLinkPhaseFor(status))
}

export function AppLayout({ onSignInRequired }: { onSignInRequired: () => void }) {
  useCommunitySync()
  const matrixMode = bridge.isMatrixBackend()
  useIgnoredUserSync(matrixMode)
  const recoveredConnection = useNetworkStore((state) => state.recoveredConnection)
  const matrixLinkPhase = useNetworkStore((state) => state.matrixLink?.phase ?? null)
  const connectionBandPhase = useDampedConnectionPhase(matrixMode ? matrixLinkPhase : null)
  const connectionAnnouncement = useDelayedConnectionAnnouncement(connectionBandPhase)
  const queuedMessageSync = useQueuedMessageSync(
    matrixMode,
    recoveredConnection?.recoveredAt,
  )
  const directMessagesAvailable = bridge.getBackendCapabilities().directMessages
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const activeChannel = useChannelStore((state) => (
    state.activeChannelId ? state.channelEntities[state.activeChannelId] : undefined
  ))
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const patchChannel = useChannelStore((state) => state.patchChannel)
  const isDmMode = useDmStore((state) => state.isDmMode)
  const activeConversationId = useDmStore((state) => state.activeConversationId)
  const setActiveConversation = useDmStore((state) => state.setActiveConversation)
  const setDmMode = useDmStore((state) => state.setDmMode)
  const dismissBackupReminder = useSettingsStore((state) => state.dismissBackupReminder)
  const pendingInvitation = useShellStore((state) => state.pendingInvitation)
  const foregroundInvitationHandle = useShellStore(
    (state) => state.foregroundInvitationHandle,
  )
  const setFeedbackOpen = useShellStore((state) => state.setFeedbackOpen)
  const contextSidebarWidth = usePersistentPanelWidth({
    storageKey: CONTEXT_SIDEBAR_WIDTH_KEY,
    defaultWidth: 340,
    /*
      The floor rises with the design again. An M3 list row is a 56px pill
      carrying a 24px leading glyph, a title-medium headline and a trailing
      badge, and the two-line variant adds supporting text under it; at the old
      226px floor the headline had 150px and truncated on most room names.
    */
    minimum: 300,
    maximum: 420,
  })

  const myPublicKey = useIdentityStore((state) => state.identity?.publicKey)
  const storedRoute = useCurrentMeshRoute()
  const voiceRoutesEnabled = shouldExposeVoiceRoutes(
    matrixMode,
    bridge.getBackendStatusSnapshot(),
  )
  const route = useMemo(
    () => storedRoute.kind === 'voice' && !voiceRoutesEnabled
      ? ({ kind: 'home' } as const)
      : storedRoute,
    [storedRoute, voiceRoutesEnabled],
  )
  /*
   * These subscriptions are deliberately scalar. The shell used to subscribe
   * to whole entity and message maps, so a message arriving in any cached
   * room, on screen or not, re-rendered every sidebar, the content area and
   * the call runtime. Everything below reads one entity, one field, or one
   * flag, so that is exactly what it selects.
   */
  const routedRoomId = route.kind === 'room' || route.kind === 'voice'
    ? route.roomId
    : null
  const routedRoomKnown = useChannelStore(
    (state) => routedRoomId !== null && state.channelEntities[routedRoomId] !== undefined,
  )
  const routedConversationId = route.kind === 'direct' ? route.conversationId : null
  const routedConversationKnown = useDmStore(
    (state) => routedConversationId !== null
      && state.conversationEntities[routedConversationId] !== undefined,
  )
  const routedCommunityId = route.kind === 'room'
    || route.kind === 'voice'
    || route.kind === 'community'
    || route.kind === 'community-admin'
    ? route.communityId
    : null
  const routedCommunityName = useCommunityStore(
    (state) => routedCommunityId !== null
      ? state.communityEntities[routedCommunityId]?.name
      : undefined,
  )
  // Set once, when a message authored by this account is admitted to either
  // store. Reading a scalar replaces a per-render walk over every cached
  // conversation for a person who has never sent anything.
  const hasAuthoredChannelMessage = useMessageStore((state) => state.hasAuthoredMessage)
  const hasAuthoredDirectMessage = useDmStore((state) => state.hasAuthoredMessage)
  const backupReminderDue = useFirstSessionRecoveryReminder({
    matrixMode,
    accountId: myPublicKey ?? null,
    successfulUse: hasSentConversationMessage(
      myPublicKey,
      hasAuthoredChannelMessage,
      hasAuthoredDirectMessage,
    ),
    invitationForegrounded: route.kind === 'invitation'
      || foregroundInvitationHandle !== null,
  })
  const navigationHydrated = useMeshNavigationStore((state) => state.hydrated)
  const initializeNavigation = useMeshNavigationStore((state) => state.initialize)
  const initializeRoomOrganization = useRoomOrganizationStore((state) => state.initialize)
  const initializeRoomShapes = useRoomShapeStore((state) => state.initialize)
  const initializeOnboardingChecklist = useOnboardingChecklistStore((state) => state.initialize)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const goBack = useMeshNavigationStore((state) => state.back)
  const goForward = useMeshNavigationStore((state) => state.forward)
  const focusRequest = useMeshNavigationStore((state) => state.focusRequest)
  const drawer = useMeshNavigationStore((state) => state.drawer)
  const setDrawer = useMeshNavigationStore((state) => state.setDrawer)
  const contextNavigationOpen = drawer === 'context'
  const contextNavigationRef = useRef<HTMLDivElement>(null)
  const activeRoomId = isDmMode ? activeConversationId : activeChannelId
  /*
   * The navigation drawer only exists below 1000px. Deriving "is the drawer
   * actually a drawer right now" from the media query: rather than latching it
   * when the drawer opened: fixes a keyboard trap: widening the window used to
   * leave the Tab cycle and `aria-modal` installed on a sidebar that had
   * reverted to a static column, with its only Close control display:none.
   */
  const isCompactViewport = useMediaQuery(COMPACT_VIEWPORT_QUERY)
  const drawerActive = contextNavigationOpen && isCompactViewport
  const closeNavigationDrawer = useCallback((restoreFocus = true) => {
    setDrawer('none')
    if (restoreFocus && typeof document !== 'undefined') {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('.mesh-compact-header button')?.focus()
      })
    }
  }, [setDrawer])
  // Naming the main landmark after the open conversation is far more useful for
  // landmark navigation than the previous static "Content area".
  const directRouteActive = route.kind === 'direct' || route.kind === 'direct-list'
  const roomNavigationVisible = route.kind === 'room'
    || route.kind === 'voice'
    || route.kind === 'community'
    || route.kind === 'community-admin'
    || directRouteActive
  const activeConversationLabel = route.kind === 'home'
    ? 'Home'
    : route.kind === 'inbox'
      ? 'Inbox'
    : route.kind === 'communities'
      ? 'Communities'
      : route.kind === 'community'
        ? `${routedCommunityName ?? 'Community'} community`
        : route.kind === 'you'
          ? 'You'
          : route.kind === 'invitation'
            ? 'Community invitation'
            : route.kind === 'community-admin'
              ? `${routedCommunityName ?? 'Community'} settings`
    : route.kind === 'direct-list'
              ? 'Direct messages'
              : directRouteActive
                ? 'Direct message conversation'
              : activeChannel?.name
                ? `Conversation in ${activeChannel.name}`
                : 'Conversation'
  const notificationSync = useNotificationSync({
    matrixMode,
    accountUserId: matrixMode ? (myPublicKey ?? null) : null,
    activeRoomId,
  })

  useEffect(() => {
    initializeNavigation(myPublicKey ?? 'local-device')
  }, [initializeNavigation, myPublicKey])

  useEffect(() => {
    initializeRoomOrganization(myPublicKey ?? 'local-device')
  }, [initializeRoomOrganization, myPublicKey])

  useEffect(() => {
    initializeRoomShapes(myPublicKey ?? 'local-device')
  }, [initializeRoomShapes, myPublicKey])

  useEffect(() => {
    initializeOnboardingChecklist(myPublicKey ?? 'local-device')
  }, [initializeOnboardingChecklist, myPublicKey])

  useEffect(() => {
    if (!navigationHydrated || storedRoute.kind !== 'voice' || voiceRoutesEnabled) return
    navigate({ kind: 'home' }, { replace: true })
  }, [navigate, navigationHydrated, storedRoute, voiceRoutesEnabled])

  useEffect(() => {
    if (!navigationHydrated || !foregroundInvitationHandle) return
    if (route.kind === 'invitation' && route.handle === foregroundInvitationHandle) return
    navigate({ kind: 'invitation', handle: foregroundInvitationHandle })
  }, [foregroundInvitationHandle, navigate, navigationHydrated, route])

  useEffect(() => {
    if (!navigationHydrated) return
    if (route.kind === 'room') {
      if (!routedRoomKnown) return
      setDmMode(false)
      setActiveCommunity(route.communityId)
      setActiveChannel(route.roomId)
      return
    }
    if (route.kind === 'direct') {
      if (!routedConversationKnown) return
      setDmMode(true)
      setActiveConversation(route.conversationId)
      return
    }
    if (route.kind === 'direct-list') {
      setDmMode(true)
      setActiveConversation(null)
      return
    }
    if (route.kind === 'voice') {
      if (!routedRoomKnown) return
      setDmMode(false)
      setActiveCommunity(route.communityId)
      setActiveChannel(route.roomId)
      return
    }
    if (route.kind === 'community' || route.kind === 'community-admin') {
      setDmMode(false)
      setActiveCommunity(route.communityId)
    }
  }, [
    navigationHydrated,
    route,
    routedConversationKnown,
    routedRoomKnown,
    setActiveChannel,
    setActiveCommunity,
    setActiveConversation,
    setDmMode,
  ])

  useEffect(() => {
    if (focusRequest === 0) return
    let framesRemaining = 4
    let focusFrame = 0
    const focusRouteHeading = () => {
      document.querySelector<HTMLElement>('[data-mesh-route-heading]')?.focus({
        preventScroll: true,
      })
      framesRemaining -= 1
      if (framesRemaining > 0) {
        focusFrame = window.requestAnimationFrame(focusRouteHeading)
      }
    }
    focusFrame = window.requestAnimationFrame(focusRouteHeading)
    return () => window.cancelAnimationFrame(focusFrame)
  }, [focusRequest])

  useEffect(() => {
    const communityName = routedCommunityName ?? null
    const roomName = route.kind === 'room' || route.kind === 'voice'
      ? useChannelStore.getState().channelEntities[route.roomId]?.name
      : null
    const conversationName = route.kind === 'direct'
      ? dmPrimaryPeerName(useDmStore.getState().conversationEntities[route.conversationId])
      : null
    const title = route.kind === 'home'
      ? 'Home | Mesh'
      : route.kind === 'inbox'
        ? 'Inbox | Mesh'
      : route.kind === 'you'
        ? 'You | Mesh'
        : route.kind === 'invitation'
          ? `Invitation to ${pendingInvitation?.communityName?.trim() || 'a community'} | Mesh`
        : route.kind === 'direct' || route.kind === 'direct-list'
          ? `${conversationName ?? 'Messages'} | Mesh`
          : route.kind === 'room'
            ? `#${roomName ?? 'Room'}${communityName ? ` | ${communityName}` : ''} | Mesh`
            : route.kind === 'voice'
              ? `${roomName ?? 'Voice'} | Mesh`
              : communityName
                ? `${communityName} | Mesh`
                : 'Mesh'
    document.title = title
    /*
      And again, natively. `document.title` addresses a browser tab that does
      not exist in a Tauri window: Alt-Tab, the taskbar preview and the window
      list read the title the OS was given, which was "Mesh" for every room.
      The native call is best-effort because a title is not worth an error
      surface; a stale title bar is the cost of it failing.
    */
    void bridge.setWindowTitle(title).catch(() => {})
  }, [pendingInvitation?.communityName, route, routedCommunityName])

  /*
    A clicked notification opens the conversation it was about.

    Raising the window is only half of it: the notification named a room, and
    landing on whatever was last open makes the person find it again. The room
    has to be one this client already knows, because the route needs the
    community the room belongs to and an unknown room cannot supply one; in
    that case the window still comes forward, which is what the native side
    already did before the renderer heard anything.
  */
  useEffect(() => {
    const unlisten = bridge.onMatrixNotificationActivated((activation) => {
      const conversation = useDmStore.getState().conversationEntities[activation.roomId]
      if (activation.isDm && conversation) {
        navigate({ kind: 'direct', conversationId: activation.roomId }, { focus: true })
        return
      }
      const channel = useChannelStore.getState().channelEntities[activation.roomId]
      if (channel) {
        navigate(
          { kind: 'room', communityId: channel.communityId, roomId: activation.roomId },
          { focus: true },
        )
      }
    })
    return () => {
      void unlisten.then((stop) => stop()).catch(() => {})
    }
  }, [navigate])

  useEffect(() => {
    const handleProductHistory = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || !event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
        || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
      ) {
        return
      }
      event.preventDefault()
      if (event.key === 'ArrowLeft') goBack()
      else goForward()
    }
    window.addEventListener('keydown', handleProductHistory)
    return () => window.removeEventListener('keydown', handleProductHistory)
  }, [goBack, goForward])

  useEffect(() => {
    if (!directMessagesAvailable && isDmMode) setDmMode(false)
  }, [directMessagesAvailable, isDmMode, setDmMode])

  useEffect(() => {
    const handleRegionCycle = (event: KeyboardEvent) => {
      if (
        event.key !== 'F6'
        || event.defaultPrevented
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || document.querySelector('[role="dialog"][aria-modal="true"]')
      ) {
        return
      }

      const regions = [...document.querySelectorAll<HTMLElement>(MESH_REGION_SELECTOR)]
        .filter(isVisibleMeshRegion)
      const nextRegion = nextMeshRegion(regions, document.activeElement, event.shiftKey)
      if (!nextRegion) return

      event.preventDefault()
      nextRegion.focus({ preventScroll: true })
    }

    document.addEventListener('keydown', handleRegionCycle)
    return () => document.removeEventListener('keydown', handleRegionCycle)
  }, [])

  useLayoutEffect(() => {
    if (!drawerActive) return
    const focusableSelector = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const focusFirstElement = () => {
      const drawer = contextNavigationRef.current
      if (!drawer) return
      const firstVisible = [...drawer.querySelectorAll<HTMLElement>(focusableSelector)]
        .find((element) => !element.hidden && element.getClientRects().length > 0)
      ;(firstVisible ?? drawer).focus()
    }
    contextNavigationRef.current?.focus()
    focusFirstElement()
    const focusFirst = window.requestAnimationFrame(focusFirstElement)
    const handleKeyDown = (event: KeyboardEvent) => {
      const openDialog = document.querySelector('[role="dialog"]')
      const nestedDialogOpen = openDialog != null && openDialog !== contextNavigationRef.current
      if (event.key === 'Escape' && !event.defaultPrevented && !nestedDialogOpen) {
        event.preventDefault()
        closeNavigationDrawer()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(contextNavigationRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])]
        .filter((element) => !element.hidden && element.getClientRects().length > 0)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFirst)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeNavigationDrawer, drawerActive])

  useEffect(() => {
    const unlisten = matrixMode
      ? Promise.resolve(() => {})
      : bridge.onMessageReceived((message) => {
        const isActiveChannel = message.channelId === activeChannelId && !isDmMode

        if (isActiveChannel) {
          return
        }

        const channel = useChannelStore
          .getState()
          .channelEntities[message.channelId]
        patchChannel(message.channelId, {
          unreadCount: (channel?.unreadCount ?? 0) + 1,
        })
      })

    return () => {
      disposeSubscription(unlisten, 'unread-message listener')
    }
  }, [activeChannelId, isDmMode, matrixMode, patchChannel])

  // The user IS a peer. A mesh of size 1 (just them) is a VALID working
  // state: they can send messages, create communities, queue things for
  // delivery. We only surface a banner when something actually blocks
  // them, not just because they're solo.
  //
  // Banner is NEVER shown for solo mode. If the swarm task hasn't started
  // at all (real failure), the user sees errors elsewhere. Solo is
  // advertised gently via the sidebar indicator instead.
  return (
    /*
      The tooltip group lives here rather than at the application root, where it
      dragged the whole Radix tooltip and floating-ui tree into first paint --
      about 51 KiB for a group whose every consumer is a descendant of this
      component. Onboarding, the toasts and the app-level diagnostics panel now
      sit outside the group; none of them renders a Tooltip, and a leaf that
      finds no group falls back to its own provider rather than throwing, so a
      detached surface still works. The only thing given up is shared skip-delay
      timing across surfaces that have no tooltips to share it with.
    */
    <TooltipProvider>
    <VoiceEngineProvider>
      <div className="mesh-app-shell relative flex h-full flex-col overflow-hidden bg-surface text-on-surface">
      {/*
        Skip link. The room list is a flat list of buttons, so in a community
        with forty rooms it cost forty-plus Tab presses to reach the
        conversation. This is the first thing in the tab order.
      */}
      {/*
        Both links live in a labelled nav so they sit inside a landmark. They are
        the first thing in the tab order and were the only content on the shell
        outside any landmark region, which is what the axe best-practice ruleset
        reports once it is actually run.
      */}
      <nav aria-label="Skip links">
        <a
          href="#mesh-conversation"
          className="sr-only rounded-full bg-surface-container-high px-3 py-2 text-body-md font-medium text-on-surface shadow-elev-3 focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-tooltip"
        >
          Skip to conversation
        </a>
        {/*
          Reading the conversation and writing in it are two destinations, and
          the composer sits after the whole timeline. Offset to the second slot
          so the two links do not land on top of each other while both are
          focusable.
        */}
        <a
          href="#mesh-composer"
          className="sr-only rounded-full bg-surface-container-high px-3 py-2 text-body-md font-medium text-on-surface shadow-elev-3 focus:not-sr-only focus:absolute focus:left-2 focus:top-14 focus:z-tooltip"
        >
          Skip to message composer
        </a>
      </nav>
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
      {/*
        The connection band's single polite announcement. Permanently mounted
        and outside the band, so the region exists before its text changes and
        so nothing re-announces when the band re-renders. The text only moves
        when the damped phase moves.
      */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {connectionAnnouncement}
      </p>
      {/*
        Top of the shell notice stack. This one governs everything below it,
        including the other notices: a queued-message failure is a consequence
        of the connection, not a separate problem.
      */}
      <AnimatePresence initial={false}>
        {connectionBandPhase && (
          <ConnectionBand
            key="mesh-connection-band"
            phase={connectionBandPhase}
            onSignInRequired={onSignInRequired}
          />
        )}
      </AnimatePresence>
      {backupReminderDue && (
        <div
          role="status"
          className="mesh-shell-notice flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-marker-container px-4 py-2 text-body-sm text-on-marker-container"
        >
          <span>Keep access to your protected messages. Finish setup in Your devices.</span>
          <button
            type="button"
            className="font-semibold text-primary hover:underline"
            onClick={() => navigate({ kind: 'you', section: 'safety-devices' })}
          >
            Keep access
          </button>
          <button
            type="button"
            className="text-on-surface-variant hover:text-on-surface"
            aria-label="Dismiss message recovery reminder"
            onClick={dismissBackupReminder}
          >
            Not now
          </button>
        </div>
      )}
      {matrixMode && (
        <QueuedMessageSyncNotice
          status={queuedMessageSync.status}
          onRetry={queuedMessageSync.retry}
        />
      )}
      {notificationSync.notificationModeFailureCount > 0 && (
        <div
          role="status"
          className="mesh-shell-notice flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-marker-container px-4 py-2 text-body-sm text-on-marker-container"
        >
          <span>
            Mesh could not refresh notification choices for{' '}
            {notificationSync.notificationModeFailureCount}{' '}
            {notificationSync.notificationModeFailureCount === 1 ? 'conversation' : 'conversations'}.
            Your current choices stay in place.
          </span>
          <button
            type="button"
            className="font-semibold text-primary hover:underline"
            onClick={notificationSync.retryNotificationModeSync}
          >
            Try again
          </button>
        </div>
      )}
      <div className="mesh-workspace-frame flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <nav
          className="mesh-community-rail flex min-h-0 flex-shrink-0 flex-col items-center overflow-y-auto pt-2"
          aria-label="Communities and direct messages"
          data-mesh-region
          tabIndex={-1}
        >
          <ScopedErrorBoundary
            name="Community navigation"
            description="Community shortcuts could not be displayed."
            resetKey={activeCommunityId}
          >
            <CommunitySidebar />
          </ScopedErrorBoundary>
          <div className="mt-auto flex flex-col items-center gap-1 pb-3">
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              aria-label="Send beta feedback"
              onClick={() => setFeedbackOpen(true)}
            >
              <Icon name="messageCircle" size="sm" />
            </button>
            <NetworkStatus matrixMode={matrixMode} />
          </div>
        </nav>

        {drawerActive && (
          <button
            type="button"
            className="mesh-nav-backdrop"
            aria-label="Dismiss room navigation"
            onClick={() => closeNavigationDrawer()}
          />
        )}

        {/*
          A div rather than an aside, because this element is two things by
          turn. As a static column it is complementary; as a compact drawer it
          is a modal dialog, and dialog is not a role an aside may take -- which
          axe reports as soon as the best-practice ruleset is actually run. A
          div carries no implicit role to conflict with, so both states are
          declared outright instead of one overriding the other.
        */}
        {roomNavigationVisible && <div
          ref={contextNavigationRef}
          id="mesh-context-sidebar"
          data-open={contextNavigationOpen ? 'true' : 'false'}
          className="mesh-context-sidebar relative flex min-h-0 flex-shrink-0 flex-col"
          data-design-token-exception="user-resizable-persisted-context-sidebar-width"
          style={{
            '--mesh-context-sidebar-width': `${contextSidebarWidth.width}px`,
          } as CSSProperties}
          aria-label={directRouteActive && directMessagesAvailable ? 'Direct message conversations' : 'Room list'}
          data-mesh-region
          tabIndex={-1}
          /* Only a real drawer is a modal dialog. Above the compact breakpoint
             this is an ordinary static column and must not claim aria-modal. */
          data-state={drawerActive ? 'open' : undefined}
          role={drawerActive ? 'dialog' : 'complementary'}
          aria-modal={drawerActive || undefined}
        >
          {drawerActive && (
            <div className="flex min-h-11 flex-shrink-0 items-center justify-between px-2">
              <span className="min-w-0 truncate px-2 text-body-md font-semibold text-on-surface-variant">
                {directRouteActive && directMessagesAvailable ? 'Conversations' : 'Rooms'}
              </span>
              <button
                type="button"
                className="flex min-h-11 min-w-11 flex-shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface-variant"
                aria-label={directRouteActive ? 'Close conversation navigation drawer' : 'Close room navigation drawer'}
                onClick={() => closeNavigationDrawer()}
              >
                <Icon name="x" size="sm" />
              </button>
            </div>
          )}
          <PanelResizeHandle
            label="Resize room navigation"
            side="right"
            value={contextSidebarWidth.width}
            minimum={300}
            maximum={420}
            onPointerDown={contextSidebarWidth.startResize}
            onResizeBy={contextSidebarWidth.resizeBy}
          />
          <ScopedErrorBoundary
            name={directRouteActive && directMessagesAvailable ? 'Conversation list' : 'Room list'}
            description="Navigation failed to render."
            className="m-2"
            resetKey={`${directRouteActive ? 'dm' : 'channel'}:${activeCommunityId ?? ''}`}
          >
            {directRouteActive && directMessagesAvailable ? <DmSidebar /> : <ChannelSidebar />}
          </ScopedErrorBoundary>
        </div>}

        <main
          id="mesh-conversation"
          tabIndex={-1}
          className="mesh-workspace-main flex min-h-0 min-w-0 flex-1 flex-col outline-none"
          aria-label={activeConversationLabel}
          data-mesh-region
        >
          {roomNavigationVisible && <div className="mesh-compact-header">
            <button
              type="button"
              className="flex h-8 items-center gap-2 rounded-full px-2 text-body-md font-medium text-on-surface-variant hover:bg-state-hover hover:text-on-surface"
              aria-controls="mesh-context-sidebar"
              aria-expanded={contextNavigationOpen}
              aria-label={
                contextNavigationOpen
                  ? 'Close room navigation'
                  : directRouteActive
                    ? 'Open conversation navigation'
                    : 'Open room navigation'
              }
              onClick={() => setDrawer(contextNavigationOpen ? 'none' : 'context')}
            >
              <Icon name={contextNavigationOpen ? 'x' : 'menu'} size="sm" />
              {contextNavigationOpen ? 'Close' : directRouteActive ? 'Conversations' : 'Rooms'}
            </button>
            <span className="truncate text-body-sm text-on-surface-variant">
              {route.kind === 'direct' || route.kind === 'direct-list'
                ? 'Direct messages'
                : route.kind === 'community' || route.kind === 'community-admin'
                  ? routedCommunityName ?? 'Community'
                  : route.kind === 'room' || route.kind === 'voice'
                    ? routedCommunityName ?? 'Community'
                    : 'Mesh'}
            </span>
          </div>}
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {route.kind === 'home' ? (
              <HomeSurface />
            ) : route.kind === 'inbox' ? (
              <InboxSurface />
            ) : route.kind === 'community'
              || route.kind === 'communities'
              || route.kind === 'you'
              || route.kind === 'invitation'
              || route.kind === 'community-admin' ? (
              <RouteSurface route={route} onSignInRequired={onSignInRequired} />
            ) : directRouteActive && directMessagesAvailable ? (
              <ScopedErrorBoundary
                name="Direct messages"
                description="This conversation could not be displayed."
                className="m-4"
                resetKey={activeConversationId}
              >
                <DmView />
              </ScopedErrorBoundary>
            ) : (
              <ContentArea />
            )}
          </div>
        </main>
      </div>
      {voiceRoutesEnabled && <VoiceAudioSink />}
      {/*
        The call bar is a floating toolbar now, so it centres on the window
        rather than starting where the rail ends: it is above the shell, not a
        fifth column of it.
      */}
      {voiceRoutesEnabled && <div className="mesh-party-strip-row flex flex-shrink-0 justify-center">
        <VoiceDock />
      </div>}
      {!roomNavigationVisible && <UserPanel controls={false} />}
      </div>
    </VoiceEngineProvider>
    </TooltipProvider>
  )
}

/**
 * The recovery reminder waits for evidence that this account actually used
 * Mesh. Each store raises its own flag when it admits a message authored by
 * the signed-in account, so the shell only combines them: without an account
 * id there is nothing to remind anyone about.
 */
export function hasSentConversationMessage(
  accountId: string | null | undefined,
  hasAuthoredChannelMessage: boolean,
  hasAuthoredDirectMessage: boolean,
): boolean {
  if (!accountId) return false
  return hasAuthoredChannelMessage || hasAuthoredDirectMessage
}
