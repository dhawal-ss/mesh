import { useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Modal } from '../ui/Modal'
import { SectionHeader } from '../ui/Primitives'
import {
  BETA_CALLING_KNOWN_ISSUE,
  BETA_KNOWN_ISSUES,
  createBetaFeedbackDraft,
  MAX_BETA_FEEDBACK_LENGTH,
  MESH_APP_VERSION,
  MESH_DOWNLOAD_URL,
  MESH_PRIVACY_URL,
  type BetaFeedbackContext,
  type BetaFeedbackKind,
} from '../../lib/beta-release'

const linkClass = 'inline-flex min-h-10 items-center rounded-full px-3 text-body-md font-semibold text-primary underline underline-offset-2 hover:bg-primary-container-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus'

export function BetaInfoPanel({
  onOpenFeedback,
  callingAvailable = false,
}: {
  onOpenFeedback?: () => void
  /** Fails closed: a build that cannot open a call must not warn about calling. */
  callingAvailable?: boolean
}) {
  return (
    <section className="mesh-beta-info space-y-4" aria-labelledby="beta-settings-heading">
      <div className="mesh-beta-info-section border-y border-outline-variant p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id="beta-settings-heading" className="text-title-sm font-semibold text-on-surface">Mesh beta</h3>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Version {MESH_APP_VERSION}
            </p>
          </div>
          <span className="mesh-beta-badge rounded-full bg-primary-container px-2.5 py-1 text-label-sm font-semibold text-primary">
            Beta
          </span>
        </div>
        <Button className="mt-4" size="sm" variant="primary" onClick={onOpenFeedback} disabled={!onOpenFeedback}>
          <Icon name="messageCircle" size="sm" />
          Send feedback
        </Button>
      </div>

      <div className="mesh-beta-info-section border-y border-outline-variant p-4">
        <SectionHeader title="Known issues" headingLevel={4} />
        <ul className="mt-3 space-y-2 text-body-sm text-on-surface-variant">
          {BETA_KNOWN_ISSUES
            .filter((issue) => callingAvailable || issue !== BETA_CALLING_KNOWN_ISSUE)
            .map((issue) => (
              <li key={issue} className="flex gap-2">
                <Icon name="triangleAlert" size="xs" className="mt-0.5 flex-none text-marker" />
                <span>{issue}</span>
              </li>
            ))}
        </ul>
      </div>

      <div className="mesh-beta-info-section border-y border-outline-variant p-4">
        <SectionHeader title="Updates" headingLevel={4} />
        {/*
          Mesh cannot check for a newer version: the renderer CSP allows no
          outbound connection, and no version manifest is published to compare
          against. Rather than imply a check happens, name the installed version
          next to the page that lists the current one so the comparison is at
          least possible by hand.
        */}
        <p className="mt-1 text-body-sm text-on-surface-variant">
          Mesh does not update itself during this beta. Compare version {MESH_APP_VERSION} with the download page, then install the newer signed version over this one.
        </p>
        <a href={MESH_DOWNLOAD_URL} target="_blank" rel="noreferrer noopener" className={`${linkClass} mt-2`}>
          Open download page
        </a>
      </div>

      <div className="mesh-beta-info-section border-y border-outline-variant p-4">
        <SectionHeader title="Your privacy" headingLevel={4} />
        {/*
          Kept as a data-location disclosure: where your data sits, and what
          Mesh never sends on its own. Three sentences became one.
        */}
        <p className="mt-1 text-body-sm text-on-surface-variant">
          Your session, settings, and message cache stay on this device, your account service carries account and conversation data, and Mesh uploads nothing unless you choose to share it.
        </p>
        <a href={MESH_PRIVACY_URL} target="_blank" rel="noreferrer noopener" className={`${linkClass} mt-2`}>
          Read privacy notice
        </a>
      </div>
    </section>
  )
}

export function BetaFeedbackDialog({
  open,
  onClose,
  context,
}: {
  open: boolean
  onClose: () => void
  context: BetaFeedbackContext
}) {
  const [kind, setKind] = useState<BetaFeedbackKind>('bug')
  const [details, setDetails] = useState('')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const capturedAt = useMemo(() => new Date(), [])
  const draft = createBetaFeedbackDraft({ kind, details, context, capturedAt })
  const canShare = details.trim().length > 0

  const copyFeedback = async () => {
    if (!canShare || !navigator.clipboard?.writeText) {
      setCopyStatus('failed')
      return
    }
    try {
      await navigator.clipboard.writeText(draft.report)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send beta feedback"
      size="lg"
    >
      <div className="mesh-feedback-form space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-body-sm font-medium text-on-surface">
            Feedback type
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as BetaFeedbackKind)}
              className="min-h-10 w-full rounded-full border border-outline bg-surface px-3 text-body-md text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              <option value="bug">Something went wrong</option>
              <option value="confusing">Something was confusing</option>
              <option value="idea">I have an idea</option>
            </select>
          </label>
          <div className="mesh-feedback-context border-y border-outline-variant px-3 py-2 text-body-sm text-on-surface-variant" aria-label="Automatically included app context">
            <span className="block font-semibold text-on-surface">Included automatically</span>
            Mesh {MESH_APP_VERSION}, {context.platform}, {context.area.toLowerCase()}, {context.callActive ? 'call active' : 'no active call'}
          </div>
        </div>

        <label className="block space-y-1 text-body-sm font-medium text-on-surface">
          What happened or what should change?
          <textarea
            value={details}
            onChange={(event) => {
              setDetails(event.target.value.slice(0, MAX_BETA_FEEDBACK_LENGTH))
              setCopyStatus('idle')
            }}
            maxLength={MAX_BETA_FEEDBACK_LENGTH}
            rows={7}
            autoFocus
            placeholder="Describe what you expected and what you saw."
            className="mesh-feedback-field w-full resize-y rounded-full border border-outline bg-surface px-3 py-2 text-body-md text-on-surface placeholder:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          />
          <span className="block text-right text-label-sm text-on-surface-variant">{details.length} of {MAX_BETA_FEEDBACK_LENGTH}</span>
        </label>

        <div className="mesh-feedback-privacy border-y border-outline-variant px-3 py-2 text-body-sm text-on-surface-variant">
          Mesh adds no account address, room name, message content, invitation, file path, or recovery information. The form opens on GitHub and is public, so review your text first.
        </div>

        <div className="mesh-feedback-actions flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" onClick={() => void copyFeedback()} disabled={!canShare}>
            Copy feedback
          </Button>
          <a
            href={canShare ? draft.issueUrl : undefined}
            target="_blank"
            rel="noreferrer noopener"
            aria-disabled={!canShare || undefined}
            onClick={(event) => {
              if (!canShare) event.preventDefault()
            }}
            className={`mesh-button no-select inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-transparent bg-primary px-4 py-2 text-body-md font-semibold text-on-primary transition-colors hover:bg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${canShare ? '' : 'pointer-events-none opacity-40'}`}
          >
            Open feedback form
          </a>
        </div>
        <p role="status" className="mesh-feedback-status min-h-5 text-right text-body-sm text-on-surface-variant">
          {copyStatus === 'copied' ? 'Feedback copied.' : null}
          {copyStatus === 'failed' ? 'Copying failed. Select your text and copy it manually.' : null}
        </p>
      </div>
    </Modal>
  )
}
