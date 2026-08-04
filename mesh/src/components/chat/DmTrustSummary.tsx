import { useRef, useState } from 'react'
import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/InteractivePrimitives'
import { setNextModalRestoreFocusTarget } from '../ui/Modal'

export function DmTrustSummary({
  trust,
  peerName,
  onReviewDevices,
}: {
  trust: RoomTrustSnapshot
  peerName: string
  onReviewDevices: () => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const protection = protectionLabel(trust)
  const needsReview = !trust.loadingAccountTrust && trust.devicesNeedReview > 0
  const triggerLabel = needsReview
    || trust.protection === 'unencrypted'
    || trust.protection === 'unavailable'
      ? 'Needs attention'
      : trust.protection === 'checking'
        ? 'Checking'
        : 'Safety'
  const description = trust.protection === 'protected'
    ? `Only you, ${peerName}, and approved devices can read these messages.`
    : trust.protection === 'unencrypted'
      ? 'Sending is paused until this conversation is protected again.'
      : trust.protection === 'checking'
        ? 'Mesh is checking which devices can safely read these messages.'
        : 'Protection details are unavailable right now. Mesh will keep enforcing its safety checks.'
  const backupLabel = trust.loadingAccountTrust
    ? 'Checking…'
    : trust.backup?.healthy
      ? 'Ready'
      : trust.backup
        ? 'Needs attention'
        : 'Unavailable'

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label="Who can read this conversation?"
      description={description}
      className="mesh-dm-trust-popover"
      trigger={(
        <button
          ref={triggerRef}
          type="button"
          className={`flex min-h-8 max-w-48 items-center gap-1.5 rounded-control px-2 text-caption font-medium transition-colors ${
            trust.protection === 'unencrypted' || needsReview
                ? 'bg-status-warning/10 text-status-warning hover:bg-status-warning/20'
                : 'bg-surface-hover text-muted hover:bg-surface-active hover:text-secondary'
          }`}
          aria-label={`${triggerLabel}. Open conversation safety details.`}
        >
          <Icon
            name={
              trust.protection === 'protected'
                ? 'users'
                : trust.protection === 'checking'
                  ? 'loader'
                  : 'triangleAlert'
            }
            size="xs"
            className={trust.protection === 'checking' ? 'animate-spin' : undefined}
          />
          <span className="truncate">{triggerLabel}</span>
        </button>
      )}
    >
      <div className="space-y-4">
        <div
          className={`rounded-panel border px-3 py-2.5 ${
            trust.protection === 'protected'
              ? 'border-status-success/30 bg-status-success/10'
              : trust.protection === 'unencrypted'
                ? 'border-status-warning/30 bg-status-warning/10'
                : 'border-border-subtle bg-surface-sunken'
          }`}
        >
          <p className="text-xs font-medium text-primary">{protection}</p>
          <p className="mt-1 text-caption leading-5 text-muted">
            Connected services route encrypted data and do not receive readable message contents.
          </p>
        </div>

        <dl className="space-y-2">
          <TrustRow label="Participants" value="2" />
          <TrustRow label="Connected services" value={String(trust.services.length)} />
          <TrustRow
            label="Approved devices"
            value={trust.loadingAccountTrust ? 'Checking…' : String(trust.verifiedDevices)}
            tone="success"
          />
          <TrustRow
            label="Need review"
            value={trust.loadingAccountTrust ? 'Checking…' : String(trust.devicesNeedReview)}
            tone={needsReview ? 'warning' : 'muted'}
          />
          <TrustRow
            label="Message backup"
            value={backupLabel}
            tone={
              trust.backup?.healthy
                ? 'success'
                : trust.backup && !trust.loadingAccountTrust
                  ? 'warning'
                  : 'muted'
            }
          />
        </dl>

        <button
          type="button"
          className={`min-h-control-md w-full rounded-control px-3 text-xs font-semibold transition-colors ${
            needsReview
              ? 'bg-accent text-content-on-accent hover:bg-accent-hover'
              : 'border border-border-subtle text-secondary hover:border-border-strong hover:bg-surface-hover hover:text-primary'
          }`}
          onClick={() => {
            setNextModalRestoreFocusTarget(triggerRef.current)
            setOpen(false)
            onReviewDevices()
          }}
        >
          Review devices and backup
        </button>
      </div>
    </Popover>
  )
}

function TrustRow({
  label,
  value,
  tone = 'muted',
}: {
  label: string
  value: string
  tone?: 'muted' | 'success' | 'warning'
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <dt className="text-muted">{label}</dt>
      <dd className={
        tone === 'success'
          ? 'font-medium text-status-success'
          : tone === 'warning'
            ? 'font-medium text-status-warning'
            : 'font-medium text-secondary'
      }>
        {value}
      </dd>
    </div>
  )
}

function protectionLabel(trust: RoomTrustSnapshot) {
  if (trust.protection === 'protected') return 'Encrypted'
  if (trust.protection === 'unencrypted') return 'Not encrypted'
  if (trust.protection === 'checking') return 'Checking protection'
  return 'Protection unavailable'
}
