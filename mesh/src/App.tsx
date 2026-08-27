import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { AnimatePresence, motion } from './lib/lazy-motion'
import { OnboardingFlow } from './components/onboarding/OnboardingFlow'
import { showToast, ToastContainer } from './components/ui/Toast'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { useIdentityStore } from './store/identity'
import { useCommunityStore } from './store/communities'
import { useChannelStore } from './store/channels'
import { matrixLinkPhaseFor, useNetworkStore } from './store/network'
import { refreshMatrixPreferences, useSettingsStore } from './store/settings'
import * as bridge from './lib/bridge'
import { variants } from './lib/motion'
import { AsyncStatus } from './components/ui/AsyncStatus'
import { Button } from './components/ui/Button'
import { matrixIdentity, matrixProfileIdentity } from './lib/matrixIdentity'
import type {
  BackendStartupIssue,
  Community,
  Identity,
  PendingInvitationMetadata,
} from './types/ipc'
import { registerPoll } from './lib/scheduler'
import { useShellStore } from './store/shell'
import { beginInvitationActivation } from './lib/invitation-activation'
import { mapSettledWithConcurrency } from './lib/concurrency'
import { disposeSubscription } from './lib/subscription-cleanup'
import { describeError, errorLine } from './lib/errors'

const AppLayout = lazy(() =>
  import('./components/layout/AppLayout').then((module) => ({
    default: module.AppLayout,
  })),
)
const DiagnosticsPanel = lazy(() =>
  import('./components/settings/DiagnosticsPanel').then((module) => ({
    default: module.DiagnosticsPanel,
  })),
)
/**
 * What the launch screen says while it waits, for both bootstrap paths.
 *
 * This was two byte-identical tables, one per path. Identical copies do not
 * stay identical: the next person to reword a step edits one of them, and the
 * two flows disagree without anything failing. Split it again only when the
 * paths genuinely need different words.
 */
const BOOTSTRAP_STEPS = {
  connecting: { label: 'Connecting to Mesh', progress: 28 },
  syncing: { label: 'Getting your conversations', progress: 62 },
  finalizing: { label: 'Restoring recent messages', progress: 88 },
  ready: { label: 'Your conversations are ready', progress: 100 },
} as const

const MATRIX_STATUS_POLL_INTERVAL_MS = 5_000

type BootstrapIssue = {
  kind: 'startup' | 'communities'
  blockedCount: number
  startupIssue?: BackendStartupIssue | null
}

type CommunityLoadNotice = {
  blockedCount: number
  reasons: bridge.BlockedEntityDiagnostic['reason'][]
}

/**
 * Says what the person can do about a quarantined community. The protocol fact
 * stays out of the sentence: "unencrypted" is a diagnostic, "an owner has to
 * turn protection on" is the part they can act on.
 */
function blockedCommunityGuidance(
  reasons: bridge.BlockedEntityDiagnostic['reason'][],
): string {
  const distinct = [...new Set(reasons)]
  if (distinct.length !== 1) return 'Open connection check for the details.'
  switch (distinct[0]) {
    case 'unencrypted':
      return 'An owner has to turn protection on.'
    case 'inaccessible':
      return 'Mesh could not reach it. Check your connection, then try again.'
    case 'unsupported':
      return 'This version of Mesh cannot open it yet.'
    default:
      return 'Open connection check for the details.'
  }
}

type RoomLoadNotice = {
  blockedCount: number
  reasons: bridge.BlockedEntityDiagnostic['reason'][]
}

/**
 * The room-level twin of `blockedCommunityGuidance`. A room Mesh refuses to
 * open used to leave the sidebar with nothing but a `console.warn`, so the room
 * simply was not there and no sentence anywhere said why. Same rule as the
 * community copy: name the thing the person can act on, never the protocol
 * word, and carry no pronoun so one sentence works for one room or six.
 */
function blockedRoomGuidance(
  reasons: bridge.BlockedEntityDiagnostic['reason'][],
): string {
  const distinct = [...new Set(reasons)]
  if (distinct.length !== 1) return 'Open connection check for the details.'
  switch (distinct[0]) {
    case 'unencrypted':
      return 'A community owner has to turn protection on.'
    case 'inaccessible':
      return 'Mesh could not reach the room service. Check your connection, then try again.'
    case 'unsupported':
      return 'This version of Mesh cannot open that kind of room yet.'
    default:
      return 'Open connection check for the details.'
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

function sameFlatRecord(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => left[key] === right[key])
}

function sameStringList(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * The status poll builds a fresh object every 5 seconds, so plain identity
 * churns twelve times a minute even when nothing changed, re-running every
 * effect that depends on the object. Compare by value and keep the previous
 * object when the content is identical.
 */
function sameBackendStatus(
  left: bridge.BackendStatus | null,
  right: bridge.BackendStatus | null,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.kind === right.kind
    && left.authenticated === right.authenticated
    && left.userId === right.userId
    && left.deviceId === right.deviceId
    && left.homeserver === right.homeserver
    && left.syncRunning === right.syncRunning
    && left.durableHistory === right.durableHistory
    && left.supportsE2ee === right.supportsE2ee
    && left.sessionE2eeReady === right.sessionE2eeReady
    && sameStringList(left.warnings, right.warnings)
    && sameFlatRecord(left.capabilities, right.capabilities)
    && sameFlatRecord(left.voiceService, right.voiceService)
  )
}

async function loadMatrixIdentity(
  userId: string | null,
  isTauriRuntime: boolean,
): Promise<Identity | null> {
  const fallback = matrixIdentity(userId)
  if (!fallback || !isTauriRuntime) return fallback

  try {
    return matrixProfileIdentity(await bridge.matrixGetProfile())
  } catch (error) {
    // A profile server outage should not lock a signed-in user out of Mesh.
    // Editing remains explicit and will surface the server error in Settings.
    console.warn('Could not load Matrix profile; using the account ID fallback.', error)
    return fallback
  }
}

function isProfileComplete(identity: Identity | null) {
  return Boolean(identity?.displayName.trim()) && Boolean(identity?.avatarColor.trim())
}

function mapNetworkState(status: {
  connected: boolean
  peerCount: number
  averageLatency: number
  usingRelay: boolean
}) {
  return {
    state: status.connected ? 'connected' : status.usingRelay ? 'degraded' : 'connecting',
    peerCount: status.peerCount,
    averageLatency: status.averageLatency,
  } as const
}

function mapMatrixNetworkState(authenticated: boolean, syncRunning: boolean) {
  return {
    state: !authenticated ? 'connecting' : syncRunning ? 'connected' : 'disconnected',
    peerCount: 0,
    averageLatency: 0,
  } as const
}

function ColdStartStatus({
  invitationName,
  onRecovery,
}: {
  invitationName?: string | null
  onRecovery: () => void
}) {
  const [delayed, setDelayed] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setDelayed(true), 8_000)
    return () => window.clearTimeout(timer)
  }, [])

  const destination = invitationName?.trim()
  return (
    <AsyncStatus
      title={delayed
        ? 'Mesh is taking longer to open'
        : destination
          ? `Opening invitation to ${destination}`
          : 'Opening Mesh'}
      /*
        Nothing while it is merely slow: the title says what is opening, and
        the delayed branch's own sentence listed the three buttons directly
        beneath it by name. "Restoring your rooms and settings" stays, because
        it says what the wait is for rather than reassuring somebody about it.
      */
      detail={delayed || destination ? undefined : 'Restoring your rooms and settings.'}
      actions={delayed ? (
        <>
          <Button onClick={() => window.location.reload()}>Try again</Button>
          <Button variant="secondary" onClick={onRecovery}>Sign-in and recovery</Button>
          <Button variant="ghost" onClick={() => window.close()}>Close Mesh</Button>
        </>
      ) : undefined}
    />
  )
}

function BootstrapRecovery({
  issue,
  retrying,
  onRetry,
  onOpenSignInRecovery,
  onOpenDiagnostics,
}: {
  issue: BootstrapIssue
  retrying: boolean
  onRetry: () => void
  onOpenSignInRecovery?: () => void
  onOpenDiagnostics?: () => void
}) {
  const blockedLabel = `${issue.blockedCount} communit${issue.blockedCount === 1 ? 'y' : 'ies'}`
  const title = issue.kind === 'startup'
    ? issue.startupIssue === 'sign-in-required'
      ? 'Your saved account needs sign-in'
      : issue.startupIssue === 'connection-unavailable'
        ? "Mesh couldn't restore your saved account offline"
        : issue.startupIssue === 'service-unavailable'
          ? 'Your account service is unavailable'
          : "Mesh couldn't open your saved account"
    : issue.blockedCount > 0
      ? 'Some communities need attention'
      : "Mesh couldn't load your communities"
  const detail = issue.kind === 'startup'
    ? issue.startupIssue === 'sign-in-required'
      ? 'Sign in again to reconnect it.'
      : issue.startupIssue === 'connection-unavailable'
        ? 'Check your connection and try again.'
        : issue.startupIssue === 'service-unavailable'
          ? 'Try again later, or use connection check for more detail.'
          : 'Try again, or open sign-in and recovery if this keeps happening.'
    : issue.blockedCount > 0
      ? `Mesh kept ${blockedLabel} hidden because it could not open ${issue.blockedCount === 1 ? 'it' : 'them'} safely.`
      : 'Check your connection and try again.'

  return (
    <AsyncStatus
      title={title}
      detail={detail}
      assertive
      actions={(
        <>
          <Button disabled={retrying} onClick={onRetry}>
            {retrying ? 'Trying again…' : 'Try again'}
          </Button>
          {onOpenSignInRecovery ? (
            <Button variant="secondary" disabled={retrying} onClick={onOpenSignInRecovery}>
              Open sign-in and recovery
            </Button>
          ) : null}
          {onOpenDiagnostics ? (
            <Button variant="ghost" disabled={retrying} onClick={onOpenDiagnostics}>
              Open connection check
            </Button>
          ) : null}
        </>
      )}
    />
  )
}

function CommunityLoadBanner({
  notice,
  retrying,
  onRetry,
}: {
  notice: CommunityLoadNotice
  retrying: boolean
  onRetry: () => void
}) {
  const label = `${notice.blockedCount} communit${notice.blockedCount === 1 ? 'y' : 'ies'}`
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-marker-container-line bg-marker-container px-4 py-2 text-body-sm text-on-surface"
    >
      <span>
        Mesh could not open {label} safely. {blockedCommunityGuidance(notice.reasons)}
      </span>
      <Button variant="ghost" size="sm" disabled={retrying} onClick={onRetry}>
        {retrying ? 'Trying again…' : 'Try again'}
      </Button>
    </div>
  )
}

/**
 * A room Mesh will not open is a partial room list, not a failed one, so this
 * is the same advisory band the community listing already had. It is scoped to
 * the community you are looking at: a hidden room in another community is not
 * something you can act on from here.
 */
function RoomLoadBanner({
  notice,
  retrying,
  onRetry,
}: {
  notice: RoomLoadNotice
  retrying: boolean
  onRetry: () => void
}) {
  const label = `${notice.blockedCount} room${notice.blockedCount === 1 ? '' : 's'}`
  return (
    // Same band as the community notice, but through the warning container
    // quintuple rather than an opacity modifier on the status colour, which is
    // the direction check-design-tokens.mjs is pushing every caller.
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-marker-container-line bg-marker-container px-4 py-2 text-body-sm text-on-surface"
    >
      <span>
        Mesh could not open {label} safely. {blockedRoomGuidance(notice.reasons)}
      </span>
      <Button variant="ghost" size="sm" disabled={retrying} onClick={onRetry}>
        {retrying ? 'Trying again…' : 'Try again'}
      </Button>
    </div>
  )
}

export default function App() {
  const isTauriRuntime = bridge.isTauriRuntime()
  const identity = useIdentityStore((state) => state.identity)
  const isLoading = useIdentityStore((state) => state.isLoading)
  const setIdentity = useIdentityStore((state) => state.setIdentity)
  const setLoading = useIdentityStore((state) => state.setLoading)
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const communityIdsKey = useCommunityStore((s) => s.communityOrder.join('\u0000'))
  const setCommunities = useCommunityStore((s) => s.setCommunities)
  const upsertCommunity = useCommunityStore((s) => s.upsertCommunity)
  const setChannels = useChannelStore((s) => s.setChannels)
  const replaceCommunityChannels = useChannelStore((s) => s.replaceCommunityChannels)
  const setCommunityRefresh = useChannelStore((s) => s.setCommunityRefresh)
  const requestCommunityRefresh = useChannelStore((s) => s.requestCommunityRefresh)
  const channelRefreshRequests = useChannelStore((s) => s.refreshRequests)
  // Recomputing this in the render body ran a sort, a map, and a join on every
  // App render, including the ones the status poll causes twelve times a minute.
  const channelRefreshRequestsKey = useMemo(
    () => Object.entries(channelRefreshRequests)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, attempt]) => `${id}:${attempt}`)
      .join('\u0000'),
    [channelRefreshRequests],
  )
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const setNetworkStatus = useNetworkStore((s) => s.setStatus)
  const setMatrixLink = useNetworkStore((s) => s.setMatrixLink)
  const activateBackupAccount = useSettingsStore((s) => s.activateBackupAccount)
  const scheduleBackupReminder = useSettingsStore((s) => s.scheduleBackupReminder)
  const pendingInvitation = useShellStore((state) => state.pendingInvitation)
  const setPendingInvitation = useShellStore((state) => state.setPendingInvitation)
  const [showOnboarding, setShowOnboarding] = useState(!isTauriRuntime)
  const [backendStatus, setBackendStatus] = useState<bridge.BackendStatus | null>(null)
  const [bootstrapIssue, setBootstrapIssue] = useState<BootstrapIssue | null>(null)
  const [bootstrapRetrying, setBootstrapRetrying] = useState(false)
  const [showStartupDiagnostics, setShowStartupDiagnostics] = useState(false)
  const [communityLoadNotice, setCommunityLoadNotice] = useState<CommunityLoadNotice | null>(null)
  const [communityNoticeRetrying, setCommunityNoticeRetrying] = useState(false)
  /*
   * Blocked rooms are carried here, keyed by community, rather than on
   * `CommunityRefreshState`. The channel store is another owner's file, and
   * this is the smallest place that already knows the result of every room
   * refresh. The store change that would replace this is written up in the
   * report; nothing else reads this, so moving it later is a local edit.
   */
  const [roomLoadNotices, setRoomLoadNotices] = useState<Record<string, RoomLoadNotice>>({})
  const activeRoomLoadNotice = activeCommunityId ? roomLoadNotices[activeCommunityId] : undefined
  /*
   * Which community's room list is being retried, if any. The store's refresh
   * status cannot answer this: `stale` means both "refreshing over last-good"
   * and "the last refresh failed but last-good stands", so a button driven by
   * it would read "Trying again…" forever after one failure.
   */
  const [retryingRoomsCommunityId, setRetryingRoomsCommunityId] = useState<string | null>(null)
  const activeRoomRefreshing = Boolean(activeCommunityId) && retryingRoomsCommunityId === activeCommunityId
  const [initializationAttempt, setInitializationAttempt] = useState(0)
  // Sign-in recovery clears this account's renderer state. Until the person
  // signs in again, every account-scoped poll has to stay stopped, or the
  // native status the poll reports back re-populates exactly what was cleared.
  const [locallySignedOut, setLocallySignedOut] = useState(false)
  // Mirrors the state for reads inside an in-flight poll, which can resolve
  // before React has committed the sign-out render.
  const locallySignedOutRef = useRef(false)
  // Only the three peek sites advance this: the newest peek is the freshest
  // view of native state, so an older one must never overwrite it.
  const pendingInvitationPeekRef = useRef(0)
  // A discard is a fact about one handle, not a newer observation. Recording
  // the handle stops a racing peek from resurrecting that invitation while
  // still letting the same peek deliver a different one. A single shared
  // counter could not express both, so a newly saved invitation that arrived
  // during a discard was dropped from the UI until the next launch.
  const discardedInvitationHandlesRef = useRef(new Set<string>())

  /**
   * Apply one peek result. Returns whether it reached the shell, so callers
   * can avoid announcing an invitation that was superseded or discarded.
   */
  const applyPendingInvitationPeek = useCallback(
    (sequence: number, pending: PendingInvitationMetadata | null) => {
      if (sequence !== pendingInvitationPeekRef.current) return false
      if (pending && discardedInvitationHandlesRef.current.has(pending.handle)) return false
      setPendingInvitation(pending)
      return true
    },
    [setPendingInvitation],
  )

  /**
   * Adopt a status that came from startup or a real sign-in, which ends any
   * locally signed-out state. Keeping the previous object when the content
   * matches spares every effect that depends on the status object.
   */
  const adoptBackendStatus = useCallback((status: bridge.BackendStatus) => {
    locallySignedOutRef.current = false
    setLocallySignedOut(false)
    setBackendStatus((current) => sameBackendStatus(current, status) ? current : status)
  }, [])

  const applyCommunityListing = useCallback((listing: bridge.EntityListResult<Community>) => {
    setCommunities(listing.entities)
    const blockedCount = listing.blockedEntities.length
    // A quarantined community is a partial result, not a failed startup. This
    // used to raise a full-screen wall whenever *every* community was blocked,
    // which meant one unopenable room locked the person out of direct messages,
    // settings, sign-out, and joining anything else, none of which depend on
    // communities. The same failure on an account with two communities only
    // produced this banner, so the harsher outcome landed on the smaller account.
    setCommunityLoadNotice(
      blockedCount > 0
        ? {
            blockedCount,
            reasons: listing.blockedEntities.map((entity) => entity.reason),
          }
        : null,
    )
    return { blockedCount }
  }, [setCommunities])

  useEffect(() => {
    if (!isTauriRuntime) return
    const openExternalLink = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest<HTMLAnchorElement>('a[target="_blank"][href]')
      if (!anchor) return
      event.preventDefault()
      void bridge.openExternalUrl(anchor.href).catch((error) => {
        console.error('Could not open external link:', error)
        showToast('Mesh could not open that secure link. Copy it and review the address.', 'error')
      })
    }
    document.addEventListener('click', openExternalLink, true)
    return () => document.removeEventListener('click', openExternalLink, true)
  }, [isTauriRuntime])

  useEffect(() => {
    if (!isTauriRuntime) return
    let active = true
    const sequence = ++pendingInvitationPeekRef.current
    void bridge
      .peekPendingInvitation()
      .then((pending) => {
        if (active) applyPendingInvitationPeek(sequence, pending)
      })
      .catch((error) => {
        if (active && pendingInvitationPeekRef.current === sequence) {
          console.warn('Could not inspect the pending invitation:', error)
        }
      })
    return () => {
      active = false
    }
  }, [applyPendingInvitationPeek, isTauriRuntime])

  useEffect(() => {
    if (!isTauriRuntime) return
    let active = true
    let unlisten: (() => void) | undefined

    void listen('mesh-pending-invitation-ready', () => {
      if (!active) return
      const sequence = ++pendingInvitationPeekRef.current
      void bridge.peekPendingInvitation()
        .then((pending) => {
          if (!active) return
          const applied = applyPendingInvitationPeek(sequence, pending)
          if (applied && pending) {
            showToast('Community invitation saved securely and ready to review.', 'success')
          }
        })
        .catch((error) => {
          if (!active || pendingInvitationPeekRef.current !== sequence) return
          console.warn('Could not inspect the saved community invitation:', error)
          showToast(
            'Mesh saved the invitation, but could not show its details yet. Try opening it again.',
            'error',
          )
        })
    })
      .then((cleanup) => {
        if (active) unlisten = cleanup
        else cleanup()
      })
      .catch((error) => {
        if (active) console.error('Could not listen for saved community invitations:', error)
      })

    return () => {
      active = false
      unlisten?.()
    }
  }, [applyPendingInvitationPeek, isTauriRuntime])

  useEffect(() => {
    if (!pendingInvitation) return
    beginInvitationActivation(pendingInvitation.handle, pendingInvitation.storedAt)
  }, [pendingInvitation])

  useEffect(() => {
    let active = true
    if (!isTauriRuntime) {
      void bridge.getBackendStatus().then((status) => {
        if (!active) return
        adoptBackendStatus(status)
        setBootstrapIssue(null)
        setLoading(false)
      })
      return () => {
        active = false
      }
    }

    const init = async () => {
      let phase: BootstrapIssue['kind'] = 'startup'
      try {
        const startupStatus = await bridge.ensureBackendStarted(false)
        if (!active) return
        if (startupStatus.phase === 'recoverable-failure') {
          setBootstrapIssue({
            kind: 'startup',
            blockedCount: 0,
            startupIssue: startupStatus.issue,
          })
          setLoading(false)
          return
        }
        const nextBackendStatus = await bridge.getBackendStatus()
        if (!active) return
        adoptBackendStatus(nextBackendStatus)

        if (nextBackendStatus.kind === 'matrix') {
          if (nextBackendStatus.authenticated) {
            activateBackupAccount(nextBackendStatus.userId)
            const signedInIdentity = await loadMatrixIdentity(
              nextBackendStatus.userId,
              isTauriRuntime,
            )
            if (!active) return
            phase = 'communities'
            const listing = await bridge.getCommunitiesResult()
            if (!active) return
            applyCommunityListing(listing)
            if (signedInIdentity) {
              setIdentity(signedInIdentity)
            }
          }
          setBootstrapIssue(null)
          setShowOnboarding(!nextBackendStatus.authenticated)
          setLoading(false)
          return
        }

        const existingIdentity = await bridge.getIdentity()
        if (!active) return
        if (!existingIdentity) {
          setShowOnboarding(true)
          setLoading(false)
          return
        }

        phase = 'communities'
        const listing = await bridge.getCommunitiesResult()
        if (!active) return
        applyCommunityListing(listing)
        setIdentity(existingIdentity)
        setBootstrapIssue(null)
        setShowOnboarding(!isProfileComplete(existingIdentity))
      } catch (err) {
        if (!active) return
        console.error('Init error:', err)
        setBootstrapIssue({
          kind: phase,
          blockedCount: 0,
          startupIssue: phase === 'startup' ? 'runtime-unavailable' : undefined,
        })
        setLoading(false)
      }
    }

    void init()
    return () => {
      active = false
    }
  }, [
    activateBackupAccount,
    adoptBackendStatus,
    applyCommunityListing,
    initializationAttempt,
    isTauriRuntime,
    setIdentity,
    setLoading,
  ])

  const retryCommunityBootstrap = useCallback(async () => {
    setBootstrapRetrying(true)
    try {
      const listing = await bridge.getCommunitiesResult()
      applyCommunityListing(listing)
      setBootstrapIssue(null)
      setShowOnboarding(false)
    } catch (error) {
      console.error('Failed to retry the community list:', error)
      setBootstrapIssue({ kind: 'communities', blockedCount: 0 })
    } finally {
      setBootstrapRetrying(false)
      setLoading(false)
    }
  }, [applyCommunityListing, setLoading])

  const openSignInRecovery = useCallback(async () => {
    const previousAccountId = backendStatus?.userId ?? null
    /*
      Imported here rather than at module scope. account-transition reaches
      nineteen stores to reset them, and a static import pulls every one of them
      into the startup chunk for the sake of a handler that only ever runs on
      sign-out -- about 42 KiB nobody signing in has any use for.

      The await is deliberate and the ordering below depends on it. Everything
      from clearIdentity onward stays in its original sequence, so the flag that
      stops the account-scoped polls is still set after the stores are cleared,
      not before. A poll landing during the import itself is harmless: it can
      repopulate, but the clear runs immediately afterwards.
    */
    let accountTransition
    try {
      accountTransition = await import('./lib/account-transition')
    } catch (cause) {
      /*
        A chunk that will not load is the one failure mode a dynamic import adds
        over a static one, and it must not be silent. This handler is passed
        straight into a prop typed `() => void`, so an unhandled rejection would
        leave a person looking at an application that still says they are signed
        in, next to a button that did nothing. Nothing has been mutated yet, so
        returning here leaves a consistent state they can retry from.
      */
      const description = describeError(cause, { operation: 'sign out' })
      showToast(errorLine(description), 'error')
      return
    }
    // Identity is cleared by the sweep now, beside every other store, rather
    // than here where it had to be remembered separately.
    accountTransition.clearRendererAccountState(previousAccountId)
    // Patching the status object is not enough on its own: the account-scoped
    // polls run off the *native* state and would report the old account back
    // within five seconds, repopulating everything that was just cleared and
    // flipping the onboarding flow's step list under a person the UI is
    // showing as signed out. The flag stops those polls until a real sign-in.
    locallySignedOutRef.current = true
    setLocallySignedOut(true)
    setBackendStatus((current) => current ? {
      ...current,
      authenticated: false,
      userId: null,
      deviceId: null,
      syncRunning: false,
      sessionE2eeReady: false,
    } : null)
    setBootstrapIssue(null)
    setShowOnboarding(true)
    setLoading(false)
  }, [backendStatus?.userId, setLoading])

  const completeMatrixOnboarding = useCallback(async () => {
    activateBackupAccount(backendStatus?.userId ?? null)
    setShowOnboarding(false)
    setBootstrapIssue(null)
    setLoading(true)
    try {
      const listing = await bridge.getCommunitiesResult()
      applyCommunityListing(listing)
    } catch (error) {
      console.error('Failed to load communities after onboarding:', error)
      setBootstrapIssue({ kind: 'communities', blockedCount: 0 })
    } finally {
      setLoading(false)
    }
  }, [activateBackupAccount, applyCommunityListing, backendStatus?.userId, setLoading])

  const retryCommunityNotice = useCallback(async () => {
    setCommunityNoticeRetrying(true)
    try {
      const listing = await bridge.getCommunitiesResult()
      applyCommunityListing(listing)
    } catch (error) {
      console.error('Failed to retry hidden communities:', error)
      showToast(
        "Mesh still couldn't open those communities. Check your connection and try again.",
        'error',
      )
    } finally {
      setCommunityNoticeRetrying(false)
    }
  }, [applyCommunityListing])

  const retryBootstrap = useCallback(() => {
    if (bootstrapIssue?.kind === 'startup') {
      setBootstrapRetrying(true)
      void bridge.ensureBackendStarted(true)
        .then((status) => {
          if (status.phase === 'recoverable-failure') {
            setBootstrapIssue({
              kind: 'startup',
              blockedCount: 0,
              startupIssue: status.issue,
            })
            return
          }
          setBootstrapIssue(null)
          setLoading(true)
          setInitializationAttempt((attempt) => attempt + 1)
        })
        .catch((error) => {
          console.error('Failed to retry native startup:', error)
          setBootstrapIssue({
            kind: 'startup',
            blockedCount: 0,
            startupIssue: 'runtime-unavailable',
          })
        })
        .finally(() => {
          setBootstrapRetrying(false)
        })
      return
    }
    void retryCommunityBootstrap()
  }, [bootstrapIssue?.kind, retryCommunityBootstrap, setLoading])

  useEffect(() => {
    if (!isTauriRuntime || backendStatus?.kind !== 'matrix') {
      return
    }

    setNetworkStatus(mapMatrixNetworkState(backendStatus.authenticated, backendStatus.syncRunning))
    /*
     * The same reading, published at the resolution the shell needs. Until now
     * this state was written and never rendered: a stalled sync produced a
     * `disconnected` network status that nothing in the product displayed.
     *
     * Skipped while locally signed out. `openSignInRecovery` has already reset
     * the network store for the account boundary and is showing onboarding, so
     * republishing `signed-out` here would only re-arm a band nobody can see.
     */
    if (!locallySignedOut) {
      setMatrixLink(matrixLinkPhaseFor({
        authenticated: backendStatus.authenticated,
        syncRunning: backendStatus.syncRunning,
      }))
    }
  }, [
    backendStatus?.authenticated,
    backendStatus?.kind,
    backendStatus?.syncRunning,
    isTauriRuntime,
    locallySignedOut,
    setMatrixLink,
    setNetworkStatus,
  ])

  useEffect(() => {
    if (!isTauriRuntime || locallySignedOut || backendStatus?.kind !== 'matrix') {
      return
    }

    let alive = true
    const unregisterPoll = registerPoll({
      key: 'matrix-backend-status',
      intervalMs: MATRIX_STATUS_POLL_INTERVAL_MS,
      pauseWhenHidden: true,
      backoffOnError: true,
      run: async () => {
        try {
          const nextStatus = await bridge.getBackendStatus()
          if (alive && !locallySignedOutRef.current) {
            /*
             * Published from the poll rather than only from the status effect.
             * A failed poll writes `unreachable` directly, and the recovering
             * poll usually returns a status identical to the last good one, so
             * `setBackendStatus` keeps the previous object and the effect below
             * never re-runs. The shell would then hold a stale offline band
             * over a healthy connection.
             */
            setMatrixLink(matrixLinkPhaseFor(nextStatus))
            // Keep the previous object when nothing changed. A fresh object
            // every five seconds re-ran every effect keyed on the status.
            setBackendStatus((current) =>
              sameBackendStatus(current, nextStatus) ? current : nextStatus,
            )
          }
        } catch (error) {
          if (alive) {
            setNetworkStatus({
              state: 'disconnected',
              peerCount: 0,
              averageLatency: 0,
            })
            /*
             * A different failure from a stalled sync: Mesh could not read its
             * own connection state at all. This poll backs off exponentially
             * to five minutes, so the automatic retry may be a long way out.
             * That is exactly the case where a manual check earns its place.
             */
            setMatrixLink('unreachable')
            console.warn('Could not refresh connection status; Mesh will retry.', error)
          }
          throw error
        }
      },
    })

    return () => {
      alive = false
      unregisterPoll()
    }
  }, [
    backendStatus?.kind,
    isTauriRuntime,
    locallySignedOut,
    setMatrixLink,
    setNetworkStatus,
  ])

  useEffect(() => {
    const pendingHandle = pendingInvitation?.handle
    if (
      !isTauriRuntime ||
      showOnboarding ||
      backendStatus?.kind !== 'matrix' ||
      !backendStatus.authenticated ||
      !pendingHandle
    ) {
      return
    }
    let active = true
    const sequence = ++pendingInvitationPeekRef.current
    void bridge
      .peekPendingInvitation()
      .then((describedPending) => {
        // Only richer detail for the invitation already on screen belongs here.
        // A different handle is another flow's business.
        if (active && describedPending?.handle === pendingHandle) {
          applyPendingInvitationPeek(sequence, describedPending)
        }
      })
      .catch((error) => {
        if (active && pendingInvitationPeekRef.current === sequence) {
          console.warn('Could not refresh community invitation details:', error)
        }
      })
    return () => {
      active = false
    }
  }, [
    applyPendingInvitationPeek,
    backendStatus?.authenticated,
    backendStatus?.kind,
    isTauriRuntime,
    pendingInvitation?.handle,
    showOnboarding,
  ])

  const clearPendingInvitationForHandle = async (handle: string | undefined) => {
    // Record the discard as a handle fact rather than bumping the peek
    // sequence. Bumping rejected whatever a racing peek found, including a
    // *different* invitation that had just been saved natively, which then had
    // no path back into the UI: the mount peek had already run and the refresh
    // effect is gated on a pending handle this discard is about to clear.
    // Handles are minted per stored invitation, so a re-opened link arrives
    // with a new handle and is never suppressed by this set.
    if (handle) discardedInvitationHandlesRef.current.add(handle)
    if (isTauriRuntime && handle) await bridge.clearPendingInvitation(handle)
    // The discard is authoritative: apply it whenever the shell still shows the
    // handle we cleared. Re-checking the peek sequence here would let a
    // concurrent same-handle refresh silently skip this clear, stranding a
    // cleared invitation in the UI. The handle check already prevents wiping a
    // newer, different invitation another flow set while the clear was in
    // flight.
    if (useShellStore.getState().pendingInvitation?.handle !== handle) return
    setPendingInvitation(null)
  }

  useEffect(() => {
    if (!isTauriRuntime) {
      return
    }

    const communityIds = communityIdsKey ? communityIdsKey.split('\u0000') : []
    if (communityIds.length === 0) {
      setChannels([])
      return
    }

    let alive = true

    const prioritizedCommunityIds = activeCommunityId && communityIds.includes(activeCommunityId)
      ? [activeCommunityId, ...communityIds.filter((id) => id !== activeCommunityId)]
      : communityIds

    const repairSelection = () => {
      const state = useChannelStore.getState()
      const selected = state.activeChannelId
        ? state.channelEntities[state.activeChannelId]
        : undefined
      if (selected?.communityId === activeCommunityId) return
      // Never land on a room this account has not joined. Selecting one is
      // legitimate when a person asks for it by name or by link, and Mesh offers
      // the join there; choosing one on their behalf would open a community on a
      // join button instead of a conversation.
      setActiveChannel(
        state.channelOrder.find((channelId) => {
          const candidate = state.channelEntities[channelId]
          return candidate?.communityId === activeCommunityId && candidate.joined !== false
        }) ?? null,
      )
    }

    // Community navigation is local state and must be repaired immediately.
    // Waiting for the selected community's network refresh can otherwise leave
    // a room from the previous community interactive under the new selection.
    repairSelection()

    const loadCommunity = async (communityId: string) => {
      if (!alive) return
      const state = useChannelStore.getState()
      const current = state.refreshByCommunity[communityId]
      const generation = (current?.generation ?? 0) + 1
      const hasLastGood = state.channels.some((channel) => channel.communityId === communityId)
      setCommunityRefresh(communityId, {
        status: hasLastGood ? 'stale' : 'loading',
        error: null,
        generation,
      })
      try {
        const listing = await bridge.getChannelsResult(communityId)
        if (!alive) return
        const latest = useChannelStore.getState().refreshByCommunity[communityId]
        if (latest?.generation !== generation) return
        replaceCommunityChannels(communityId, listing.entities)
        setCommunityRefresh(communityId, { status: 'loaded', error: null, generation })
        // A room Mesh refuses to open is missing from `entities`, so without
        // this the sidebar is quietly short by one room and says nothing.
        setRoomLoadNotices((current) => {
          if (listing.blockedEntities.length === 0) {
            if (!current[communityId]) return current
            const cleared = { ...current }
            delete cleared[communityId]
            return cleared
          }
          return {
            ...current,
            [communityId]: {
              blockedCount: listing.blockedEntities.length,
              reasons: listing.blockedEntities.map((entity) => entity.reason),
            },
          }
        })
        if (communityId === activeCommunityId) repairSelection()
      } catch (error) {
        if (!alive) return
        const latest = useChannelStore.getState().refreshByCommunity[communityId]
        if (latest?.generation !== generation) return
        const stillHasLastGood = useChannelStore.getState().channels.some(
          (channel) => channel.communityId === communityId,
        )
        setCommunityRefresh(communityId, {
          status: stillHasLastGood ? 'stale' : 'failed',
          error,
          generation,
        })
        if (communityId === activeCommunityId) repairSelection()
        console.error(`Failed to refresh rooms for community ${communityId}:`, error)
      } finally {
        // Any settled attempt ends the retry, including a superseded one: the
        // attempt that superseded it will end its own.
        setRetryingRoomsCommunityId((current) => current === communityId ? null : current)
      }
    }

    void (async () => {
      const [selectedCommunityId, ...remainingCommunityIds] = prioritizedCommunityIds
      if (selectedCommunityId) await loadCommunity(selectedCommunityId)
      if (!alive) return
      await mapSettledWithConcurrency(remainingCommunityIds, 4, loadCommunity, () => alive)
    })()

    return () => {
      alive = false
    }
  }, [
    activeCommunityId,
    channelRefreshRequestsKey,
    communityIdsKey,
    isTauriRuntime,
    replaceCommunityChannels,
    setActiveChannel,
    setChannels,
    setCommunityRefresh,
  ])

  useEffect(() => {
    const userId =
      backendStatus?.kind === 'matrix' && backendStatus.authenticated ? backendStatus.userId : null
    if (!isTauriRuntime || locallySignedOut || !userId) return

    let alive = true
    const unregisterPoll = registerPoll({
      key: `matrix-preferences:${userId}`,
      intervalMs: 30_000,
      run: async () => {
        try {
          await refreshMatrixPreferences(userId)
        } catch (error) {
          if (alive) console.error('Failed to refresh Matrix preferences:', error)
          throw error
        }
      },
      pauseWhenHidden: true,
      backoffOnError: true,
    })
    return () => {
      alive = false
      unregisterPoll()
    }
  }, [
    backendStatus?.authenticated,
    backendStatus?.kind,
    backendStatus?.userId,
    isTauriRuntime,
    locallySignedOut,
  ])

  useEffect(() => {
    if (!isTauriRuntime) {
      setNetworkStatus({
        state: 'connecting',
        peerCount: 0,
        averageLatency: 0,
      })
      return
    }

    if (backendStatus?.kind === 'matrix') {
      return
    }

    const unlisten = bridge.onNetworkStatus((status) => {
      setNetworkStatus(mapNetworkState(status))
    })

    return () => {
      disposeSubscription(unlisten, 'network status listener')
    }
    // Only the backend kind decides whether this legacy subscription belongs
    // here. Depending on the whole status object tore this listener down and
    // re-subscribed it every time the 5 second poll produced a fresh object.
  }, [backendStatus?.kind, isTauriRuntime, setNetworkStatus])

  useEffect(() => {
    if (!isTauriRuntime) {
      return
    }

    const unlisten = bridge.onCommunityUpdated((community) => {
      upsertCommunity(community)
    })

    return () => {
      disposeSubscription(unlisten, 'community update listener')
    }
  }, [isTauriRuntime, upsertCommunity])

  /**
   * Keeps the community rail current in Matrix mode.
   *
   * `community:updated` is emitted only by the legacy backend, so on Matrix the
   * listing was fetched at bootstrap and never again: a space joined or left on
   * another device, or an invitation that arrived in a later sync, stayed
   * invisible until the app restarted.
   */
  useEffect(() => {
    if (!isTauriRuntime || !bridge.isMatrixBackend()) return
    let disposed = false
    let pending: ReturnType<typeof setTimeout> | null = null

    // Membership events arrive in bursts, notably while the first sync settles.
    // One refetch per burst is enough, since the listing is read whole.
    const refresh = () => {
      if (pending != null) return
      pending = setTimeout(() => {
        pending = null
        if (disposed) return
        void bridge.getCommunitiesResult()
          .then((listing) => {
            if (!disposed) applyCommunityListing(listing)
          })
          .catch(() => {
            // A failed refresh leaves the rail on the last confirmed listing,
            // and the next membership change asks again.
          })
      }, 250)
    }

    const unlisten = bridge.onMatrixCommunitiesChanged(refresh)

    return () => {
      disposed = true
      if (pending != null) clearTimeout(pending)
      disposeSubscription(unlisten, 'community change listener')
    }
  }, [applyCommunityListing, isTauriRuntime])

  if (bootstrapIssue) {
    return (
      <>
        <div className="flex min-h-screen items-center justify-center bg-surface px-4">
          <BootstrapRecovery
            issue={bootstrapIssue}
            retrying={bootstrapRetrying}
            onRetry={retryBootstrap}
            /*
              Both recovery kinds need a way out. Gating these on 'startup'
              left the community failure with nothing but a retry of the call
              that had just failed, so an account whose community list could
              not load had no route to sign-in, and no route to the connection
              check that would explain why.
            */
            onOpenSignInRecovery={() => {
              setBootstrapIssue(null)
              setBootstrapRetrying(false)
              setShowOnboarding(true)
              setLoading(false)
            }}
            onOpenDiagnostics={() => setShowStartupDiagnostics(true)}
          />
        </div>
        {showStartupDiagnostics ? (
          <Suspense fallback={null}>
            <DiagnosticsPanel
              open
              backendKind={backendStatus?.kind ?? 'matrix'}
              onClose={() => setShowStartupDiagnostics(false)}
            />
          </Suspense>
        ) : null}
      </>
    )
  }

  if (isLoading && !showOnboarding) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <ColdStartStatus
          invitationName={pendingInvitation?.communityName}
          onRecovery={() => {
            setShowOnboarding(true)
            setLoading(false)
          }}
        />
      </div>
    )
  }

  return (
    <>
      <AnimatePresence mode="wait">
        {showOnboarding || (backendStatus?.kind === 'legacy-p2p' && !identity) ? (
          <ErrorBoundary scope="app">
            <motion.div
              key="onboarding"
              variants={variants.screen}
              initial="initial"
              animate="animate"
              exit="exit"
              className="h-full"
            >
              <OnboardingFlow
                initialPendingInvitation={pendingInvitation}
                onDiscardPendingInvitation={async () => {
                  const handle = pendingInvitation?.handle
                  await clearPendingInvitationForHandle(handle)
                }}
                backendKind={backendStatus?.kind ?? 'matrix'}
                backendAuthenticated={!locallySignedOut && (backendStatus?.authenticated ?? false)}
                onMatrixCheckUsernameAvailable={async (homeserver, username) => {
                  if (!isTauriRuntime) {
                    return !['admin', 'support', 'taken'].includes(username)
                  }
                  return bridge.matrixCheckUsernameAvailable(homeserver, username)
                }}
                onMatrixRegisterAccount={async (request) => {
                  if (!isTauriRuntime) {
                    const status: bridge.BackendStatus = {
                      kind: 'matrix',
                      capabilities: bridge.getBackendCapabilities(),
                      voiceService: bridge.getVoiceServiceStatus(),
                      authenticated: true,
                      userId: `@${request.username}:preview.mesh`,
                      deviceId: 'PREVIEW',
                      homeserver: 'https://preview.mesh',
                      syncRunning: true,
                      durableHistory: true,
                      supportsE2ee: true,
                      sessionE2eeReady: true,
                      warnings: [],
                    }
                    adoptBackendStatus(status)
                    const registeredIdentity = await loadMatrixIdentity(status.userId, false)
                    if (registeredIdentity) setIdentity(registeredIdentity)
                    return
                  }
                  const status = await bridge.matrixRegisterAccount(request)
                  activateBackupAccount(status.userId)
                  adoptBackendStatus(status)
                  const registeredIdentity = await loadMatrixIdentity(status.userId, true)
                  if (registeredIdentity) setIdentity(registeredIdentity)
                }}
                onMatrixLogin={async (request) => {
                  if (!isTauriRuntime) {
                    const status: bridge.BackendStatus = {
                      kind: 'matrix',
                      capabilities: bridge.getBackendCapabilities(),
                      voiceService: bridge.getVoiceServiceStatus(),
                      authenticated: true,
                      userId: '@preview:example.com',
                      deviceId: 'PREVIEW',
                      homeserver: request.homeserver,
                      syncRunning: true,
                      durableHistory: true,
                      supportsE2ee: true,
                      sessionE2eeReady: true,
                      warnings: [],
                    }
                    adoptBackendStatus(status)
                    const signedInIdentity = await loadMatrixIdentity(status.userId, false)
                    if (signedInIdentity) setIdentity(signedInIdentity)
                    return
                  }
                  const status = await bridge.matrixLogin(request)
                  activateBackupAccount(status.userId)
                  adoptBackendStatus(status)
                  const signedInIdentity = await loadMatrixIdentity(status.userId, true)
                  if (signedInIdentity) setIdentity(signedInIdentity)
                }}
                onMatrixOidcLogin={async (homeserver) => {
                  const status = await bridge.matrixStartOidcLogin(homeserver)
                  activateBackupAccount(status.userId)
                  adoptBackendStatus(status)
                  const signedInIdentity = await loadMatrixIdentity(status.userId, true)
                  if (signedInIdentity) setIdentity(signedInIdentity)
                }}
                onMatrixSwitchAccount={async (profileId) => {
                  const status = await bridge.matrixSwitchAccount(profileId)
                  activateBackupAccount(status.userId)
                  adoptBackendStatus(status)
                  const signedInIdentity = await loadMatrixIdentity(status.userId, true)
                  if (signedInIdentity) setIdentity(signedInIdentity)
                }}
                onBackupSkipped={scheduleBackupReminder}
                initialProfile={identity ?? undefined}
                onGenerateIdentity={async () => {
                  if (!isTauriRuntime) {
                    setIdentity({
                      publicKey: 'preview-local-identity',
                      displayName: '',
                      avatarColor: '',
                    })
                    return
                  }

                  const nextIdentity = await bridge.createIdentity()
                  setIdentity(nextIdentity)
                }}
                onUpdateProfile={async (profile) => {
                  if (!isTauriRuntime) {
                    setIdentity({
                      publicKey: identity?.publicKey ?? 'preview-local-identity',
                      displayName: profile.displayName,
                      avatarColor: profile.avatarColor,
                    })
                    return
                  }

                  const nextIdentity = await bridge.updateProfile(
                    profile.displayName,
                    profile.avatarColor,
                  )
                  setIdentity(nextIdentity)
                }}
                onBootstrap={async (update) => {
                  if (backendStatus?.kind === 'matrix') {
                    update({
                      phase: 'connecting',
                      ...BOOTSTRAP_STEPS.connecting,
                    })
                    if (!isTauriRuntime) {
                      await wait(450)
                      update({
                        phase: 'syncing',
                        ...BOOTSTRAP_STEPS.syncing,
                      })
                      await wait(450)
                      update({
                        phase: 'ready',
                        ...BOOTSTRAP_STEPS.ready,
                      })
                      return
                    }

                    update({
                      phase: 'syncing',
                      ...BOOTSTRAP_STEPS.syncing,
                    })
                    // Matrix login/session restoration already completes an initial sync
                    // before starting the continuous background sync loop. Starting a
                    // second sync here can contend with that loop and leave onboarding
                    // waiting indefinitely.
                    update({
                      phase: 'finalizing',
                      ...BOOTSTRAP_STEPS.finalizing,
                    })
                    update({ phase: 'ready', ...BOOTSTRAP_STEPS.ready })
                    return
                  }

                  update({
                    phase: 'connecting',
                    ...BOOTSTRAP_STEPS.connecting,
                  })

                  if (!isTauriRuntime) {
                    await wait(700)
                    update({ phase: 'syncing', ...BOOTSTRAP_STEPS.syncing })
                    await wait(850)
                    update({
                      phase: 'finalizing',
                      label: 'Opening preview data',
                      progress: BOOTSTRAP_STEPS.finalizing.progress,
                    })
                    await wait(550)
                    update({
                      phase: 'ready',
                      label: 'Preview ready',
                      progress: BOOTSTRAP_STEPS.ready.progress,
                    })
                    return
                  }

                  const unlistenPromise = bridge.onNetworkStatus((status) => {
                    if (status.peerCount > 0) {
                      update({
                        phase: 'syncing',
                        label: 'Connection found',
                        progress: 74,
                      })
                    }
                  })

                  try {
                    await wait(700)
                    update({ phase: 'syncing', ...BOOTSTRAP_STEPS.syncing })

                    await wait(850)
                    const { status } = useNetworkStore.getState()
                    update({
                      phase: 'finalizing',
                      label:
                        status.peerCount > 0
                          ? 'Connection ready'
                          : BOOTSTRAP_STEPS.finalizing.label,
                      progress: BOOTSTRAP_STEPS.finalizing.progress,
                    })

                    await wait(550)
                    update({
                      phase: 'ready',
                      label: BOOTSTRAP_STEPS.ready.label,
                      progress: BOOTSTRAP_STEPS.ready.progress,
                    })
                  } finally {
                    const unlisten = await unlistenPromise
                    unlisten()
                  }
                }}
                onComplete={() => {
                  if (isTauriRuntime && bridge.isMatrixBackend()) {
                    void completeMatrixOnboarding()
                    return
                  }
                  setShowOnboarding(false)
                }}
              />
            </motion.div>
          </ErrorBoundary>
        ) : (
          <ErrorBoundary scope="app">
            <motion.div
              key="app"
              variants={variants.screen}
              initial="initial"
              animate="animate"
              exit="exit"
              className="flex h-full min-h-0 flex-col"
            >
              {communityLoadNotice ? (
                <CommunityLoadBanner
                  notice={communityLoadNotice}
                  retrying={communityNoticeRetrying}
                  onRetry={() => void retryCommunityNotice()}
                />
              ) : null}
              {activeRoomLoadNotice && activeCommunityId ? (
                <RoomLoadBanner
                  notice={activeRoomLoadNotice}
                  retrying={activeRoomRefreshing}
                  onRetry={() => {
                    setRetryingRoomsCommunityId(activeCommunityId)
                    requestCommunityRefresh(activeCommunityId)
                  }}
                />
              ) : null}
              <div className="min-h-0 flex-1">
                <Suspense
                  fallback={
                    <div
                      className="flex h-full flex-col items-center justify-center gap-3 text-center"
                    >
                      <AsyncStatus
                        title={pendingInvitation
                          ? `Opening invitation to ${pendingInvitation.communityName?.trim() || 'your community'}`
                          : 'Bringing in your rooms'}

                      />
                    </div>
                  }
                >
                  <AppLayout onSignInRequired={openSignInRecovery} />
                </Suspense>
              </div>
            </motion.div>
          </ErrorBoundary>
        )}
      </AnimatePresence>
      <ToastContainer />
    </>
  )
}
