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
  const label = protectionLabel(trust)
  const serviceCount = trust.services.length
  const parts = [
    label,
    `${trust.communityMemberCount} ${trust.communityMemberCount === 1 ? 'member' : 'members'}`,
    `${serviceCount} connected ${serviceCount === 1 ? 'service' : 'services'}`,
  ]
  if (!trust.loadingAccountTrust && trust.devicesNeedReview > 0) {
    parts.push(`${trust.devicesNeedReview} ${trust.devicesNeedReview === 1 ? 'device needs' : 'devices need'} review`)
  }

  return (
    <Tooltip
      side="bottom"
      className="max-w-sm p-3 font-normal"
      content={(
        <div className="space-y-2">
          <p className="font-semibold text-primary">Who can read this room?</p>
          <p className="leading-5 text-secondary">
            Access follows the room’s approved participants and devices. The current community
            has {trust.communityMemberCount} {trust.communityMemberCount === 1 ? 'member' : 'members'}
            {' '}across {serviceCount} connected {serviceCount === 1 ? 'service' : 'services'}.
          </p>
          <p className="leading-5 text-muted">
            Connected services route encrypted data; they do not receive readable message contents.
          </p>
        </div>
      )}
    >
      <button
        type="button"
        className={`mesh-trust-summary flex min-h-8 max-w-full items-center gap-1.5 rounded-md px-2 text-caption font-medium transition-colors ${
          trust.protection === 'protected'
            ? 'bg-status-success/10 text-status-success hover:bg-status-success/20'
            : trust.protection === 'blocked'
              ? 'bg-status-warning/10 text-status-warning hover:bg-status-warning/20'
              : 'bg-bg-modifier-hover text-muted hover:bg-bg-modifier-active hover:text-secondary'
        }`}
        aria-label={`${parts.join(', ')}. Open room ledger.`}
        onClick={() => onOpenContext('ledger')}
      >
        <Icon
          name={
            trust.protection === 'protected'
              ? 'lock'
              : trust.protection === 'checking'
                ? 'loader'
                : trust.protection === 'blocked'
                  ? 'triangleAlert'
                  : 'shieldCheck'
          }
          size="xs"
          className={trust.protection === 'checking' ? 'animate-spin' : undefined}
        />
        <span className="truncate">{parts.join(' · ')}</span>
      </button>
    </Tooltip>
  )
}

function protectionLabel(trust: RoomTrustSnapshot) {
  if (trust.protection === 'protected') return 'Encrypted'
  if (trust.protection === 'blocked') return 'Sending blocked'
  if (trust.protection === 'checking') return 'Checking protection'
  return 'Protection unavailable'
}
