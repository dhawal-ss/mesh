import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { InviteModal } from './InviteModal'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { useMembershipStore } from '../../store/membership'
import * as bridge from '../../lib/bridge'
import { transitions } from '../../lib/motion'

interface CommunitySettingsProps {
  isOpen: boolean
  onClose: () => void
}

export function CommunitySettings({ isOpen, onClose }: CommunitySettingsProps) {
  const { communities, activeCommunityId, removeCommunity, setActiveCommunity } = useCommunityStore()
  const { addChannel } = useChannelStore()
  const clearCommunityMembership = useMembershipStore((s) => s.clearCommunity)

  const community = communities.find((c) => c.id === activeCommunityId)

  const [showInvite, setShowInvite] = useState(false)
  const [showCreateChannel, setShowCreateChannel] = useState(false)
  const [channelName, setChannelName] = useState('')
  const [channelType, setChannelType] = useState<'text' | 'voice'>('text')
  const [isCreatingChannel, setIsCreatingChannel] = useState(false)
  const [communityName, setCommunityName] = useState('')
  const [communityDescription, setCommunityDescription] = useState('')
  const [isSavingMetadata, setIsSavingMetadata] = useState(false)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)

  useEffect(() => {
    if (!community) return
    setCommunityName(community.name)
    setCommunityDescription(community.description)
  }, [community])

  if (!community || !activeCommunityId) return null

  const isOwner = community.role === 'owner'
  const isOwnerOrAdmin = community.role === 'owner' || community.role === 'admin'

  const handleCreateChannel = async () => {
    if (!channelName.trim()) return
    setIsCreatingChannel(true)
    try {
      const channel = await bridge.createChannel(activeCommunityId, channelName.trim(), channelType)
      addChannel(channel)
      setChannelName('')
      setShowCreateChannel(false)
    } catch (err) {
      console.error('Failed to create channel:', err)
    }
    setIsCreatingChannel(false)
  }

  const handleLeave = async () => {
    try {
      await bridge.leaveCommunity(activeCommunityId)
      clearCommunityMembership(activeCommunityId)
      removeCommunity(activeCommunityId)
      const remaining = communities.filter((c) => c.id !== activeCommunityId)
      setActiveCommunity(remaining.length > 0 ? remaining[0].id : null)
      onClose()
    } catch (err) {
      console.error('Failed to leave community:', err)
    }
  }

  const handleDelete = async () => {
    try {
      await bridge.deleteCommunity(activeCommunityId)
      clearCommunityMembership(activeCommunityId)
      removeCommunity(activeCommunityId)
      const remaining = communities.filter((c) => c.id !== activeCommunityId)
      setActiveCommunity(remaining.length > 0 ? remaining[0].id : null)
      onClose()
    } catch (err) {
      console.error('Failed to delete community:', err)
    }
  }

  const handleSaveMetadata = async () => {
    if (!communityName.trim()) return
    setIsSavingMetadata(true)
    try {
      await bridge.updateCommunityMetadata(
        activeCommunityId,
        communityName.trim(),
        communityDescription.trim(),
      )
    } catch (err) {
      console.error('Failed to update community metadata:', err)
    }
    setIsSavingMetadata(false)
  }

  return (
    <>
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/60"
              onClick={onClose}
            />

            {/* Panel slides in from right */}
            <motion.div
              initial={{ x: '100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              transition={transitions.panelSpring}
              className="fixed right-0 top-0 z-50 flex h-full w-[420px] flex-col bg-bg-secondary shadow-floating"
            >
              {/* Header */}
              <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-black/30 px-5">
                <h2 className="text-base font-semibold text-primary">Server Settings</h2>
                <button
                  onClick={onClose}
                  className="flex h-8 w-8 items-center justify-center rounded text-muted transition-colors hover:bg-bg-modifier-hover hover:text-secondary"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto px-5 py-5">
                {/* Community info card */}
                <div className="mb-6 rounded-lg bg-bg-primary p-4">
                  <div className="mb-3 flex items-center gap-3">
                    <div
                      className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-semibold text-white"
                      style={{ backgroundColor: '#5865f2' }}
                    >
                      {community.name[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-sm font-semibold text-primary">{community.name}</h3>
                      <p className="text-xs text-muted">
                        {community.role} · {community.memberCount} member{community.memberCount !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  {community.description && (
                    <p className="text-sm text-secondary">{community.description}</p>
                  )}
                </div>

                {/* Invite */}
                <div className="mb-4">
                  <Button onClick={() => setShowInvite(true)} className="w-full" variant="secondary">
                    <span className="flex items-center gap-2">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <line x1="19" y1="8" x2="19" y2="14" />
                        <line x1="22" y1="11" x2="16" y2="11" />
                      </svg>
                      Invite People
                    </span>
                  </Button>
                </div>

                {isOwnerOrAdmin && (
                  <div className="mb-6">
                    <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Overview</h3>
                    <div className="space-y-3 rounded-lg bg-bg-primary p-4">
                      <Input
                        label="Server Name"
                        value={communityName}
                        onChange={setCommunityName}
                        placeholder="Community name"
                      />
                      <div>
                        <label className="mb-1.5 block text-xs font-bold uppercase text-muted">
                          Description
                        </label>
                        <textarea
                          value={communityDescription}
                          onChange={(e) => setCommunityDescription(e.target.value)}
                          rows={3}
                          className="w-full resize-none rounded-md bg-bg-tertiary px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none"
                          placeholder="What is this community about?"
                        />
                      </div>
                      <Button
                        onClick={handleSaveMetadata}
                        disabled={!communityName.trim() || isSavingMetadata}
                        className="w-full"
                      >
                        {isSavingMetadata ? 'Saving…' : 'Save Changes'}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Create channel */}
                {isOwnerOrAdmin && (
                  <div className="mb-6">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Channels</h3>
                      <button
                        onClick={() => setShowCreateChannel(!showCreateChannel)}
                        className="text-xs text-text-link transition-colors hover:underline"
                      >
                        {showCreateChannel ? 'Cancel' : '+ Create Channel'}
                      </button>
                    </div>

                    <AnimatePresence>
                      {showCreateChannel && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          className="overflow-hidden"
                        >
                          <div className="space-y-3 rounded-lg bg-bg-primary p-4">
                            <Input
                              label="Channel Name"
                              value={channelName}
                              onChange={setChannelName}
                              placeholder="e.g. announcements"
                              autoFocus
                            />

                            <div>
                              <label className="mb-1.5 block text-xs font-bold uppercase text-muted">
                                Channel Type
                              </label>
                              <div className="flex gap-2">
                                {(['text', 'voice'] as const).map((t) => (
                                  <button
                                    key={t}
                                    onClick={() => setChannelType(t)}
                                    className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                                      channelType === t
                                        ? 'border-blue bg-blue/10 text-primary'
                                        : 'border-border text-muted hover:border-border-light hover:text-secondary'
                                    }`}
                                  >
                                    {t === 'text' ? '# Text' : '🔊 Voice'}
                                  </button>
                                ))}
                              </div>
                            </div>

                            <Button
                              onClick={handleCreateChannel}
                              disabled={!channelName.trim() || isCreatingChannel}
                              className="w-full"
                            >
                              {isCreatingChannel ? 'Creating…' : 'Create Channel'}
                            </Button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                {/* Danger zone */}
                <div className="mt-auto border-t border-border pt-5">
                  <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-red">Danger Zone</h3>
                  {!showLeaveConfirm ? (
                    <button
                      onClick={() => setShowLeaveConfirm(true)}
                      className="w-full rounded-md border border-red/30 px-4 py-2.5 text-left text-sm text-red transition-colors hover:bg-red/10"
                    >
                      {isOwner ? 'Delete Server' : 'Leave Server'}
                    </button>
                  ) : (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="space-y-3 rounded-lg border border-red/30 bg-red/5 p-4"
                    >
                      <p className="text-sm text-secondary">
                        {isOwner ? (
                          <>
                            Delete <strong className="text-primary">{community.name}</strong>? This will shut down the server for all members.
                          </>
                        ) : (
                          <>
                            Leave <strong className="text-primary">{community.name}</strong>? You'll lose access to all channels.
                          </>
                        )}
                      </p>
                      <div className="flex gap-2">
                        <Button onClick={() => setShowLeaveConfirm(false)} variant="secondary" className="flex-1">
                          Cancel
                        </Button>
                        <button
                          onClick={isOwner ? handleDelete : handleLeave}
                          className="flex-1 rounded-md bg-red px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                        >
                          {isOwner ? 'Delete' : 'Leave'}
                        </button>
                      </div>
                    </motion.div>
                  )}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <InviteModal
        isOpen={showInvite}
        onClose={() => setShowInvite(false)}
        communityId={activeCommunityId}
        communityName={community.name}
      />
    </>
  )
}
