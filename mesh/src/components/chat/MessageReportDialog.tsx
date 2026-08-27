import { useState } from 'react'
import * as bridge from '../../lib/bridge'
import { describeError, errorLine } from '../../lib/errors'
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
      setError(errorLine(description))
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
        <p className="text-body-md text-on-surface-variant">
          Your reason and a message reference go to your account service, not to community
          moderators.
        </p>
        {publicService ? (
          <p className="text-body-md text-on-surface-variant">
            For account or safety help,{' '}
            <a
              href={publicService.supportUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              open {publicService.displayName} support
            </a>
            . Mesh does not operate this service.
          </p>
        ) : (
          <p className="text-body-md text-on-surface-variant">
            For account or safety help, use the support link from your account service. Mesh
            does not operate that service.
          </p>
        )}
        <label className="block text-body-md font-medium text-on-surface">
          Reason
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={4}
            autoFocus
            className="mt-2 w-full resize-y rounded-full border border-outline bg-surface-container-lowest px-3 py-2 text-body-md text-on-surface outline-none focus:border-primary"
          />
        </label>
        <p className="text-label-sm text-on-surface-variant">{reason.length}/500 characters</p>
        {error && (
          <p role="alert" className="rounded-full bg-error-container px-3 py-2 text-body-sm text-error">
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
