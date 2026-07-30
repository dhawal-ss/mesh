import { useState } from 'react'
import * as bridge from '../../lib/bridge'
import { describeError } from '../../lib/errors'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { showToast } from '../ui/Toast'
import { PUBLIC_SERVICES, type PublicService } from '../../config/public-services'

interface MessageReportDialogProps {
  open: boolean
  roomId: string
  eventId: string
  onClose: () => void
}

export function MessageReportDialog({
  open,
  roomId,
  eventId,
  onClose,
}: MessageReportDialogProps) {
  if (!open) return null
  return (
    <MessageReportDialogContent
      key={`${roomId}:${eventId}`}
      roomId={roomId}
      eventId={eventId}
      onClose={onClose}
    />
  )
}

function MessageReportDialogContent({
  roomId,
  eventId,
  onClose,
}: Omit<MessageReportDialogProps, 'open'>) {
  const [reason, setReason] = useState('Spam or abusive content')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const publicService = currentPublicService()

  const sendReport = async () => {
    const normalizedReason = reason.trim()
    if (!normalizedReason || normalizedReason.length > 500) return
    setBusy(true)
    setError(null)
    try {
      await bridge.reportMessage(eventId, roomId, normalizedReason)
      onClose()
      showToast('Report sent to your account service.', 'success')
    } catch (cause) {
      const description = describeError(cause, { operation: 'send this report' })
      setError(`${description.title}. ${description.body}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose()
      }}
      title="Report message"
    >
      <div className="space-y-4">
        <p className="text-sm leading-6 text-secondary">
          This sends the event identifier and your reason to the operator of your account
          service. The reason is not end-to-end encrypted. It does not automatically notify
          this community's moderators.
        </p>
        {publicService ? (
          <p className="text-sm leading-6 text-secondary">
            For the operator's abuse, safety, or account process,{' '}
            <a
              href={publicService.supportUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline underline-offset-2"
            >
              open {publicService.displayName} support
            </a>
            . Mesh does not operate this service.
          </p>
        ) : (
          <p className="text-sm leading-6 text-secondary">
            For urgent provider action, use the support or abuse route published by your
            account service. Mesh does not operate that service.
          </p>
        )}
        <label className="block text-sm font-medium text-primary">
          Reason
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={4}
            autoFocus
            className="mt-2 w-full resize-y rounded-control border border-border bg-surface-sunken px-3 py-2 text-sm text-primary outline-none focus:border-accent"
          />
        </label>
        <p className="text-caption text-muted">{reason.length}/500 characters</p>
        {error && (
          <p role="alert" className="rounded-control bg-status-danger/10 px-3 py-2 text-xs text-status-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || reason.trim().length === 0}
            onClick={() => void sendReport()}
          >
            {busy ? 'Sending…' : 'Send report'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function currentPublicService(): PublicService | null {
  const homeserver = bridge.getBackendStatusSnapshot()?.homeserver
  const accountDomain = bridge.getMatrixUserId()?.split(':').slice(1).join(':').toLowerCase()
  let homeserverHost: string | null = null
  if (homeserver) {
    try {
      homeserverHost = new URL(homeserver).hostname.toLowerCase()
    } catch {
      homeserverHost = homeserver.toLowerCase()
    }
  }
  return PUBLIC_SERVICES.find((service) =>
    service.accountDomain.toLowerCase() === accountDomain
    || new URL(service.homeserverUrl).hostname.toLowerCase() === homeserverHost
  ) ?? null
}
