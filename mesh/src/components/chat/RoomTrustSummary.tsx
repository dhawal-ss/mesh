import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import type { RoomContextTab } from '../community/RoomContextPanel'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'

/**
 * The first of this contract's three federation carriers: one assist chip in
 * the app bar, and no words on any message.
 *
 * It used to count members here and leave encryption to a caption pinned to the
 * bottom of the timeline. The caption is gone: a statement about the room
 * belongs beside the room's name, and the people count is already a click away
 * behind Details, which sits two buttons along.
 */
export function RoomTrustSummary({
  trust,
  encryptionLabel,
  onOpenContext,
}: {
  trust: RoomTrustSnapshot
  /** "Encrypted", or "Encrypted, N servers carry this room". Null while unknown. */
  encryptionLabel: string | null
  onOpenContext: (tab: RoomContextTab) => void
}) {
  const devicesNeedReview = !trust.loadingAccountTrust && trust.devicesNeedReview > 0
  const normalState = trust.protection === 'protected' && !devicesNeedReview

  if (normalState) {
    if (!encryptionLabel) return null
    return (
      <Tooltip content="Check room privacy" side="bottom">
        <button
          type="button"
          className="mesh-trust-summary flex min-h-8 max-w-full items-center gap-1.5 rounded-sm bg-surface-container-high px-2 text-label-sm text-on-surface-variant transition-colors hover:bg-surface-container-highest"
          aria-label={`${encryptionLabel}. Open connection check.`}
          onClick={() => onOpenContext('ledger')}
        >
          <Icon name="shieldCheck" size="sm" />
          <span className="hidden min-w-0 truncate sm:inline">{encryptionLabel}</span>
        </button>
      </Tooltip>
    )
  }

  const label = devicesNeedReview
    ? `${trust.devicesNeedReview} ${trust.devicesNeedReview === 1 ? 'device needs' : 'devices need'} review`
    : protectionLabel(trust)

  return (
    <Tooltip side="bottom" content="Check room privacy">
      <button
        type="button"
        className={`mesh-trust-summary flex min-h-8 max-w-full items-center gap-1.5 rounded-sm px-2 text-label-sm transition-colors ${
          trust.protection === 'unencrypted' || devicesNeedReview
            ? 'bg-marker-container text-on-marker-container hover:bg-marker-container-hover'
            : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface-variant'
        }`}
        aria-label={`${label}. Open connection check.`}
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
          size="sm"
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
