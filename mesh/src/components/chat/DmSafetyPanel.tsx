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
        : 'Protection details are unavailable.'

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
      className="mesh-secondary-pane flex min-h-0 flex-shrink-0 flex-col overflow-hidden border-l border-outline-variant bg-surface"
      aria-label={`Safety with ${peerName}`}
      tabIndex={-1}
    >
      <div className="mesh-dm-safety-header flex h-conversation-header flex-shrink-0 items-center gap-3 border-b border-outline-variant bg-surface-container px-4">
        <Icon
          name={needsReview || trust.protection !== 'protected' ? 'triangleAlert' : 'shieldCheck'}
          size="sm"
          className={needsReview || trust.protection !== 'protected' ? 'text-marker' : 'text-primary'}
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-body-md font-semibold text-on-surface">Safety</h2>
          <p className="truncate text-label-sm text-on-surface-variant">{peerName}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-10 min-w-10 items-center justify-center rounded-full text-on-surface-variant hover:bg-state-hover hover:text-on-surface"
          aria-label="Close safety"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>

      <div className="mesh-dm-safety-body min-h-0 flex-1 space-y-3 overflow-y-auto">
        <section className="mesh-dm-safety-section border-b border-outline-variant p-4" aria-labelledby="dm-protection-heading">
          <div className={`mesh-dm-safety-status border-l px-3 py-3 ${
            trust.protection === 'protected' && !needsReview
              ? 'border-primary-container-line'
              : 'border-marker-container-line'
          }`}>
            <h3 id="dm-protection-heading" className="text-body-sm font-semibold text-on-surface">
              {trust.protection === 'protected' && !needsReview ? 'Protected conversation' : 'Protection needs attention'}
            </h3>
            <p className="mt-1 text-label-sm text-on-surface-variant">{protectionCopy}</p>
          </div>
          <dl className="mt-3 space-y-2 text-body-sm">
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
            className="mt-3 min-h-9 w-full rounded-full border border-outline-variant px-3 text-body-sm font-semibold text-on-surface-variant hover:border-outline hover:bg-state-hover hover:text-on-surface"
          >
            Review devices and backup
          </button>
        </section>

        <section className="mesh-dm-safety-section border-b border-outline-variant p-4" aria-labelledby="dm-address-heading">
          <h3 id="dm-address-heading" className="text-body-sm font-semibold text-on-surface">Account address</h3>
          {showAddress ? (
            <div className="mt-3 space-y-2">
              <code className="block break-all rounded-full bg-surface-container-lowest px-3 py-2 text-label-sm text-on-surface-variant">
                {accountAddress}
              </code>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyAddress()}
                  className="min-h-9 flex-1 rounded-full border border-outline-variant px-3 text-body-sm font-semibold text-on-surface-variant hover:bg-state-hover hover:text-on-surface"
                  aria-label={`Copy account address for ${peerName}`}
                >
                  Copy address
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddress(false)}
                  className="min-h-9 rounded-full px-3 text-body-sm font-medium text-on-surface-variant hover:bg-state-hover hover:text-on-surface"
                >
                  Hide
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowAddress(true)}
              className="mt-3 min-h-9 rounded-full px-3 text-body-sm font-semibold text-primary hover:bg-state-hover"
            >
              Show account address
            </button>
          )}
        </section>

        <section className="mesh-dm-safety-section border-b border-outline-variant p-4" aria-labelledby="dm-moderation-heading">
          <h3 id="dm-moderation-heading" className="text-body-sm font-semibold text-on-surface">Controls</h3>
          <p className="mt-1 text-label-sm text-on-surface-variant">
            Reports go to your account service.
          </p>
          {latestReportableMessage ? (
            <div className="mt-3 border-l-2 border-outline pl-3">
              <p className="line-clamp-2 text-body-sm text-on-surface-variant">
                {latestReportableMessage.content || 'Shared content'}
              </p>
              <button
                type="button"
                onClick={() => setReportEventId(latestReportableMessage.id)}
                className="mt-1 min-h-8 text-body-sm font-semibold text-primary hover:underline"
              >
                Report latest message
              </button>
            </div>
          ) : (
            <p className="mt-3 text-label-sm text-on-surface-variant">
              Report a message from its menu.
            </p>
          )}
          <button
            type="button"
            onClick={onToggleBlocked}
            disabled={isBlockBusy}
            className="mt-4 min-h-9 w-full rounded-full border border-error-container-line px-3 text-body-sm font-semibold text-on-error-container hover:bg-error-container-hover disabled:opacity-50"
          >
            {isBlockBusy ? 'Saving…' : isBlocked ? `Unblock ${peerName}` : `Block ${peerName}`}
          </button>
          {blockError != null && (
            <p className="mt-2 text-label-sm text-error" role="alert">
              The block setting could not be changed.
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
      <dt className="text-on-surface-variant">{label}</dt>
      <dd className={warning ? 'font-medium text-marker' : 'font-medium text-on-surface-variant'}>
        {value}
      </dd>
    </div>
  )
}
