import { useCallback, useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import * as bridge from '../../lib/bridge'
import { transitions } from '../../lib/motion'
import { Icon } from '../ui/Icon'
import { ErrorState } from '../ui/ErrorState'
import { parseManagedCommunityInvite } from '../../lib/community-invites'

interface InviteModalProps {
  isOpen: boolean
  onClose: () => void
  communityId: string
  communityName: string
}

export function InviteModal({ isOpen, onClose, communityId, communityName }: InviteModalProps) {
  const matrixMode = bridge.isMatrixBackend()
  const [inviteLink, setInviteLink] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [username, setUsername] = useState('')
  const [inviteSent, setInviteSent] = useState(false)
  const [operationError, setOperationError] = useState<unknown | null>(null)

  const generateInvite = useCallback(async () => {
    setIsLoading(true)
    setOperationError(null)
    setInviteLink('')
    try {
      setInviteLink(await bridge.generateInviteLink(communityId))
    } catch (err) {
      console.error('Failed to generate invite link:', err)
      setOperationError(err)
    } finally {
      setIsLoading(false)
    }
  }, [communityId])

  useEffect(() => {
    if (!isOpen || !communityId) return
    const timer = window.setTimeout(() => void generateInvite(), 0)
    return () => window.clearTimeout(timer)
  }, [generateInvite, isOpen, communityId])

  const handleMatrixInvite = async () => {
    if (!username.trim()) return
    setIsLoading(true)
    setInviteSent(false)
    setOperationError(null)
    try {
      await bridge.inviteMatrixUser(communityId, username.trim())
      setInviteSent(true)
      setUsername('')
    } catch (err) {
      setOperationError(err)
      console.error('Failed to invite Matrix user:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = inviteLink
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleClose = () => {
    setCopied(false)
    setInviteLink('')
    setUsername('')
    setInviteSent(false)
    setOperationError(null)
    onClose()
  }

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title={`Invite to ${communityName}`}
      description={
        matrixMode
          ? 'Share a private link, or invite someone who already has an account.'
          : 'Share this link to let others join your community.'
      }
    >
      <div className="space-y-4">
        <section aria-label="Community invite link">
          <div className="overflow-hidden rounded-control bg-surface-hover">
            {isLoading && !inviteLink ? (
              <div className="flex items-center justify-center px-4 py-4">
                <span className="text-sm text-muted animate-pulse-soft">Preparing private link…</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2.5">
                <code className="flex-1 truncate font-mono text-sm text-secondary">
                  {inviteLink}
                </code>
              </div>
            )}
          </div>

          {operationError != null && !inviteLink && (
            <ErrorState
              error={operationError}
              context={{ operation: 'create an invite link', resource: 'community' }}
              onAction={generateInvite}
              className="mt-3"
              compact
            />
          )}

          <Button onClick={handleCopy} disabled={isLoading || !inviteLink} className="mt-3 w-full">
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
            {parseManagedCommunityInvite(inviteLink)
              ? 'One person can use this private link within seven days. They enter automatically after signing in.'
              : matrixMode
                ? 'This compatible service uses an administrator-approved access request.'
              : 'If this link stops working, create a new one.'}
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
                setOperationError(null)
              }}
              placeholder="ashvin"
              autoFocus
            />
            <Button
              onClick={handleMatrixInvite}
              disabled={isLoading || !username.trim()}
              className="w-full"
            >
              {isLoading ? 'Inviting…' : inviteSent ? 'Invite sent' : 'Send invite'}
            </Button>
            {inviteSent && (
              <p className="text-center text-xs text-green">Invite sent.</p>
            )}
            {operationError != null && (
              <ErrorState
                error={operationError}
                context={{ operation: 'invite this person', resource: 'community' }}
                onAction={handleMatrixInvite}
                compact
              />
            )}
          </section>
        )}
      </div>
    </Modal>
  )
}
