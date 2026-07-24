import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import * as bridge from '../../lib/bridge'

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
  const [matrixUserId, setMatrixUserId] = useState('')
  const [inviteSent, setInviteSent] = useState(false)

  useEffect(() => {
    if (!isOpen || !communityId || matrixMode) return
    const generate = async () => {
      setIsLoading(true)
      try {
        const link = await bridge.generateInviteLink(communityId)
        setInviteLink(link)
      } catch (err) {
        console.error('Failed to generate invite link:', err)
        setInviteLink('Failed to generate link')
      }
      setIsLoading(false)
    }
    generate()
  }, [isOpen, communityId, matrixMode])

  const handleMatrixInvite = async () => {
    if (!matrixUserId.trim()) return
    setIsLoading(true)
    setInviteSent(false)
    try {
      await bridge.inviteMatrixUser(communityId, matrixUserId.trim())
      setInviteSent(true)
      setMatrixUserId('')
    } catch (err) {
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
    setMatrixUserId('')
    setInviteSent(false)
    onClose()
  }

  return (
    <Modal open={isOpen} onClose={handleClose}>
      <div>
        <h2 className="mb-1 text-base font-semibold text-primary">Invite to {communityName}</h2>
        <p className="mb-4 text-xs text-muted">
          {matrixMode
            ? 'Invite a Matrix user to the Space and each current channel.'
            : 'Share this link to let others join your community mesh.'}
        </p>

        {matrixMode ? (
          <div className="space-y-3">
            <Input
              label="Matrix user ID"
              value={matrixUserId}
              onChange={(value: string) => {
                setMatrixUserId(value)
                setInviteSent(false)
              }}
              placeholder="@person:example.org"
              autoFocus
            />
            <Button
              onClick={handleMatrixInvite}
              disabled={isLoading || !matrixUserId.trim()}
              className="w-full"
            >
              {isLoading ? 'Inviting…' : inviteSent ? 'Invite sent' : 'Invite User'}
            </Button>
            {inviteSent && (
              <p className="text-center text-xs text-green">Invitation sent to the Space and channels.</p>
            )}
          </div>
        ) : (
          <>
          <div className="overflow-hidden rounded-md bg-bg-tertiary">
          {isLoading ? (
            <div className="flex items-center justify-center px-4 py-4">
              <span className="text-sm text-muted animate-pulse-soft">Generating link...</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2.5">
              <code className="flex-1 truncate font-mono text-sm text-secondary">
                {inviteLink}
              </code>
            </div>
          )}
        </div>

        <Button onClick={handleCopy} disabled={isLoading || !inviteLink} className="mt-4 w-full">
          <motion.span
            key={copied ? 'copied' : 'copy'}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.1 }}
          >
            {copied ? (
              <span className="flex items-center justify-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Copied!
              </span>
            ) : (
              'Copy Invite Link'
            )}
          </motion.span>
        </Button>

        <p className="mt-3 text-center text-xs text-muted">
          Regenerate this invite if the community key or bootstrap hints change.
        </p>
          </>
        )}
      </div>
    </Modal>
  )
}
