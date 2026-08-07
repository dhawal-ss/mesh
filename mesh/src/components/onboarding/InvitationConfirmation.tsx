import { useEffect, useRef, useState } from 'react'
import type { PendingInvitationMetadata } from '../../types/ipc'
import { describeJoinRule, joinRuleRequiresApproval } from '../../lib/community-access'
import * as bridge from '../../lib/bridge'
import { describeError, normalizeError } from '../../lib/errors'
import {
  clearInvitationActivation,
  recordInvitationMilestone,
} from '../../lib/invitation-activation'
import { beginNewcomerChecklist } from '../../lib/onboarding-checklist'
import { useIdentityStore } from '../../store/identity'
import { useCommunityStore } from '../../store/communities'
import { useMeshNavigationStore } from '../../store/navigation'
import { useShellStore } from '../../store/shell'
import { showToast } from '../ui/Toast'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { displayServiceAddress } from './matrixSignIn'

type InvitationPhase = 'entry' | 'arriving' | 'delayed' | 'failed' | 'discarding'
type InvitationFailureAction = 'retry' | 'sign-in' | 'home' | 'none'

const INVITATION_DELAY_MS = 15_000

function invitationCommunityName(pending: PendingInvitationMetadata): string {
  return pending.communityName?.trim() || 'Invited community'
}

function invitationServiceName(pending: PendingInvitationMetadata): string | null {
  const explicitName = pending.communityServiceDisplayName?.trim()
  if (explicitName) return explicitName

  const address = pending.service?.trim()
  return address ? displayServiceAddress(address) : null
}

export function InvitationDestinationCard({
  pending,
  compact = false,
}: {
  pending: PendingInvitationMetadata
  compact?: boolean
}) {
  const communityName = invitationCommunityName(pending)
  const inviterName = pending.inviterDisplayName?.trim()
  const serviceName = invitationServiceName(pending)
  const requiresApproval = joinRuleRequiresApproval(pending.joinRule)

  return (
    <section
      aria-label="Invitation destination"
      className="border border-border-subtle bg-surface-sunken p-3 sm:p-4"
    >
      <div className="flex items-start gap-3">
        <Avatar
          color="var(--accent)"
          size={compact ? 40 : 48}
          name={communityName}
          variant="community"
          className="flex-none !rounded-panel"
        />
        <div className="min-w-0 flex-1">
          <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">
            Invitation destination
          </p>
          <h2 className="truncate text-md font-semibold text-primary">{communityName}</h2>
          <p className="mt-0.5 text-sm text-secondary">Community</p>
        </div>
      </div>

      <dl className={`mt-3 grid gap-2 border-t border-border-subtle pt-3 text-caption text-secondary ${
        compact ? 'grid-cols-3' : 'sm:grid-cols-3'
      }`}>
        <div>
          <dt className="font-semibold uppercase tracking-signal text-muted">Invited by</dt>
          <dd className="mt-0.5 truncate text-primary">{inviterName || 'Not provided'}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-signal text-muted">Access</dt>
          <dd className="mt-0.5 text-primary">
            {requiresApproval
              ? 'Approval required'
              : pending.joinRule
                ? describeJoinRule(pending.joinRule)
                : 'Checked when you join'}
          </dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-signal text-muted">
            Suggested service
          </dt>
          <dd className="mt-0.5 break-words leading-4 text-primary">{serviceName || 'None'}</dd>
        </div>
      </dl>
    </section>
  )
}

export function InvitationSurface({
  handle,
  onSignInRequired,
}: {
  handle: string
  onSignInRequired: () => void
}) {
  const pending = useShellStore((state) => state.pendingInvitation)
  const setPendingInvitation = useShellStore((state) => state.setPendingInvitation)
  const savePendingInvitationForLater = useShellStore(
    (state) => state.savePendingInvitationForLater,
  )
  const upsertCommunity = useCommunityStore((state) => state.upsertCommunity)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const navigate = useMeshNavigationStore((state) => state.navigate)
  const [phase, setPhase] = useState<InvitationPhase>('entry')
  const [failure, setFailure] = useState<unknown>(null)
  const operationRef = useRef(0)
  const joinStartedRef = useRef(false)

  const matchingPending = pending?.handle === handle ? pending : null

  useEffect(() => {
    if (!matchingPending) return
    recordInvitationMilestone(handle, 'destination-visible')
    const focusFrame = window.requestAnimationFrame(() => {
      document.getElementById('mesh-invitation-heading')?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(focusFrame)
  }, [handle, matchingPending])

  useEffect(() => () => {
    operationRef.current += 1
  }, [])

  const join = async () => {
    if (!matchingPending || phase === 'arriving' || phase === 'delayed') return
    const operation = ++operationRef.current
    joinStartedRef.current = true
    setFailure(null)
    setPhase('arriving')
    recordInvitationMilestone(handle, 'join-started')
    const delayedTimer = window.setTimeout(() => {
      if (operationRef.current === operation) setPhase('delayed')
    }, INVITATION_DELAY_MS)

    try {
      const community = await bridge.joinPendingInvitation(handle)
      if (
        operationRef.current !== operation
        || useShellStore.getState().pendingInvitation?.handle !== handle
      ) return
      window.clearTimeout(delayedTimer)
      recordInvitationMilestone(handle, 'community-ready')
      const accountId = bridge.getMatrixUserId()
        ?? useIdentityStore.getState().identity?.publicKey
      if (accountId) {
        beginNewcomerChecklist({ accountId, communityId: community.id })
      }
      setPendingInvitation(null)
      upsertCommunity(community)
      setActiveCommunity(community.id)
      navigate({ kind: 'community', communityId: community.id }, { replace: true })
      showToast(`Welcome to ${community.name}.`, 'success')
    } catch (error) {
      if (
        operationRef.current !== operation
        || useShellStore.getState().pendingInvitation?.handle !== handle
      ) return
      window.clearTimeout(delayedTimer)
      setFailure(error)
      setPhase('failed')
    }
  }

  const saveForLater = () => {
    if (!matchingPending) return
    savePendingInvitationForLater()
    navigate({ kind: 'home' })
    showToast(`${invitationCommunityName(matchingPending)} is saved for later.`, 'success')
  }

  const discard = async () => {
    if (!matchingPending) return
    if (joinStartedRef.current && phase !== 'discarding') {
      setPhase('discarding')
      return
    }

    const operation = ++operationRef.current
    setFailure(null)
    try {
      await bridge.clearPendingInvitation(handle)
      if (
        operationRef.current !== operation
        || useShellStore.getState().pendingInvitation?.handle !== handle
      ) return
      setPendingInvitation(null)
      clearInvitationActivation(handle)
      navigate({ kind: 'home' }, { replace: true })
      showToast('Invitation discarded.', 'success')
    } catch (error) {
      if (operationRef.current !== operation) return
      setFailure(error)
      setPhase('failed')
    }
  }

  if (!matchingPending) {
    return (
      <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="mesh-invitation-heading">
        <InvitationHeader
          title="Invitation unavailable"
          detail="This invitation was completed, replaced, or is no longer saved on this device."
        />
        <div className="p-party-gutter">
          <Button onClick={() => navigate({ kind: 'home' }, { replace: true })}>Back to Home</Button>
        </div>
      </section>
    )
  }

  const communityName = invitationCommunityName(matchingPending)
  const requiresApproval = joinRuleRequiresApproval(matchingPending.joinRule)
  const errorDescription = failure
    ? describeError(failure, { operation: 'open this invitation', resource: 'community' })
    : null
  const failureAction: InvitationFailureAction = failure
    ? invitationFailureAction(failure)
    : 'none'
  const joinInProgress = phase === 'arriving' || phase === 'delayed'

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto" aria-labelledby="mesh-invitation-heading">
      <InvitationHeader
        title={`Invitation to ${communityName}`}
        detail="This destination stays ready while you decide."
      />

      <div className="mx-auto grid w-full max-w-onboarding-shell items-start gap-5 p-party-gutter lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
        <InvitationDestinationCard pending={matchingPending} />

        <section className="border border-border-subtle bg-surface-base p-4" aria-label="Invitation actions">
          {phase === 'discarding' ? (
            <div className="space-y-4">
              <div>
                <p className="text-caption font-semibold uppercase tracking-eyebrow text-status-warning">
                  Leave this destination
                </p>
                <h2 className="mt-1 text-md font-semibold text-primary">Discard the invitation?</h2>
                <p className="mt-2 text-sm leading-6 text-secondary">
                  Mesh will remove the saved invitation from this device. A join request already
                  sent to the community may still remain active.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button variant="secondary" onClick={() => setPhase(failure ? 'failed' : 'entry')}>
                  Keep invitation
                </Button>
                <Button variant="solid" tone="danger" onClick={() => void discard()}>
                  Discard
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">
                  Your next move
                </p>
                <h2 className="mt-1 text-md font-semibold text-primary">
                  {joinInProgress
                    ? `Entering ${communityName}`
                    : phase === 'failed'
                      ? `Mesh could not enter ${communityName}`
                      : requiresApproval
                        ? `Request access to ${communityName}`
                        : `Join ${communityName}`}
                </h2>
                <p className="mt-2 text-sm leading-6 text-secondary">
                  {phase === 'delayed'
                    ? 'This is taking longer than expected. Your destination is still saved and the current attempt is still running.'
                    : phase === 'arriving'
                      ? 'Your account service and this community can be different. Mesh is checking access now.'
                      : phase === 'failed'
                        ? errorDescription?.body
                        : 'Use your current account. Mesh will check the invitation and community rules only after you continue.'}
                </p>
              </div>

              {phase === 'failed' && errorDescription ? (
                <div role="alert" className="border border-status-danger/40 bg-status-danger/10 p-3 text-sm text-secondary">
                  <p className="font-semibold text-primary">{errorDescription.title}</p>
                  <p className="mt-1">{errorDescription.action}</p>
                </div>
              ) : null}

              <p className="border-t border-border-subtle pt-3 text-caption leading-5 text-muted">
                Your account service stores your account. This community can use a different
                compatible service.
              </p>

              <div className="grid gap-2">
                {phase !== 'failed' ? (
                  <Button
                    variant="primary"
                    onClick={() => void join()}
                    disabled={joinInProgress}
                  >
                    {joinInProgress ? <Spinner size={16} /> : null}
                    {requiresApproval ? 'Request to join' : `Join ${communityName}`}
                  </Button>
                ) : failureAction === 'retry' ? (
                  <Button variant="primary" onClick={() => void join()}>
                    Try again
                  </Button>
                ) : failureAction === 'sign-in' ? (
                  <Button variant="primary" onClick={onSignInRequired}>
                    Sign in again
                  </Button>
                ) : failureAction === 'home' ? (
                  <Button variant="primary" onClick={saveForLater}>
                    Back to Home
                  </Button>
                ) : null}
                {failureAction !== 'home' ? (
                  <Button
                    variant="secondary"
                    onClick={saveForLater}
                    disabled={joinInProgress}
                  >
                    Save for later
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  onClick={() => void discard()}
                  disabled={joinInProgress}
                >
                  Discard invitation
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  )
}

function invitationFailureAction(failure: unknown): InvitationFailureAction {
  const error = normalizeError(failure)
  if (error.code === 'not_authenticated') return 'sign-in'
  if (
    error.code === 'community_invite_invalid'
    || error.code === 'community_invite_requires_native_open'
    || error.code === 'room_not_found'
    || error.code === 'not_found'
  ) {
    return 'home'
  }
  return error.retryable ? 'retry' : 'none'
}

function InvitationHeader({ title, detail }: { title: string; detail: string }) {
  return (
    <header className="mesh-route-header flex flex-shrink-0 items-center border-b border-border-subtle px-party-gutter py-2">
      <div className="min-w-0">
        <h1
          id="mesh-invitation-heading"
          data-mesh-route-heading
          tabIndex={-1}
          className="truncate text-title font-semibold tracking-tight text-primary outline-none"
        >
          {title}
        </h1>
        <p className="truncate text-meta text-muted">{detail}</p>
      </div>
    </header>
  )
}
