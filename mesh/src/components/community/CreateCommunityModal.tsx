import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import * as bridge from '../../lib/bridge'
import { transitions } from '../../lib/motion'

type Tab = 'create' | 'join'

interface CreateCommunityModalProps {
  isOpen: boolean
  onClose: () => void
}

export function CreateCommunityModal({ isOpen, onClose }: CreateCommunityModalProps) {
  const [tab, setTab] = useState<Tab>('create')
  const [isLoading, setIsLoading] = useState(false)

  const [communityName, setCommunityName] = useState('')
  const [communityDescription, setCommunityDescription] = useState('')

  const [inviteLink, setInviteLink] = useState('')
  const [joinError, setJoinError] = useState('')

  const addCommunity = useCommunityStore((s) => s.addCommunity)
  const setActiveCommunity = useCommunityStore((s) => s.setActiveCommunity)
  const setChannels = useChannelStore((s) => s.setChannels)

  const resetForm = () => {
    setCommunityName('')
    setCommunityDescription('')
    setInviteLink('')
    setJoinError('')
    setIsLoading(false)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const handleCreate = async () => {
    if (!communityName.trim()) return
    setIsLoading(true)
    try {
      const community = await bridge.createCommunity(communityName.trim(), communityDescription.trim())
      addCommunity(community)
      setActiveCommunity(community.id)
      const channels = await bridge.getChannels(community.id)
      setChannels(channels)
      handleClose()
    } catch (err) {
      console.error('Failed to create community:', err)
    }
    setIsLoading(false)
  }

  const handleJoin = async () => {
    if (!inviteLink.trim()) return
    setIsLoading(true)
    setJoinError('')
    try {
      const community = await bridge.joinCommunity(inviteLink.trim())
      addCommunity(community)
      setActiveCommunity(community.id)
      const channels = await bridge.getChannels(community.id)
      setChannels(channels)
      handleClose()
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Failed to join community')
      console.error('Failed to join community:', err)
    }
    setIsLoading(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (tab === 'create') handleCreate()
      else handleJoin()
    }
  }

  return (
    <Modal open={isOpen} onClose={handleClose}>
      <div>
        {/* Tab switcher */}
        <div className="mb-5 flex rounded-md bg-bg-tertiary p-1">
          {(['create', 'join'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`relative flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                tab === t ? 'text-primary' : 'text-muted hover:text-secondary'
              }`}
            >
              {tab === t && (
                <motion.div
                  layoutId="tab-indicator"
                  className="absolute inset-0 rounded-md bg-bg-modifier-active"
                  transition={transitions.softSpring}
                />
              )}
              <span className="relative z-10 capitalize">{t === 'create' ? 'Create' : 'Join'}</span>
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {tab === 'create' ? (
            <motion.div
              key="create"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.12 }}
            >
              <h2 className="mb-1 text-base font-semibold text-primary">Create a Server</h2>
              <p className="mb-4 text-xs text-muted">
                Your server is yours — fully decentralized, no central servers required.
              </p>

              <div className="space-y-3">
                <Input
                  label="Server Name"
                  value={communityName}
                  onChange={setCommunityName}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. Design Club"
                  autoFocus
                />
                <div>
                  <label className="mb-1.5 block text-xs font-bold uppercase text-muted">
                    Description
                  </label>
                  <textarea
                    value={communityDescription}
                    onChange={(e) => setCommunityDescription(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="What's this community about?"
                    rows={2}
                    className="w-full resize-none rounded-md bg-bg-tertiary px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none"
                  />
                </div>
              </div>

              <Button
                onClick={handleCreate}
                disabled={!communityName.trim() || isLoading}
                className="mt-4 w-full"
              >
                {isLoading ? 'Creating…' : 'Create Server'}
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="join"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.12 }}
            >
              <h2 className="mb-1 text-base font-semibold text-primary">Join a Server</h2>
              <p className="mb-4 text-xs text-muted">
                Paste an invite link to connect directly to the community mesh.
              </p>

              <Input
                label="Invite Link"
                value={inviteLink}
                onChange={(v: string) => {
                  setInviteLink(v)
                  setJoinError('')
                }}
                onKeyDown={handleKeyDown}
                placeholder="mesh://join?c=..."
                autoFocus
              />

              {joinError && (
                <p className="mt-2 text-xs text-red">{joinError}</p>
              )}

              <Button
                onClick={handleJoin}
                disabled={!inviteLink.trim() || isLoading}
                className="mt-4 w-full"
              >
                {isLoading ? 'Joining…' : 'Join Server'}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Modal>
  )
}
