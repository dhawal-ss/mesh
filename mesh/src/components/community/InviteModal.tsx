import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import * as bridge from '../../lib/bridge'
import { transitions } from '../../lib/motion'
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
    <div className="space-y-4">
      <section aria-label="Community invite link">
          <div className="mb-3 rounded-control border border-border-subtle bg-surface-sunken px-3 py-2">
            <p className="text-caption font-semibold uppercase tracking-eyebrow text-muted">Destination</p>
            <p className="mt-1 text-sm font-medium text-primary">{communityName}</p>
            <p className="mt-1 text-xs text-muted">
              Joining still requires a review and explicit confirmation. This invitation does not choose an account service.
            </p>
          </div>
          <div className="overflow-hidden rounded-control bg-surface-hover">
            {inviteLinkLoading && !inviteLink ? (
              <div className="flex items-center justify-center px-4 py-4">
                <span className="text-sm text-muted">Preparing private link…</span>
              </div>
            ) : !inviteLink ? (
              <p className="px-4 py-4 text-center text-sm text-muted">
                Create a private link when you are ready to share an invitation.
              </p>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2.5">
                <code className="flex-1 truncate font-mono text-sm text-secondary">
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

          {!inviteLink && (
            <Button
              variant="primary"
              onClick={() => void generateInvite()}
              disabled={inviteLinkLoading || !communityId}
              className="mt-3 w-full"
            >
              Create invite link
            </Button>
          )}

          <Button variant="primary" onClick={handleCopy} disabled={inviteLinkLoading || !inviteLink} className="mt-3 w-full">
            <motion.span
              key={copied ? 'copied' : 'copy'}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={transitions.fast}
            >
              {copied ? (
                <span className="flex items-center justify-center gap-1.5">
                  <Icon name="check" size="xs" />
                  Copied!
                </span>
              ) : (
                'Copy Invite Link'
              )}
            </motion.span>
          </Button>

          <p className="mt-2 text-center text-xs text-muted">
            {parseAdmissionCommunityInvite(inviteLink)
              ? 'One person can use this private link within seven days. They review the destination and choose when to join.'
              : matrixMode
                ? 'This compatible service uses an administrator-approved access request.'
              : 'If this link stops working, create a new one.'}
          </p>
          <p className="mt-2 text-center text-xs text-muted">
            Expiration, use limits, and revocation appear only when the community service confirms support. Revoking an invitation never removes people who already joined.
          </p>
        </section>

        {matrixMode && (
          <section
            aria-label="Invite an existing account"
            className="space-y-3 border-t border-border-subtle pt-4"
          >
            <p className="text-xs font-semibold uppercase tracking-section text-muted">
              Already on Mesh
            </p>
            <Input
              label="Username"
              value={username}
              onChange={(value: string) => {
                setUsername(value)
                setInviteSent(false)
                setDirectInviteError(null)
              }}
              placeholder="ashvin"
              autoFocus
            />
            <Button
              variant="primary"
              onClick={handleMatrixInvite}
              disabled={directInviteLoading || !username.trim()}
              className="w-full"
            >
              {directInviteLoading ? 'Inviting…' : inviteSent ? 'Invite sent' : 'Send invite'}
            </Button>
            {inviteSent && (
              <p className="text-center text-xs text-green">Invite sent.</p>
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
      <section aria-labelledby="community-invitations-heading" className="mx-auto w-full max-w-2xl px-party-gutter py-6">
        <header className="mb-5 border-b border-border-subtle pb-4">
          <h2 id="community-invitations-heading" className="text-section-title font-semibold text-primary">
            Invitations for {communityName}
          </h2>
          <p className="mt-1 text-sm text-secondary">{description}</p>
          <p className="mt-2 text-xs text-muted">
            An invitation points to this community. It never changes where someone keeps their account.
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
    >
      {content}
    </Modal>
  )
}
