import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from '../../lib/lazy-motion'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import * as bridge from '../../lib/bridge'
import { motionOffsets, transitions } from '../../lib/motion'
import { Icon } from '../ui/Icon'
import { ErrorState } from '../ui/ErrorState'
import { parseAdmissionCommunityInvite } from '../../lib/community-invites'

interface InviteModalProps {
  isOpen: boolean
  onClose: () => void
  communityId: string
  communityName: string
  embedded?: boolean
}

export function InviteModal({
  isOpen,
  onClose,
  communityId,
  communityName,
  embedded = false,
}: InviteModalProps) {
  const matrixMode = bridge.isMatrixBackend()
  const [inviteLink, setInviteLink] = useState('')
  const [inviteLinkLoading, setInviteLinkLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [username, setUsername] = useState('')
  const [inviteSent, setInviteSent] = useState(false)
  const [directInviteLoading, setDirectInviteLoading] = useState(false)
  const [inviteLinkError, setInviteLinkError] = useState<unknown | null>(null)
  const [directInviteError, setDirectInviteError] = useState<unknown | null>(null)
  const copiedResetTimer = useRef<number | null>(null)
  const inviteLinkRequest = useRef(0)
  const directInviteRequest = useRef(0)

  const clearTransientState = useCallback(() => {
    inviteLinkRequest.current += 1
    directInviteRequest.current += 1
    if (copiedResetTimer.current !== null) {
      window.clearTimeout(copiedResetTimer.current)
      copiedResetTimer.current = null
    }
    setCopied(false)
    setInviteLink('')
    setUsername('')
    setInviteSent(false)
    setInviteLinkLoading(false)
    setDirectInviteLoading(false)
    setInviteLinkError(null)
    setDirectInviteError(null)
  }, [])

  const generateInvite = useCallback(async () => {
    const request = inviteLinkRequest.current + 1
    inviteLinkRequest.current = request
    setInviteLinkLoading(true)
    setInviteLinkError(null)
    setInviteLink('')
    try {
      const link = await bridge.generateInviteLink(communityId)
      if (inviteLinkRequest.current === request) setInviteLink(link)
    } catch (err) {
      console.error('Failed to generate invite link:', err)
      if (inviteLinkRequest.current === request) setInviteLinkError(err)
    } finally {
      if (inviteLinkRequest.current === request) setInviteLinkLoading(false)
    }
  }, [communityId])

  useEffect(() => {
    return () => {
      inviteLinkRequest.current += 1
      directInviteRequest.current += 1
      if (copiedResetTimer.current !== null) window.clearTimeout(copiedResetTimer.current)
    }
  }, [])

  const handleMatrixInvite = async () => {
    const submittedUsername = username.trim()
    if (!submittedUsername) return
    const request = directInviteRequest.current + 1
    directInviteRequest.current = request
    setDirectInviteLoading(true)
    setInviteSent(false)
    setDirectInviteError(null)
    try {
      await bridge.inviteMatrixUser(communityId, submittedUsername)
      if (directInviteRequest.current !== request) return
      setInviteSent(true)
      setUsername((current) => current.trim() === submittedUsername ? '' : current)
    } catch (err) {
      console.error('Failed to invite Matrix user:', err)
      if (directInviteRequest.current === request) setDirectInviteError(err)
    } finally {
      if (directInviteRequest.current === request) setDirectInviteLoading(false)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = inviteLink
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    setCopied(true)
    if (copiedResetTimer.current !== null) {
      window.clearTimeout(copiedResetTimer.current)
    }
    copiedResetTimer.current = window.setTimeout(() => {
      setCopied(false)
      copiedResetTimer.current = null
    }, 2000)
  }

  const handleClose = () => {
    clearTransientState()
    onClose()
  }

  const description = matrixMode
    ? 'Share a private link, or invite someone who already has an account.'
    : 'Share this link to let others join your community.'

  const content = (
    <div className={matrixMode ? 'mesh-invite-grid grid gap-3 md:grid-cols-2' : 'mesh-invite-grid space-y-3'}>
      <section
        aria-label="Community invite link"
        className="mesh-invite-section border-y border-outline-variant"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-primary-container text-primary">
            <Icon name="userPlus" size="sm" />
          </span>
          <div className="min-w-0">
            <h3 className="text-body-md font-semibold text-on-surface">Share a private invitation</h3>
          </div>
        </div>

        <div className="mesh-invite-destination mt-4 border-y border-outline-variant px-3 py-2">
          <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">Destination</p>
          <p className="mt-1 truncate text-body-md font-medium text-on-surface">{communityName}</p>
          <p className="mt-1 text-body-sm text-on-surface-variant">
            Never moves or replaces their account.
          </p>
        </div>

        <div
          className="mesh-invite-link mt-3 overflow-hidden border-y border-outline-variant"
          aria-live="polite"
        >
          {inviteLinkLoading && !inviteLink ? (
            <div className="flex items-center justify-center px-4 py-4">
              <span className="text-body-md text-on-surface-variant">Preparing private link…</span>
            </div>
          ) : !inviteLink ? (
            <p className="px-4 py-4 text-center text-body-md text-on-surface-variant">
              Create a link only when you are ready to share it.
            </p>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2.5">
              <code className="flex-1 truncate text-body-md text-on-surface-variant">
                {inviteLink}
              </code>
            </div>
          )}
        </div>

        {inviteLinkError != null && !inviteLink && (
          <ErrorState
            error={inviteLinkError}
            context={{ operation: 'create an invite link', resource: 'community' }}
            onAction={generateInvite}
            className="mt-3"
            compact
          />
        )}

        {!inviteLink && inviteLinkError == null ? (
          <Button
            variant="primary"
            onClick={() => void generateInvite()}
            disabled={inviteLinkLoading || !communityId}
            className="mt-3 w-full"
          >
            {inviteLinkLoading ? 'Creating invitation…' : 'Create invite link'}
          </Button>
        ) : inviteLink ? (
          <Button
            variant="primary"
            onClick={handleCopy}
            disabled={inviteLinkLoading}
            className="mt-3 w-full"
          >
            <motion.span
              key={copied ? 'copied' : 'copy'}
              initial={{ opacity: 0, y: motionOffsets.tight }}
              animate={{ opacity: 1, y: 0 }}
              transition={transitions.fast}
            >
              {copied ? (
                <span className="flex items-center justify-center gap-1.5">
                  <Icon name="check" size="xs" />
                  Copied!
                </span>
              ) : (
                'Copy invite link'
              )}
            </motion.span>
          </Button>
        ) : null}

        <div className="mesh-invite-guidance mt-3 flex items-start gap-2 py-2">
          <Icon name="shieldCheck" size="xs" className="mt-0.5 flex-shrink-0 text-primary" />
          <div className="space-y-1 text-body-sm text-on-surface-variant">
            <p>
              {parseAdmissionCommunityInvite(inviteLink)
                ? 'One person can use this private link within seven days.'
                : matrixMode
                  ? 'This service uses an administrator-approved access request.'
                  : 'If this link stops working, create a new one.'}
            </p>
            <p>
              Revoking a link never removes people who already joined.
            </p>
          </div>
        </div>
      </section>

      {matrixMode && (
        <section
          aria-label="Invite an existing account"
          className="mesh-invite-section space-y-3 rounded-xl border border-outline-variant bg-surface-container p-4"
        >
          <div>
            <h3 className="text-body-md font-semibold text-on-surface">Already on Mesh</h3>
          </div>
          <Input
            label="Mesh username or account address"
            value={username}
            onChange={(value: string) => {
              setUsername(value)
              setInviteSent(false)
              setDirectInviteError(null)
            }}
            placeholder="ashvin or @ashvin:service.example"
            hint="A short username uses your account service."
          />
          <Button
            variant="secondary"
            onClick={handleMatrixInvite}
            disabled={directInviteLoading || !username.trim()}
            className="w-full"
          >
            {directInviteLoading ? 'Inviting…' : inviteSent ? 'Invite sent' : 'Send invite'}
          </Button>
          {inviteSent && (
            <p className="text-center text-body-sm text-primary">Invite sent.</p>
          )}
          {directInviteError != null && (
            <ErrorState
              error={directInviteError}
              context={{ operation: 'invite this person', resource: 'community' }}
              onAction={handleMatrixInvite}
              compact
            />
          )}
        </section>
      )}
    </div>
  )

  if (embedded) {
    if (!isOpen) return null
    return (
      <section aria-labelledby="community-invitations-heading" className="mx-auto w-full max-w-2xl px-shell-gutter py-6">
        <header className="mb-5 border-b border-outline-variant pb-4">
          <h2 id="community-invitations-heading" className="text-title-sm font-semibold text-on-surface">
            Invitations for {communityName}
          </h2>
          <p className="mt-1 text-body-md text-on-surface-variant">{description}</p>
          <p className="mt-2 text-body-sm text-on-surface-variant">
            An invitation never changes where someone keeps their account.
          </p>
        </header>
        {content}
      </section>
    )
  }

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title={`Invite to ${communityName}`}
      description={description}
      size={matrixMode ? 'lg' : 'md'}
    >
      {content}
    </Modal>
  )
}
