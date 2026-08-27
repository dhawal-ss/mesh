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
        : 'Protection details are unavailable.'
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
          className={`flex min-h-8 max-w-48 items-center gap-1.5 rounded-full px-2 text-label-sm font-medium transition-colors ${
            trust.protection === 'unencrypted' || needsReview
                ? 'bg-marker-container text-on-marker-container hover:bg-marker-container-hover'
                : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface-variant'
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
          className={`rounded-xl border px-3 py-2.5 ${
            trust.protection === 'protected'
              ? 'border-primary-container-line bg-primary-container'
              : trust.protection === 'unencrypted'
                ? 'border-marker-container-line bg-marker-container'
                : 'border-outline-variant bg-surface-container-lowest'
          }`}
        >
          <p className="text-body-sm font-medium text-on-surface">{protection}</p>
          <p className="mt-1 text-label-sm text-on-surface-variant">
            Connected services deliver protected messages but cannot read their contents.
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
          className={`min-h-control-md w-full rounded-full px-3 text-body-sm font-semibold transition-colors ${
            needsReview
              ? 'bg-primary text-on-primary hover:bg-primary'
              : 'border border-outline-variant text-on-surface-variant hover:border-outline hover:bg-state-hover hover:text-on-surface'
          }`}
          onClick={() => {
            setNextModalRestoreFocusTarget(triggerRef.current)
            setOpen(false)
            onReviewDevices()
          }}
        >
          Review account access
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
    <div className="flex items-center justify-between gap-3 text-body-sm">
      <dt className="text-on-surface-variant">{label}</dt>
      <dd className={
        tone === 'success'
          ? 'font-medium text-primary'
          : tone === 'warning'
            ? 'font-medium text-marker'
            : 'font-medium text-on-surface-variant'
      }>
        {value}
      </dd>
    </div>
  )
}

function protectionLabel(trust: RoomTrustSnapshot) {
  if (trust.protection === 'protected') return 'Protected'
  if (trust.protection === 'unencrypted') return 'Protection required'
  if (trust.protection === 'checking') return 'Checking protection'
  return 'Protection unavailable'
}
