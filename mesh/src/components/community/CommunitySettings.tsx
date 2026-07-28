import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { Sheet, Switch } from '../ui/InteractivePrimitives'
import { Field, Textarea } from '../ui/Primitives'
import { IconButton } from '../ui/IconButton'
import { InviteModal } from './InviteModal'
import { useActiveCommunity, useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { useMembershipStore } from '../../store/membership'
import * as bridge from '../../lib/bridge'
import { transitions } from '../../lib/motion'
import { canStartMatrixVoice } from '../../lib/voice-runtime'
import type { CommunityApplication, ModerationAuditEntry } from '../../types/ipc'
import { Icon } from '../ui/Icon'
import {
  useServerEmoji,
  useServerEmojiStore,
} from '../../store/custom-emoji'

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
  const [moderationAudit, setModerationAudit] = useState<ModerationAuditEntry[]>([])
  const [moderationAuditError, setModerationAuditError] = useState<unknown | null>(null)
  const [emojiShortcode, setEmojiShortcode] = useState('')
  const [emojiFile, setEmojiFile] = useState<File | null>(null)
  const [emojiBusy, setEmojiBusy] = useState<string | null>(null)
  const [emojiError, setEmojiError] = useState<unknown | null>(null)
  const emojiFileInputRef = useRef<HTMLInputElement>(null)
  const serverEmoji = useServerEmoji(activeCommunityId)
  const refreshServerEmoji = useServerEmojiStore((state) => state.load)

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

  useEffect(() => {
    if (!isOpen || !matrixMode || !community || !activeCommunityId) return
    if (community.role !== 'owner' && community.role !== 'admin') return

    let cancelled = false
    bridge.getModerationAudit(activeCommunityId)
      .then((entries) => {
        if (cancelled) return
        setModerationAudit(entries)
        setModerationAuditError(null)
      })
      .catch((error) => {
        if (!cancelled) setModerationAuditError(error)
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
        accept ? undefined : 'Community application declined',
      )
      setApplications((current) => current.filter((entry) => entry.userId !== application.userId))
    } catch (error) {
      setAccessError(error)
    }
  }

  const handleEmojiUpload = async () => {
    if (!emojiFile || !emojiShortcode.trim()) return
    setEmojiBusy('upload')
    setEmojiError(null)
    try {
      await bridge.uploadServerEmoji(activeCommunityId, emojiShortcode, emojiFile)
      await bridge.matrixSyncOnce()
      await refreshServerEmoji(activeCommunityId, true)
      setEmojiShortcode('')
      setEmojiFile(null)
      if (emojiFileInputRef.current) emojiFileInputRef.current.value = ''
    } catch (error) {
      setEmojiError(error)
    } finally {
      setEmojiBusy(null)
    }
  }

  const handleEmojiRemove = async (shortcode: string) => {
    setEmojiBusy(shortcode)
    setEmojiError(null)
    try {
      await bridge.removeServerEmoji(activeCommunityId, shortcode)
      await bridge.matrixSyncOnce()
      await refreshServerEmoji(activeCommunityId, true)
    } catch (error) {
      setEmojiError(error)
    } finally {
      setEmojiBusy(null)
    }
  }

  return (
    <>
      <Sheet
        open={isOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose()
        }}
        title="Community settings"
        description={`Manage ${community.name}, its rooms, and who can find it.`}
        size="lg"
        closeLabel="Close community settings"
      >
        <div className="flex min-h-full flex-col">
          {/* Community info card */}
          <div className="mb-6 rounded-lg border border-border-subtle bg-surface-sunken p-4">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-lg font-semibold text-accent-content">
                {community.name[0]?.toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-semibold text-primary">{community.name}</h3>
                <p className="member-count text-xs text-muted">
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
              <div className="space-y-3 rounded-lg border border-border-subtle bg-surface-sunken p-4">
                <Input
                  label="Community Name"
                  value={communityName}
                  onChange={setCommunityName}
                  placeholder="Community name"
                />
                <Field label="Description" htmlFor="community-description">
                  <Textarea
                    id="community-description"
                    value={communityDescription}
                    onChange={(e) => setCommunityDescription(e.target.value)}
                    rows={3}
                    className="min-h-20 resize-none"
                    placeholder="What is this community about?"
                  />
                </Field>
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
              <div className="space-y-3 rounded-lg border border-border-subtle bg-surface-sunken p-4">
                <Input
                  label="Public link"
                  value={communityAlias}
                  onChange={setCommunityAlias}
                  placeholder="design-club"
                />
                <p className="text-xs text-muted">
                  Choose a short name people can use to find this community.
                </p>
                <Switch
                  checked={isDiscoverable}
                  onCheckedChange={setIsDiscoverable}
                  label="List this community publicly"
                  description="New members need approval to join."
                  className="rounded-md bg-surface-hover p-3"
                />
                {accessError != null && (
                  <ErrorState
                    error={accessError}
                    context={{ operation: 'update community access settings', resource: 'community' }}
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
                <div className="mt-3 space-y-2 rounded-lg border border-border-subtle bg-surface-sunken p-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Applications ({applications.length})
                  </h4>
                  {applications.map((application) => (
                    <div key={application.userId} className="rounded-md bg-surface-hover p-3">
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

          {matrixMode && isOwnerOrAdmin && (
            <div className="mb-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Custom Emoji
              </h3>
              <div className="space-y-3 rounded-lg border border-border-subtle bg-surface-sunken p-4">
                <p className="text-xs text-muted">
                  Emoji images and names are shared community settings. They are not protected
                  like message text.
                </p>
                <Input
                  label="Emoji name"
                  value={emojiShortcode}
                  onChange={setEmojiShortcode}
                  placeholder="party_parrot"
                />
                <label className="block text-xs font-semibold uppercase text-muted">
                  Image
                  <input
                    ref={emojiFileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => setEmojiFile(event.target.files?.[0] ?? null)}
                    className="mt-1.5 block min-h-control-md w-full cursor-pointer rounded-md border border-border bg-surface-hover px-3 py-2 text-sm font-normal normal-case text-secondary file:mr-3 file:rounded file:border-0 file:bg-surface-active file:px-3 file:py-1 file:text-xs file:font-semibold file:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </label>
                <p className="text-xs text-muted">
                  PNG, JPEG, or WebP · up to 512 KB. Images are resized for emoji use.
                </p>
                {emojiError != null && (
                  <ErrorState
                    error={emojiError}
                    context={{ operation: 'update custom emoji', resource: 'community' }}
                    compact
                  />
                )}
                <Button
                  onClick={handleEmojiUpload}
                  disabled={
                    !emojiShortcode.trim()
                    || !emojiFile
                    || emojiBusy != null
                  }
                  className="w-full"
                >
                  {emojiBusy === 'upload' ? 'Adding…' : 'Add Emoji'}
                </Button>

                {serverEmoji.length > 0 && (
                  <div className="space-y-1 border-t border-border-subtle pt-3">
                    {serverEmoji.map((emoji) => (
                      <div
                        key={emoji.shortcode}
                        className="flex min-h-control-md items-center gap-3 rounded-md px-2 hover:bg-bg-modifier-hover"
                      >
                        <img
                          src={emoji.imageUrl}
                          alt={`:${emoji.shortcode}:`}
                          className="h-7 w-7 flex-none object-contain"
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-sm text-secondary">
                          :{emoji.shortcode}:
                        </span>
                        <IconButton
                          onClick={() => void handleEmojiRemove(emoji.shortcode)}
                          disabled={emojiBusy != null}
                          aria-label={`Remove ${emoji.shortcode} emoji`}
                          tone="danger"
                        >
                          <Icon name="x" size="sm" />
                        </IconButton>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {matrixMode && isOwnerOrAdmin && (
            <div className="mb-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Moderation Activity
              </h3>
              <div className="space-y-3 rounded-lg border border-border-subtle bg-surface-sunken p-4">
                <p className="text-xs text-muted">
                  A protected record of administrator actions across this community.
                </p>
                {moderationAuditError != null && (
                  <ErrorState
                    error={moderationAuditError}
                    context={{ operation: 'load moderation activity', resource: 'community' }}
                    compact
                  />
                )}
                {moderationAuditError == null && moderationAudit.length === 0 && (
                  <p className="rounded-md bg-surface-hover px-3 py-4 text-center text-xs text-muted">
                    No moderation actions recorded.
                  </p>
                )}
                {moderationAudit.map((entry) => {
                  const failures = entry.roomOutcomes.filter((outcome) => !outcome.succeeded)
                  const succeeded = entry.roomOutcomes.length - failures.length
                  return (
                    <article key={entry.id} className="rounded-md bg-surface-hover p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-primary">
                            {entry.action}: {entry.targetDisplayName}
                          </p>
                          <p className="mt-0.5 text-xs text-muted">
                            By {entry.actorDisplayName}
                          </p>
                        </div>
                        <time
                          dateTime={entry.occurredAt}
                          className="flex-none text-caption text-muted"
                        >
                          {new Date(entry.occurredAt).toLocaleString()}
                        </time>
                      </div>
                      {entry.reason && (
                        <p className="mt-2 text-xs text-secondary">
                          Reason: {entry.reason}
                        </p>
                      )}
                      <p className={`mt-2 text-xs ${
                        failures.length === 0 ? 'text-status-success' : 'text-status-warning'
                      }`}>
                        {failures.length === 0
                          ? `Completed in all ${entry.roomOutcomes.length} places`
                          : `Completed in ${succeeded} of ${entry.roomOutcomes.length} places`}
                      </p>
                      {failures.length > 0 && (
                        <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted">
                          {failures.map((outcome) => (
                            <li key={outcome.roomId}>
                              {outcome.roomName}: {outcome.failureReason}
                            </li>
                          ))}
                        </ul>
                      )}
                    </article>
                  )
                })}
              </div>
            </div>
          )}

          {/* Create channel */}
          {isOwnerOrAdmin && (
            <div className="mb-6">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Rooms</h3>
                <Button
                  onClick={() => setShowCreateChannel(!showCreateChannel)}
                  variant="ghost"
                  tone="accent"
                  size="sm"
                  className="min-h-8"
                  aria-expanded={showCreateChannel}
                >
                  {!showCreateChannel && <Icon name="plus" size="xs" />}
                  {showCreateChannel ? 'Cancel' : 'Create room'}
                </Button>
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
                    <div className="space-y-3 rounded-lg border border-border-subtle bg-surface-sunken p-4">
                      <Input
                        label="Room Name"
                        value={channelName}
                        onChange={setChannelName}
                        placeholder="e.g. announcements"
                        autoFocus
                      />

                      <div>
                        <label className="mb-1.5 block text-xs font-semibold uppercase text-muted">
                          Room Type
                        </label>
                        <div className="flex gap-2">
                          {(!matrixMode || matrixVoiceReady
                            ? (['text', 'voice'] as const)
                            : (['text'] as const)
                          ).map((t) => (
                            <Button
                              key={t}
                              onClick={() => setChannelType(t)}
                              variant={channelType === t ? 'soft' : 'outline'}
                              tone={channelType === t ? 'accent' : 'neutral'}
                              className="min-h-10 flex-1"
                              aria-pressed={channelType === t}
                            >
                              <Icon name={t === 'text' ? 'hash' : 'volume'} size="sm" />
                              {t === 'text' ? 'Text' : 'Voice'}
                            </Button>
                          ))}
                        </div>
                        {matrixMode && !matrixVoiceReady && (
                          <p className="mt-2 text-xs text-muted">
                            Voice rooms appear after private calling passes its service checks.
                          </p>
                        )}
                      </div>

                      <Button
                        onClick={handleCreateChannel}
                        disabled={!channelName.trim() || isCreatingChannel}
                        className="w-full"
                      >
                        {isCreatingChannel ? 'Creating…' : 'Create Room'}
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Danger zone */}
          <div className="mt-auto border-t border-border pt-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-status-danger">Danger zone</h3>
            {!showLeaveConfirm ? (
              <Button
                onClick={() => setShowLeaveConfirm(true)}
                variant="outline"
                tone="danger"
                className="w-full justify-start"
              >
                {matrixMode ? 'Leave Community' : isOwner ? 'Delete Community' : 'Leave Community'}
              </Button>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-3 rounded-lg border border-status-danger/30 bg-status-danger/5 p-4"
              >
                <p className="text-sm text-secondary">
                  {!matrixMode && isOwner ? (
                    <>
                      Delete <strong className="text-primary">{community.name}</strong>? This will close the community for all members.
                    </>
                  ) : (
                    <>
                      Leave <strong className="text-primary">{community.name}</strong>? You'll lose access to all rooms.
                    </>
                  )}
                </p>
                <div className="flex gap-2">
                  <Button onClick={() => setShowLeaveConfirm(false)} variant="secondary" className="flex-1">
                    Cancel
                  </Button>
                  <Button
                    onClick={matrixMode ? handleLeave : isOwner ? handleDelete : handleLeave}
                    tone="danger"
                    className="flex-1"
                  >
                    {!matrixMode && isOwner ? 'Delete' : 'Leave'}
                  </Button>
                </div>
              </motion.div>
            )}
          </div>
        </div>
      </Sheet>

      <InviteModal
        isOpen={showInvite}
        onClose={() => setShowInvite(false)}
        communityId={activeCommunityId}
        communityName={community.name}
      />
    </>
  )
}
