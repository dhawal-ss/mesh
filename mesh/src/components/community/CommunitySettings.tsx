import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { InviteModal } from './InviteModal'
import { useActiveCommunity, useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { useMembershipStore } from '../../store/membership'
import * as bridge from '../../lib/bridge'
import { transitions } from '../../lib/motion'
import { canStartMatrixVoice } from '../../lib/voice-runtime'
import type { CommunityApplication } from '../../types/ipc'
import { Icon } from '../ui/Icon'

interface CommunitySettingsProps {
  isOpen: boolean
  onClose: () => void
}

export function CommunitySettings({ isOpen, onClose }: CommunitySettingsProps) {
  const matrixMode = bridge.isMatrixBackend()
  const matrixVoiceReady = canStartMatrixVoice(bridge.getBackendStatusSnapshot())
  const communityOrder = useCommunityStore((state) => state.communityOrder)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const removeCommunity = useCommunityStore((state) => state.removeCommunity)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const patchCommunity = useCommunityStore((state) => state.patchCommunity)
  const addChannel = useChannelStore((state) => state.addChannel)
  const clearCommunityMembership = useMembershipStore((s) => s.clearCommunity)

  const community = useActiveCommunity()

  const [showInvite, setShowInvite] = useState(false)
  const [showCreateChannel, setShowCreateChannel] = useState(false)
  const [channelName, setChannelName] = useState('')
  const [channelType, setChannelType] = useState<'text' | 'voice'>('text')
  const [isCreatingChannel, setIsCreatingChannel] = useState(false)
  const [communityName, setCommunityName] = useState('')
  const [communityDescription, setCommunityDescription] = useState('')
  const [isSavingMetadata, setIsSavingMetadata] = useState(false)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const [communityAlias, setCommunityAlias] = useState('')
  const [isDiscoverable, setIsDiscoverable] = useState(false)
  const [isSavingAccess, setIsSavingAccess] = useState(false)
  const [accessError, setAccessError] = useState<unknown | null>(null)
  const [applications, setApplications] = useState<CommunityApplication[]>([])

  useEffect(() => {
    if (!community) return
    setCommunityName(community.name)
    setCommunityDescription(community.description)
  }, [community])

  useEffect(() => {
    if (!isOpen || !matrixMode || !community || !activeCommunityId) return
    if (community.role !== 'owner' && community.role !== 'admin') return

    let cancelled = false
    Promise.all([
      bridge.getCommunityAccessSettings(activeCommunityId),
      bridge.getCommunityApplications(activeCommunityId),
    ])
      .then(([settings, pending]) => {
        if (cancelled) return
        setCommunityAlias(settings.alias ?? '')
        setIsDiscoverable(settings.discoverable)
        setApplications(pending)
        setAccessError(null)
      })
      .catch((error) => {
        if (!cancelled) {
          setAccessError(error)
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeCommunityId, community, isOpen, matrixMode])

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
      const remaining = communityOrder.filter((id) => id !== activeCommunityId)
      setActiveCommunity(remaining[0] ?? null)
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
      const remaining = communityOrder.filter((id) => id !== activeCommunityId)
      setActiveCommunity(remaining[0] ?? null)
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
      patchCommunity(activeCommunityId, {
        name: communityName.trim(),
        description: communityDescription.trim(),
      })
    } catch (err) {
      console.error('Failed to update community metadata:', err)
    }
    setIsSavingMetadata(false)
  }

  const handleSaveAccess = async () => {
    setIsSavingAccess(true)
    setAccessError(null)
    try {
      const settings = await bridge.updateCommunityAccess(
        activeCommunityId,
        communityAlias,
        isDiscoverable,
      )
      setCommunityAlias(settings.alias ?? '')
      setIsDiscoverable(settings.discoverable)
    } catch (error) {
      setAccessError(error)
    }
    setIsSavingAccess(false)
  }

  const handleApplication = async (application: CommunityApplication, accept: boolean) => {
    setAccessError(null)
    try {
      await bridge.respondToCommunityApplication(
        activeCommunityId,
        application.userId,
        accept,
        accept ? undefined : 'Server application declined',
      )
      setApplications((current) => current.filter((entry) => entry.userId !== application.userId))
    } catch (error) {
      setAccessError(error)
    }
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
              className="fixed inset-0 z-overlay bg-scrim"
              onClick={onClose}
            />

            {/* Panel slides in from right */}
            <motion.div
              initial={{ x: '100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              transition={transitions.enter}
              className="fixed right-0 top-0 z-drawer flex h-full w-settings-drawer flex-col bg-bg-secondary shadow-overlay"
            >
              {/* Header */}
              <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-border-subtle px-5">
                <h2 className="text-base font-semibold text-primary">Server Settings</h2>
                <button
                  onClick={onClose}
                  aria-label="Close server settings"
                  className="flex h-8 w-8 items-center justify-center rounded text-muted transition-colors hover:bg-bg-modifier-hover hover:text-secondary"
                >
                  <Icon name="x" size="sm" />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto px-5 py-5">
                {/* Community info card */}
                <div className="mb-6 rounded-lg bg-bg-primary p-4">
                  <div className="mb-3 flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-status-info text-lg font-semibold text-content-on-status">
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
                      <Icon name="userPlus" size="sm" />
                      Invite People
                    </span>
                  </Button>
                </div>

                {isOwnerOrAdmin && (
                  <div className="mb-6">
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Overview</h3>
                    <div className="space-y-3 rounded-lg bg-bg-primary p-4">
                      <Input
                        label="Server Name"
                        value={communityName}
                        onChange={setCommunityName}
                        placeholder="Server name"
                      />
                      <div>
                        <label className="mb-1.5 block text-xs font-semibold uppercase text-muted">
                          Description
                        </label>
                        <textarea
                          value={communityDescription}
                          onChange={(e) => setCommunityDescription(e.target.value)}
                          rows={3}
                          className="w-full resize-none rounded-md bg-bg-tertiary px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none"
                          placeholder="What is this server about?"
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

                {matrixMode && isOwnerOrAdmin && (
                  <div className="mb-6">
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Access & Discovery</h3>
                    <div className="space-y-3 rounded-lg bg-bg-primary p-4">
                      <Input
                        label="Public link"
                        value={communityAlias}
                        onChange={setCommunityAlias}
                        placeholder="design-club"
                      />
                      <p className="text-xs text-muted">
                        Choose a short name people can use to find this server.
                      </p>
                      <label className="flex cursor-pointer items-start gap-3 rounded-md bg-bg-tertiary p-3">
                        <input
                          type="checkbox"
                          checked={isDiscoverable}
                          onChange={(event) => setIsDiscoverable(event.target.checked)}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="block text-sm font-medium text-primary">List this server publicly</span>
                          <span className="block text-xs text-muted">
                            New members need approval to join.
                          </span>
                        </span>
                      </label>
                      {accessError != null && (
                        <ErrorState
                          error={accessError}
                          context={{ operation: 'update server access settings', resource: 'server' }}
                          compact
                        />
                      )}
                      <Button
                        onClick={handleSaveAccess}
                        disabled={isSavingAccess || (isDiscoverable && !communityAlias.trim())}
                        className="w-full"
                      >
                        {isSavingAccess ? 'Saving…' : 'Save Access Settings'}
                      </Button>
                    </div>

                    {applications.length > 0 && (
                      <div className="mt-3 space-y-2 rounded-lg bg-bg-primary p-4">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                          Applications ({applications.length})
                        </h4>
                        {applications.map((application) => (
                          <div key={application.userId} className="rounded-md bg-bg-tertiary p-3">
                            <p className="text-sm font-medium text-primary">{application.displayName}</p>
                            <p className="text-xs text-text-link">{application.userId}</p>
                            {application.reason && (
                              <p className="mt-1 text-xs text-secondary">{application.reason}</p>
                            )}
                            <div className="mt-3 flex gap-2">
                              <Button
                                onClick={() => handleApplication(application, true)}
                                className="flex-1"
                              >
                                Approve
                              </Button>
                              <Button
                                onClick={() => handleApplication(application, false)}
                                variant="secondary"
                                className="flex-1"
                              >
                                Decline
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Create channel */}
                {isOwnerOrAdmin && (
                  <div className="mb-6">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Channels</h3>
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
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={transitions.enter}
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
                              <label className="mb-1.5 block text-xs font-semibold uppercase text-muted">
                                Channel Type
                              </label>
                              <div className="flex gap-2">
                                {(!matrixMode || matrixVoiceReady
                                  ? (['text', 'voice'] as const)
                                  : (['text'] as const)
                                ).map((t) => (
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
                              {matrixMode && !matrixVoiceReady && (
                                <p className="mt-2 text-xs text-muted">
                                  Voice channels appear after private calling passes its service checks.
                                </p>
                              )}
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
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red">Danger Zone</h3>
                  {!showLeaveConfirm ? (
                    <button
                      onClick={() => setShowLeaveConfirm(true)}
                      className="w-full rounded-md border border-red/30 px-4 py-2.5 text-left text-sm text-red transition-colors hover:bg-red/10"
                    >
                      {matrixMode ? 'Leave Server' : isOwner ? 'Delete Server' : 'Leave Server'}
                    </button>
                  ) : (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="space-y-3 rounded-lg border border-red/30 bg-red/5 p-4"
                    >
                      <p className="text-sm text-secondary">
                        {!matrixMode && isOwner ? (
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
                          onClick={matrixMode ? handleLeave : isOwner ? handleDelete : handleLeave}
                          className="flex-1 rounded-md bg-status-danger px-4 py-2 text-sm font-medium text-content-on-status transition-opacity hover:opacity-90"
                        >
                          {!matrixMode && isOwner ? 'Delete' : 'Leave'}
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
