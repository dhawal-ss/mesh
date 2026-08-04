import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import type { RoomContextTab } from '../community/RoomContextPanel'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'

export function RoomTrustSummary({
  trust,
  onOpenContext,
}: {
  trust: RoomTrustSnapshot
  onOpenContext: (tab: RoomContextTab) => void
}) {
  const memberLabel = `${trust.communityMemberCount} ${trust.communityMemberCount === 1 ? 'member' : 'members'}`
  const devicesNeedReview = !trust.loadingAccountTrust && trust.devicesNeedReview > 0
  const normalState = trust.protection === 'protected' && !devicesNeedReview

  if (normalState) {
    return (
      <Tooltip content="People in this community" side="bottom">
        <button
          type="button"
          className="mesh-trust-summary flex min-h-8 max-w-full items-center gap-1.5 rounded-control px-2 text-caption font-medium text-muted transition-colors hover:bg-surface-hover hover:text-secondary"
          aria-label={`${memberLabel}. Open people in room details.`}
          onClick={() => onOpenContext('people')}
        >
          <Icon name="users" size="xs" />
          <span className="hidden min-w-0 truncate sm:inline">{memberLabel}</span>
        </button>
      </Tooltip>
    )
  }

  const label = devicesNeedReview
    ? `${trust.devicesNeedReview} ${trust.devicesNeedReview === 1 ? 'device needs' : 'devices need'} review`
    : protectionLabel(trust)

  return (
    <Tooltip
      side="bottom"
      className="max-w-sm p-3 font-normal"
      content={(
        <div className="space-y-2">
          <p className="font-semibold text-primary">Check room privacy</p>
          <p className="leading-5 text-secondary">Open Signal Check for details and next steps.</p>
        </div>
      )}
    >
      <button
        type="button"
        className={`mesh-trust-summary flex min-h-8 max-w-full items-center gap-1.5 rounded-control px-2 text-caption font-medium transition-colors ${
          trust.protection === 'unencrypted' || devicesNeedReview
            ? 'bg-status-warning/10 text-status-warning hover:bg-status-warning/20'
            : 'bg-surface-hover text-muted hover:bg-surface-active hover:text-secondary'
        }`}
        aria-label={`${label}. Open Signal Check.`}
        onClick={() => onOpenContext('ledger')}
      >
        <Icon
          name={
            trust.protection === 'checking'
              ? 'loader'
              : trust.protection === 'unencrypted' || devicesNeedReview
                ? 'triangleAlert'
                : 'shieldCheck'
          }
          size="xs"
          className={trust.protection === 'checking' ? 'animate-spin' : undefined}
        />
        <span className="hidden min-w-0 truncate sm:inline">{label}</span>
      </button>
    </Tooltip>
  )
}

function protectionLabel(trust: RoomTrustSnapshot) {
  if (trust.protection === 'unencrypted') return 'Messages are not private'
  if (trust.protection === 'checking') return 'Checking privacy'
  return 'Privacy status unavailable'
}
