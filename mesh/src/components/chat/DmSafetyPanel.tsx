import { useMemo, useState } from 'react'

import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import { copyText } from '../../lib/notifications'
import type { Message } from '../../types/ipc'
import { Icon } from '../ui/Icon'
import { showToast } from '../ui/Toast'
import { MessageReportDialog } from './MessageReportDialog'

interface DmSafetyPanelProps {
  conversationId: string
  peerName: string
  accountAddress: string
  trust: RoomTrustSnapshot
  reportMessages: Message[]
  isBlocked: boolean
  isBlockBusy: boolean
  blockError: unknown | null
  onReviewDevices: (trigger: HTMLButtonElement) => void
  onToggleBlocked: () => void
  onClose: () => void
}

export function DmSafetyPanel({
  conversationId,
  peerName,
  accountAddress,
  trust,
  reportMessages,
  isBlocked,
  isBlockBusy,
  blockError,
  onReviewDevices,
  onToggleBlocked,
  onClose,
}: DmSafetyPanelProps) {
  const [showAddress, setShowAddress] = useState(false)
  const [reportEventId, setReportEventId] = useState<string | null>(null)
  const latestReportableMessage = useMemo(
    () => reportMessages.find((message) => message.id.startsWith('$')) ?? null,
    [reportMessages],
  )
  const needsReview = !trust.loadingAccountTrust && trust.devicesNeedReview > 0
  const protectionCopy = trust.protection === 'protected'
    ? `Only you, ${peerName}, and approved devices can read these messages.`
    : trust.protection === 'checking'
      ? 'Mesh is checking which devices can safely read these messages.'
      : trust.protection === 'unencrypted'
        ? 'Sending is paused until this conversation is protected again.'
        : 'Protection details are unavailable. Mesh will keep its safety checks active.'

  const handleCopyAddress = async () => {
    try {
      await copyText(accountAddress)
      showToast('Account address copied.', 'success')
    } catch {
      showToast('Account address could not be copied.', 'error')
    }
  }

  return (
    <aside
      id="mesh-dm-safety-panel"
      className="mesh-secondary-pane flex min-h-0 flex-shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-surface-sidebar"
      aria-label={`Safety with ${peerName}`}
      tabIndex={-1}
    >
      <div className="flex h-conversation-header flex-shrink-0 items-center gap-3 border-b border-border-subtle px-4">
        <Icon
          name={needsReview || trust.protection !== 'protected' ? 'triangleAlert' : 'shieldCheck'}
          size="sm"
          className={needsReview || trust.protection !== 'protected' ? 'text-status-warning' : 'text-status-success'}
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-primary">Safety</h2>
          <p className="truncate text-caption text-muted">{peerName}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-10 min-w-10 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-primary"
          aria-label="Close Safety"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-border-subtle p-4" aria-labelledby="dm-protection-heading">
          <div className={`rounded-panel border px-3 py-3 ${
            trust.protection === 'protected' && !needsReview
              ? 'border-status-success/30 bg-status-success/10'
              : 'border-status-warning/30 bg-status-warning/10'
          }`}>
            <h3 id="dm-protection-heading" className="text-xs font-semibold text-primary">
              {trust.protection === 'protected' && !needsReview ? 'Protected conversation' : 'Protection needs attention'}
            </h3>
            <p className="mt-1 text-caption leading-5 text-muted">{protectionCopy}</p>
          </div>
          <dl className="mt-3 space-y-2 text-xs">
            <SafetyRow label="Approved devices" value={trust.loadingAccountTrust ? 'Checking…' : String(trust.verifiedDevices)} />
            <SafetyRow
              label="Need review"
              value={trust.loadingAccountTrust ? 'Checking…' : String(trust.devicesNeedReview)}
              warning={needsReview}
            />
            <SafetyRow
              label="Message backup"
              value={trust.loadingAccountTrust ? 'Checking…' : trust.backup?.healthy ? 'Ready' : trust.backup ? 'Needs attention' : 'Unavailable'}
              warning={Boolean(trust.backup && !trust.backup.healthy)}
            />
          </dl>
          <button
            type="button"
            onClick={(event) => onReviewDevices(event.currentTarget)}
            className="mt-3 min-h-9 w-full rounded-control border border-border-subtle px-3 text-xs font-semibold text-secondary hover:border-border-strong hover:bg-surface-hover hover:text-primary"
          >
            Review devices and backup
          </button>
        </section>

        <section className="border-b border-border-subtle p-4" aria-labelledby="dm-address-heading">
          <h3 id="dm-address-heading" className="text-xs font-semibold text-primary">Account address</h3>
          <p className="mt-1 text-caption leading-5 text-muted">
            Reveal this only when you need to confirm the exact account with someone.
          </p>
          {showAddress ? (
            <div className="mt-3 space-y-2">
              <code className="block break-all rounded-control bg-surface-sunken px-3 py-2 text-caption text-secondary">
                {accountAddress}
              </code>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyAddress()}
                  className="min-h-9 flex-1 rounded-control border border-border-subtle px-3 text-xs font-semibold text-secondary hover:bg-surface-hover hover:text-primary"
                  aria-label={`Copy account address for ${peerName}`}
                >
                  Copy address
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddress(false)}
                  className="min-h-9 rounded-control px-3 text-xs font-medium text-muted hover:bg-surface-hover hover:text-primary"
                >
                  Hide
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowAddress(true)}
              className="mt-3 min-h-9 rounded-control px-3 text-xs font-semibold text-text-link hover:bg-surface-hover"
            >
              Show account address
            </button>
          )}
        </section>

        <section className="p-4" aria-labelledby="dm-moderation-heading">
          <h3 id="dm-moderation-heading" className="text-xs font-semibold text-primary">Controls</h3>
          <p className="mt-1 text-caption leading-5 text-muted">
            Reports are attached to a specific message and go to your account service.
          </p>
          {latestReportableMessage ? (
            <div className="mt-3 border-l-2 border-border-strong pl-3">
              <p className="line-clamp-2 text-xs leading-5 text-secondary">
                {latestReportableMessage.content || 'Shared content'}
              </p>
              <button
                type="button"
                onClick={() => setReportEventId(latestReportableMessage.id)}
                className="mt-1 min-h-8 text-xs font-semibold text-text-link hover:underline"
              >
                Report latest message
              </button>
            </div>
          ) : (
            <p className="mt-3 text-caption leading-5 text-muted">
              Use a received message menu when there is a message you want to report.
            </p>
          )}
          <button
            type="button"
            onClick={onToggleBlocked}
            disabled={isBlockBusy}
            className="mt-4 min-h-9 w-full rounded-control border border-status-danger/30 px-3 text-xs font-semibold text-status-danger hover:bg-status-danger/10 disabled:opacity-50"
          >
            {isBlockBusy ? 'Saving…' : isBlocked ? `Unblock ${peerName}` : `Block ${peerName}`}
          </button>
          {blockError != null && (
            <p className="mt-2 text-caption leading-5 text-status-danger" role="alert">
              The block setting could not be changed. Try again.
            </p>
          )}
        </section>
      </div>

      <MessageReportDialog
        open={reportEventId != null}
        roomId={conversationId}
        eventId={reportEventId ?? ''}
        onClose={() => setReportEventId(null)}
      />
    </aside>
  )
}

function SafetyRow({
  label,
  value,
  warning = false,
}: {
  label: string
  value: string
  warning?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={warning ? 'font-medium text-status-warning' : 'font-medium text-secondary'}>
        {value}
      </dd>
    </div>
  )
}
