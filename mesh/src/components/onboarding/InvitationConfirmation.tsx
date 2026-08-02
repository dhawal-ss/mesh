import type { PendingInvitationMetadata } from '../../types/ipc'
import { describeJoinRule, joinRuleRequiresApproval } from '../../lib/community-access'
import { displayServiceAddress } from './matrixSignIn'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { ErrorState } from '../ui/ErrorState'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'

interface InvitationConfirmationProps {
  pending: PendingInvitationMetadata
  confirming?: boolean
  confirmationError?: unknown
  onConfirm: () => void
  onDiscard: () => void
}

function invitationCommunityName(pending: PendingInvitationMetadata): string {
  return pending.communityName?.trim()
    || 'Invited community'
}

function invitationServiceName(pending: PendingInvitationMetadata): string | null {
  const explicitName = pending.communityServiceDisplayName?.trim()
  if (explicitName) return explicitName

  const address = pending.service?.trim()
  return address ? displayServiceAddress(address) : null
}

export function InvitationConfirmation({
  pending,
  confirming = false,
  confirmationError = null,
  onConfirm,
  onDiscard,
}: InvitationConfirmationProps) {
  const communityName = invitationCommunityName(pending)
  const inviterName = pending.inviterDisplayName?.trim()
  const inviterId = pending.inviterUserId?.trim()
  const joinRule = pending.joinRule
  const requiresApproval = joinRuleRequiresApproval(joinRule)
  const serviceName = invitationServiceName(pending)

  return (
    <Modal
      open
      onClose={onDiscard}
      title="Review community invitation"
      description="Check where this invitation leads before Mesh takes any action."
      closeLabel="Discard invitation"
    >
      <div className="mt-5 space-y-5">
        <div className="flex items-center gap-3 rounded-panel border border-border-subtle bg-surface-sunken p-4">
          <Avatar color="var(--avatar-blue)" size={52} name={communityName} />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-primary">{communityName}</p>
            <p className="mt-1 text-sm text-secondary">
              {inviterName
                ? `Invited by ${inviterName}`
                : inviterId
                  ? `Invited by ${inviterId}`
                  : 'Inviter information is not available for this invitation.'}
            </p>
          </div>
        </div>

        <dl className="grid gap-3 text-sm">
            <div className="rounded-panel bg-surface-hover p-3">
              <dt className="font-medium text-primary">What happens next</dt>
              <dd className="mt-1 text-secondary">
                {requiresApproval
                  ? 'Requires administrator approval. Mesh will send a request after you confirm.'
                  : joinRule
                    ? `${describeJoinRule(joinRule)}. Mesh will open the community after you confirm.`
                    : 'Mesh will check access after you confirm. If approval is required, you will see that before anything else happens.'}
              </dd>
            </div>
            <div className="rounded-panel bg-surface-hover p-3">
              <dt className="font-medium text-primary">Service suggested by this invitation</dt>
              <dd className="mt-1 text-secondary">
                {serviceName ?? 'No account service is suggested.'}
              </dd>
            </div>
        </dl>

        <p className="text-sm leading-6 text-secondary">
          Your account service and this community are separate. You can keep your current
          account service, or use another compatible service when signing in.
        </p>

        {confirmationError ? (
          <ErrorState
            error={confirmationError}
            context={{ operation: 'open this invitation', resource: 'community' }}
          />
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onDiscard} disabled={confirming}>
            Discard invitation
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={confirming}
          >
            {confirming ? <Spinner size={16} /> : null}
            {requiresApproval ? 'Request to join' : 'Confirm and continue'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
