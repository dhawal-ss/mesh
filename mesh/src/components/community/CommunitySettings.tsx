import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { Sheet, Switch } from '../ui/InteractivePrimitives'
import { Field, Textarea } from '../ui/Primitives'
import { IconButton } from '../ui/IconButton'
import { InviteModal } from './InviteModal'
import { MemberList } from './MemberList'
import { useActiveCommunity, useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { useCommunityMembers, useMembershipStore } from '../../store/membership'
import * as bridge from '../../lib/bridge'
import { transitions } from '../../lib/motion'
import { canStartMatrixVoice } from '../../lib/voice-runtime'
import type { CommunityApplication, ModerationAuditEntry } from '../../types/ipc'
import { Icon } from '../ui/Icon'
import { Avatar } from '../ui/Avatar'
import { pixelColorForSeed } from '../ui/PixelMark'
import {
  useServerEmoji,
  useServerEmojiStore,
} from '../../store/custom-emoji'
import type { CommunityAdminSection } from '../../lib/mesh-navigation'

interface CommunitySettingsProps {
  isOpen: boolean
  onClose: () => void
  embedded?: boolean
  activeSection?: CommunityAdminSection
}

function CommunitySettingsFrame({
  embedded,
  isOpen,
  onClose,
  communityName,
  children,
}: {
  embedded: boolean
  isOpen: boolean
  onClose: () => void
  communityName: string
  children: ReactNode
}) {
  if (embedded) {
    if (!isOpen) return null
    return <div className="h-full overflow-y-auto">{children}</div>
  }

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      title="Community settings"
      description={`Manage ${communityName}, its rooms, and who can find it.`}
      size="lg"
      closeLabel="Close community settings"
    >
      {children}
    </Sheet>
  )
}

export function CommunitySettings({
  isOpen,
  onClose,
  embedded = false,
  activeSection,
}: CommunitySettingsProps) {
  const matrixMode = bridge.isMatrixBackend()
  const matrixVoiceReady = canStartMatrixVoice(bridge.getBackendStatusSnapshot())
  const communityOrder = useCommunityStore((state) => state.communityOrder)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const removeCommunity = useCommunityStore((state) => state.removeCommunity)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const patchCommunity = useCommunityStore((state) => state.patchCommunity)
  const addChannel = useChannelStore((state) => state.addChannel)
  const clearCommunityMembership = useMembershipStore((s) => s.clearCommunity)
  const communityMembers = useCommunityMembers(activeCommunityId)

  const community = useActiveCommunity()

  const [showInvite, setShowInvite] = useState(false)
  const [sectionQuery, setSectionQuery] = useState('')
  const [showCreateChannel, setShowCreateChannel] = useState(false)
  const [channelName, setChannelName] = useState('')
  const [channelType, setChannelType] = useState<'text' | 'voice'>('text')
  const [isCreatingChannel, setIsCreatingChannel] = useState(false)
  const [channelError, setChannelError] = useState<unknown | null>(null)
  const [communityName, setCommunityName] = useState(() => community?.name ?? '')
  const [communityDescription, setCommunityDescription] = useState(
    () => community?.description ?? '',
  )
  const [isSavingMetadata, setIsSavingMetadata] = useState(false)
  const [metadataError, setMetadataError] = useState<unknown | null>(null)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const [dangerBusy, setDangerBusy] = useState(false)
  const [dangerError, setDangerError] = useState<unknown | null>(null)
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
    if (!isOpen || !matrixMode || !community || !activeCommunityId) return
    if (activeSection && activeSection !== 'discovery-access') return
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
  }, [activeCommunityId, activeSection, community, isOpen, matrixMode])

  useEffect(() => {
    if (!isOpen || !matrixMode || !community || !activeCommunityId) return
    if (activeSection && activeSection !== 'moderation') return
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
  }, [activeCommunityId, activeSection, community, isOpen, matrixMode])

  if (!community || !activeCommunityId) return null

  const isOwner = community.role === 'owner'
  const isOwnerOrAdmin = community.role === 'owner' || community.role === 'admin'
  const sectionVisible = (section: CommunityAdminSection) => !activeSection || activeSection === section
  const settingsSections = [
    { id: 'community-settings-summary', label: 'Community summary', keywords: 'profile description members' },
    { id: 'community-settings-invitations', label: 'Invitations', keywords: 'invite people link account' },
    ...(isOwnerOrAdmin
      ? [{ id: 'community-settings-overview', label: 'Overview', keywords: 'name description profile' }]
      : []),
    ...(matrixMode && isOwnerOrAdmin
      ? [
          { id: 'community-settings-access', label: 'Access & discovery', keywords: 'public applications approval authority' },
          { id: 'community-settings-emoji', label: 'Custom emoji', keywords: 'image shortcode privacy' },
          { id: 'community-settings-moderation', label: 'Moderation activity', keywords: 'authority audit actions outcomes' },
        ]
      : []),
    ...(isOwnerOrAdmin
      ? [{ id: 'community-settings-rooms', label: 'Rooms', keywords: 'create text voice channel' }]
      : []),
    { id: 'community-settings-danger', label: 'Danger zone', keywords: 'leave delete destructive' },
  ]
  const normalizedSectionQuery = sectionQuery.trim().toLocaleLowerCase()
  const visibleSettingsSections = settingsSections.filter((section) =>
    `${section.label} ${section.keywords}`.toLocaleLowerCase().includes(normalizedSectionQuery),
  )

  const focusSettingsSection = (sectionId: string) => {
    const section = document.getElementById(sectionId)
    if (!section) return
    section.scrollIntoView?.({ block: 'start', behavior: 'auto' })
    section.focus({ preventScroll: true })
  }

  const handleCreateChannel = async () => {
    if (!channelName.trim()) return
    setIsCreatingChannel(true)
    setChannelError(null)
    try {
      const channel = await bridge.createChannel(activeCommunityId, channelName.trim(), channelType)
      addChannel(channel)
      setChannelName('')
      setShowCreateChannel(false)
    } catch (error) {
      setChannelError(error)
    } finally {
      setIsCreatingChannel(false)
    }
  }

  const handleLeave = async () => {
    setDangerBusy(true)
    setDangerError(null)
    try {
      await bridge.leaveCommunity(activeCommunityId)
      clearCommunityMembership(activeCommunityId)
      removeCommunity(activeCommunityId)
      const remaining = communityOrder.filter((id) => id !== activeCommunityId)
      setActiveCommunity(remaining[0] ?? null)
      onClose()
    } catch (error) {
      setDangerError(error)
    } finally {
      setDangerBusy(false)
    }
  }

  const handleDelete = async () => {
    setDangerBusy(true)
    setDangerError(null)
    try {
      await bridge.deleteCommunity(activeCommunityId)
      clearCommunityMembership(activeCommunityId)
      removeCommunity(activeCommunityId)
      const remaining = communityOrder.filter((id) => id !== activeCommunityId)
      setActiveCommunity(remaining[0] ?? null)
      onClose()
    } catch (error) {
      setDangerError(error)
    } finally {
      setDangerBusy(false)
    }
  }

  const handleSaveMetadata = async () => {
    if (!communityName.trim()) return
    setIsSavingMetadata(true)
    setMetadataError(null)
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
    } catch (error) {
      setMetadataError(error)
    } finally {
      setIsSavingMetadata(false)
    }
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
      <CommunitySettingsFrame
        embedded={embedded}
        isOpen={isOpen}
        onClose={onClose}
        communityName={community.name}
      >
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-party-gutter py-6">
          {/* Community info card */}
          {sectionVisible('general') && <section
            id="community-settings-summary"
            tabIndex={-1}
            aria-labelledby="community-settings-summary-heading"
            className="mb-6 scroll-mt-4 rounded-panel border border-border-subtle bg-surface-sunken p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <div className="mb-3 flex items-center gap-3">
              <Avatar
                color={pixelColorForSeed(community.id)}
                size={40}
                name={community.name}
                imageUrl={community.iconUrl}
                variant="community"
              />
              <div className="min-w-0 flex-1">
                <h3 id="community-settings-summary-heading" className="truncate text-sm font-semibold text-primary">{community.name}</h3>
                <p className="member-count text-xs text-muted">
                  {community.role} · {community.memberCount} member{community.memberCount !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
            {community.description && (
              <p className="text-sm text-secondary">{community.description}</p>
            )}
            <details className="mt-3 border-t border-border-subtle pt-3 text-xs text-muted">
              <summary className="cursor-pointer font-semibold text-secondary">Advanced service details</summary>
              <p className="mt-2">Community address</p>
              <code className="mt-1 block break-all rounded-control bg-surface-hover px-2 py-1.5 font-mono text-secondary">
                {community.id}
              </code>
            </details>
          </section>}

          {/* Invite */}
          {!embedded && sectionVisible('invitations') && <section
            id="community-settings-invitations"
            tabIndex={-1}
            aria-labelledby="community-settings-invitations-heading"
            className="mb-4 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <h3 id="community-settings-invitations-heading" className="sr-only">Invitations</h3>
            <Button onClick={() => setShowInvite(true)} className="w-full" variant="secondary">
              <span className="flex items-center gap-2">
                <Icon name="userPlus" size="sm" />
                Invite People
              </span>
            </Button>
          </section>}

          {!embedded && <div className="mb-6 rounded-panel border border-border-subtle bg-surface-sunken p-3">
            <Input
              id="community-settings-section-search"
              label="Find a settings section"
              value={sectionQuery}
              onChange={setSectionQuery}
              placeholder="Search sections"
            />
            <nav aria-label="Community settings sections" className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
              {visibleSettingsSections.map((section) => (
                <Button
                  key={section.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-start text-left"
                  onClick={() => focusSettingsSection(section.id)}
                >
                  {section.label}
                </Button>
              ))}
            </nav>
            {visibleSettingsSections.length === 0 && (
              <p role="status" className="mt-3 text-xs text-muted">
                No settings sections match that search.
              </p>
            )}
          </div>}

          {isOwnerOrAdmin && sectionVisible('general') && (
            <section id="community-settings-overview" tabIndex={-1} aria-labelledby="community-settings-overview-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <h3 id="community-settings-overview-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Overview</h3>
              <div className="space-y-3 border-b border-border-subtle pb-5">
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
                {metadataError != null ? (
                  <ErrorState
                    error={metadataError}
                    context={{ operation: 'save the community details', resource: 'community' }}
                    compact
                  />
                ) : null}
              </div>
            </section>
          )}

          {embedded && sectionVisible('people-roles') && (
            <section
              id="community-settings-people"
              tabIndex={-1}
              aria-labelledby="community-settings-people-heading"
              className="mb-6 flex min-h-0 flex-1 flex-col scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <h3 id="community-settings-people-heading" className="text-section-title font-semibold text-primary">
                People and roles for {community.name}
              </h3>
              <p className="mt-1 text-sm text-secondary">
                Current membership and roles come from the community. Moderation actions keep their own confirmation and report partial room outcomes.
              </p>
              <p className="mt-2 rounded-control border border-border-subtle bg-surface-sunken px-3 py-2 text-xs text-muted">
                Granular role changes stay unavailable until Mesh can verify the community's permission model. Ownership transfer is not offered.
              </p>
              <div className="mt-4 flex min-h-0 flex-1 overflow-hidden rounded-panel border border-border-subtle bg-surface-sunken">
                <MemberList
                  embedded
                  isOpen
                  onClose={() => {}}
                  members={communityMembers.map((member) => ({
                    publicKey: member.publicKey,
                    displayName: member.displayName,
                    avatarColor: member.avatarColor,
                    avatarUrl: member.avatarUrl,
                    role: member.role,
                    online: member.online ?? false,
                  }))}
                />
              </div>
            </section>
          )}

          {matrixMode && isOwnerOrAdmin && sectionVisible('discovery-access') && (
            <section id="community-settings-access" tabIndex={-1} aria-labelledby="community-settings-access-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <h3 id="community-settings-access-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Access & Discovery</h3>
              <div className="space-y-3 border-b border-border-subtle pb-5">
                <Input
                  id="community-public-link"
                  label="Public link"
                  value={communityAlias}
                  onChange={setCommunityAlias}
                  placeholder="design-club"
                  aria-describedby="community-public-link-description"
                  aria-invalid={isDiscoverable && !communityAlias.trim() ? true : undefined}
                />
                <p id="community-public-link-description" className="text-xs text-muted">
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
                <div className="mt-3 space-y-2 rounded-panel border border-border-subtle bg-surface-sunken p-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Applications ({applications.length})
                  </h4>
                  {applications.map((application) => (
                    <div key={application.userId} className="rounded-md bg-surface-hover p-3">
                      <p className="text-sm font-medium text-primary">{application.displayName}</p>
                      <p className="break-all text-xs text-text-link">{application.userId}</p>
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
            </section>
          )}

          {matrixMode && isOwnerOrAdmin && sectionVisible('emoji') && (
            <section id="community-settings-emoji" tabIndex={-1} aria-labelledby="community-settings-emoji-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <h3 id="community-settings-emoji-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Custom Emoji
              </h3>
              <div className="space-y-3 border-b border-border-subtle pb-5">
                <p id="community-emoji-description" className="text-xs text-muted">
                  Emoji images and names are shared community settings. They are not protected
                  like message text.
                </p>
                <Input
                  id="community-emoji-name"
                  label="Emoji name"
                  value={emojiShortcode}
                  onChange={setEmojiShortcode}
                  placeholder="party_parrot"
                  aria-describedby="community-emoji-description community-emoji-file-description"
                />
                <label
                  htmlFor="community-emoji-file"
                  className="block text-xs font-semibold uppercase text-muted"
                >
                  Image
                  <input
                    id="community-emoji-file"
                    ref={emojiFileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-describedby="community-emoji-description community-emoji-file-description"
                    onChange={(event) => setEmojiFile(event.target.files?.[0] ?? null)}
                    className="mt-1.5 block min-h-control-md w-full cursor-pointer rounded-md border border-border bg-surface-hover px-3 py-2 text-sm font-normal normal-case text-secondary file:mr-3 file:rounded file:border-0 file:bg-surface-active file:px-3 file:py-1 file:text-xs file:font-semibold file:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </label>
                <p id="community-emoji-file-description" className="text-xs text-muted">
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
                        className="flex min-h-control-md items-center gap-3 rounded-control px-2 hover:bg-surface-hover"
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
            </section>
          )}

          {matrixMode && isOwnerOrAdmin && sectionVisible('moderation') && (
            <section id="community-settings-moderation" tabIndex={-1} aria-labelledby="community-settings-moderation-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <h3 id="community-settings-moderation-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Moderation Activity
              </h3>
              <div className="space-y-3 border-b border-border-subtle pb-5">
                <p className="text-xs text-muted">
                  Mesh does not currently provide an authoritative administrator-action history.
                  Live moderation results report per-channel outcomes at the time of the action.
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
            </section>
          )}

          {/* Create channel */}
          {isOwnerOrAdmin && sectionVisible('rooms-voice') && (
            <section id="community-settings-rooms" tabIndex={-1} aria-labelledby="community-settings-rooms-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <div className="mb-2 flex items-center justify-between">
                <h3 id="community-settings-rooms-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Rooms</h3>
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
                    initial={{ y: -4 }}
                    animate={{ y: 0 }}
                    exit={{ y: -4 }}
                    transition={transitions.enter}
                    className="overflow-hidden"
                  >
                    <div className="space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-4">
                      <Input
                        label="Room Name"
                        value={channelName}
                        onChange={setChannelName}
                        placeholder="e.g. announcements"
                        autoFocus
                      />

                      <fieldset>
                        <legend className="mb-1.5 block text-xs font-semibold uppercase text-muted">
                          Room Type
                        </legend>
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
                      </fieldset>

                      <Button
                        onClick={handleCreateChannel}
                        disabled={!channelName.trim() || isCreatingChannel}
                        className="w-full"
                      >
                        {isCreatingChannel ? 'Creating…' : 'Create Room'}
                      </Button>
                      {channelError != null ? (
                        <ErrorState
                          error={channelError}
                          context={{ operation: 'create the room', resource: 'community' }}
                          compact
                        />
                      ) : null}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          )}

          {/* Danger zone */}
          {sectionVisible('danger') && <section id="community-settings-danger" tabIndex={-1} aria-labelledby="community-settings-danger-heading" className="mt-auto scroll-mt-4 border-t border-border pt-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            <h3 id="community-settings-danger-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-status-danger">Danger zone</h3>
            {matrixMode && isOwner ? (
              <div className="rounded-panel border border-border-subtle bg-surface-sunken p-4">
                <p className="text-sm font-semibold text-primary">Ownership must be resolved first</p>
                <p className="mt-1 text-sm text-secondary">
                  Mesh does not invent an ownership transfer or claim to delete this community across compatible services. Leaving stays unavailable until that contract is reviewed.
                </p>
              </div>
            ) : !showLeaveConfirm ? (
              <Button
                onClick={() => {
                  setDangerError(null)
                  setShowLeaveConfirm(true)
                }}
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
                className="space-y-3 rounded-panel border border-status-danger/30 bg-status-danger/5 p-4"
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
                {dangerError != null ? (
                  <ErrorState
                    error={dangerError}
                    context={{
                      operation: !matrixMode && isOwner
                        ? `delete ${community.name}`
                        : `leave ${community.name}`,
                      resource: 'community',
                    }}
                    compact
                  />
                ) : null}
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setShowLeaveConfirm(false)
                      setDangerError(null)
                    }}
                    variant="secondary"
                    className="flex-1"
                    disabled={dangerBusy}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={matrixMode ? handleLeave : isOwner ? handleDelete : handleLeave}
                    tone="danger"
                    className="flex-1"
                    disabled={dangerBusy}
                  >
                    {dangerBusy ? 'Working…' : !matrixMode && isOwner ? 'Delete' : 'Leave'}
                  </Button>
                </div>
              </motion.div>
            )}
          </section>}

          {embedded && activeSection === 'invitations' && (
            <InviteModal
              embedded
              isOpen
              onClose={onClose}
              communityId={activeCommunityId}
              communityName={community.name}
            />
          )}

          {embedded
            && activeSection
            && !isOwnerOrAdmin
            && ['rooms-voice', 'discovery-access', 'moderation', 'emoji'].includes(activeSection) && (
              <section role="alert" className="rounded-panel border border-status-warning/40 bg-status-warning/5 p-4">
                <h2 className="text-sm font-semibold text-primary">Your community permissions changed</h2>
                <p className="mt-1 text-sm text-secondary">
                  You can still view the community, but this administration section requires a current owner or administrator role.
                </p>
              </section>
          )}
        </div>
      </CommunitySettingsFrame>

      {!embedded && <InviteModal
        isOpen={showInvite}
        onClose={() => setShowInvite(false)}
        communityId={activeCommunityId}
        communityName={community.name}
      />}
    </>
  )
}
