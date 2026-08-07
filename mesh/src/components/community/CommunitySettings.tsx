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
import {
  canStartMatrixVoice,
  VOICE_COMING_SOON_DETAIL,
  VOICE_COMING_SOON_TITLE,
} from '../../lib/voice-runtime'
import type { Channel, CommunityApplication, ModerationAuditEntry } from '../../types/ipc'
import { Icon, type IconName } from '../ui/Icon'
import { Avatar } from '../ui/Avatar'
import { pixelColorForSeed } from '../ui/PixelMark'
import {
  useServerEmoji,
  useServerEmojiStore,
} from '../../store/custom-emoji'
import type { CommunityAdminSection } from '../../lib/mesh-navigation'
import {
  CHANNEL_NAME_MAX_LENGTH,
  COMMUNITY_DESCRIPTION_MAX_LENGTH,
  COMMUNITY_NAME_MAX_LENGTH,
  metadataCharactersRemaining,
  metadataLengthError,
} from '../../lib/community-metadata-limits'

interface CommunitySettingsProps {
  isOpen: boolean
  onClose: () => void
  embedded?: boolean
  activeSection?: CommunityAdminSection
}

const MAX_CUSTOM_EMOJI_BYTES = 512 * 1024
const MAX_CUSTOM_EMOJI_COUNT = 100

function normalizedEmojiName(value: string) {
  return value.trim().toLocaleLowerCase()
}

function customEmojiNameError(value: string) {
  const normalized = normalizedEmojiName(value)
  if (!normalized) return null
  if (normalized.length < 2 || normalized.length > 32 || !/^[a-z0-9_]+$/.test(normalized)) {
    return 'Use 2–32 letters, numbers, or underscores.'
  }
  return null
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
    return (
      <div
        role="region"
        aria-label={`${communityName} settings`}
        tabIndex={0}
        className="h-full overflow-y-auto"
      >
        {children}
      </div>
    )
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
  const channels = useChannelStore((state) => state.channels)
  const addChannel = useChannelStore((state) => state.addChannel)
  const clearCommunityMembership = useMembershipStore((s) => s.clearCommunity)
  const communityMembers = useCommunityMembers(activeCommunityId)

  const community = useActiveCommunity()
  const communityChannels = channels.filter((channel) => channel.communityId === activeCommunityId)
  const textChannels = communityChannels.filter((channel) => channel.channelType === 'text')
  const voiceChannels = communityChannels.filter((channel) => channel.channelType === 'voice')

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
  const [metadataNotice, setMetadataNotice] = useState<string | null>(null)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const [dangerBusy, setDangerBusy] = useState(false)
  const [dangerError, setDangerError] = useState<unknown | null>(null)
  const [communityAlias, setCommunityAlias] = useState('')
  const [isDiscoverable, setIsDiscoverable] = useState(false)
  const [isSavingAccess, setIsSavingAccess] = useState(false)
  const [accessError, setAccessError] = useState<unknown | null>(null)
  const [accessNotice, setAccessNotice] = useState<string | null>(null)
  const [applications, setApplications] = useState<CommunityApplication[]>([])
  const [applicationBusy, setApplicationBusy] = useState<string | null>(null)
  const [moderationAudit, setModerationAudit] = useState<ModerationAuditEntry[]>([])
  const [moderationAuditError, setModerationAuditError] = useState<unknown | null>(null)
  const [emojiShortcode, setEmojiShortcode] = useState('')
  const [emojiGrant, setEmojiGrant] = useState<bridge.NativeAttachmentGrant | null>(null)
  const [emojiBusy, setEmojiBusy] = useState<string | null>(null)
  const [emojiError, setEmojiError] = useState<unknown | null>(null)
  const [emojiNotice, setEmojiNotice] = useState<string | null>(null)
  const [emojiRetryFilename, setEmojiRetryFilename] = useState<string | null>(null)
  const [emojiPendingRemoval, setEmojiPendingRemoval] = useState<string | null>(null)
  const emojiPickerRef = useRef<HTMLButtonElement>(null)
  const emojiGrantTokenRef = useRef<string | null>(null)
  const serverEmoji = useServerEmoji(activeCommunityId)
  const refreshServerEmoji = useServerEmojiStore((state) => state.load)
  const removeLocalServerEmoji = useServerEmojiStore((state) => state.removeLocal)
  const emojiLoading = useServerEmojiStore((state) => (
    activeCommunityId ? state.loading[activeCommunityId] ?? false : false
  ))

  const communityNameError = metadataLengthError(
    'Community name',
    communityName,
    COMMUNITY_NAME_MAX_LENGTH,
  )
  const communityDescriptionError = metadataLengthError(
    'Description',
    communityDescription,
    COMMUNITY_DESCRIPTION_MAX_LENGTH,
  )
  const channelNameError = metadataLengthError(
    'Room name',
    channelName,
    CHANNEL_NAME_MAX_LENGTH,
  )
  const hasInvalidCommunityMetadata = Boolean(
    communityNameError || communityDescriptionError,
  )
  const normalizedShortcode = normalizedEmojiName(emojiShortcode)
  const emojiNameError = customEmojiNameError(emojiShortcode) ?? (
    normalizedShortcode && serverEmoji.some((emoji) => emoji.shortcode === normalizedShortcode)
      ? 'That emoji name is already in use.'
      : null
  )
  const emojiGrantError = emojiGrant && (
    emojiGrant.size === 0 || emojiGrant.size > MAX_CUSTOM_EMOJI_BYTES
      ? 'Choose an image that is 512 KB or smaller.'
      : !['image/png', 'image/jpeg', 'image/webp'].includes(emojiGrant.contentType)
        ? 'Choose a PNG, JPEG, or WebP image.'
        : null
  )
  const emojiPreviewName = normalizedEmojiName(emojiShortcode) || 'emoji_name'

  useEffect(() => {
    emojiGrantTokenRef.current = emojiGrant?.grant ?? null
  }, [emojiGrant])

  useEffect(() => () => {
    const grant = emojiGrantTokenRef.current
    if (grant) void bridge.discardAttachmentGrant(grant)
  }, [])

  useEffect(() => {
    if (emojiRetryFilename) emojiPickerRef.current?.focus()
  }, [emojiRetryFilename])

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
        setAccessNotice(null)
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
  const communityRoleLabel = community.role === 'owner'
    ? 'Community owner'
    : community.role === 'admin'
      ? 'Administrator'
      : 'Member'
  const communityService = community.id.includes(':')
    ? community.id.split(':').slice(-1)[0]
    : 'Compatible service'
  const onlineMemberCount = communityMembers.filter((member) => member.online).length
  const leadershipCount = communityMembers.filter((member) => member.role !== 'member').length
  const metadataDirty = communityName.trim() !== community.name.trim()
    || communityDescription.trim() !== (community.description?.trim() ?? '')
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
    if (!channelName.trim() || channelNameError) return
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
    if (!communityName.trim() || hasInvalidCommunityMetadata || !metadataDirty) return
    setIsSavingMetadata(true)
    setMetadataError(null)
    setMetadataNotice(null)
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
      setCommunityName(communityName.trim())
      setCommunityDescription(communityDescription.trim())
      setMetadataNotice('Community details saved.')
    } catch (error) {
      setMetadataError(error)
    } finally {
      setIsSavingMetadata(false)
    }
  }

  const handleSaveAccess = async () => {
    setIsSavingAccess(true)
    setAccessError(null)
    setAccessNotice(null)
    try {
      const settings = await bridge.updateCommunityAccess(
        activeCommunityId,
        communityAlias,
        isDiscoverable,
      )
      setCommunityAlias(settings.alias ?? '')
      setIsDiscoverable(settings.discoverable)
      setAccessNotice('Discovery and joining settings saved.')
    } catch (error) {
      setAccessError(error)
    }
    setIsSavingAccess(false)
  }

  const handleApplication = async (application: CommunityApplication, accept: boolean) => {
    setAccessError(null)
    setAccessNotice(null)
    setApplicationBusy(application.userId)
    try {
      await bridge.respondToCommunityApplication(
        activeCommunityId,
        application.userId,
        accept,
        accept ? undefined : 'Community application declined',
      )
      setApplications((current) => current.filter((entry) => entry.userId !== application.userId))
      setAccessNotice(`${application.displayName} ${accept ? 'approved' : 'declined'}.`)
    } catch (error) {
      setAccessError(error)
    } finally {
      setApplicationBusy(null)
    }
  }

  const handleEmojiPick = async () => {
    setEmojiBusy('pick')
    setEmojiError(null)
    setEmojiNotice(null)
    setEmojiRetryFilename(null)
    try {
      const selection = await bridge.pickCustomEmojiGrant(activeCommunityId)
      if (!selection) return
      const previousGrant = emojiGrant?.grant
      setEmojiGrant(selection)
      if (previousGrant && previousGrant !== selection.grant) {
        void bridge.discardAttachmentGrant(previousGrant)
      }
    } catch (error) {
      setEmojiError(error)
    } finally {
      setEmojiBusy(null)
    }
  }

  const clearEmojiSelection = () => {
    const grant = emojiGrant?.grant
    setEmojiGrant(null)
    setEmojiRetryFilename(null)
    if (grant) void bridge.discardAttachmentGrant(grant)
  }

  const handleEmojiUpload = async () => {
    if (!emojiGrant || !emojiShortcode.trim() || emojiNameError || emojiGrantError) return
    setEmojiBusy('upload')
    setEmojiError(null)
    setEmojiNotice(null)
    setEmojiRetryFilename(null)
    try {
      const shortcode = normalizedEmojiName(emojiShortcode)
      await bridge.uploadServerEmoji(activeCommunityId, shortcode, emojiGrant)
      setEmojiShortcode('')
      setEmojiGrant(null)
      let reconciled = true
      try {
        await bridge.matrixSyncOnce()
      } catch {
        reconciled = false
      }
      try {
        await refreshServerEmoji(activeCommunityId, true)
      } catch {
        reconciled = false
      }
      const visible = useServerEmojiStore
        .getState()
        .byCommunity[activeCommunityId]
        ?.some((emoji) => emoji.shortcode === shortcode) ?? false
      setEmojiNotice(
        reconciled && visible
          ? `:${shortcode}: added to ${community.name}.`
          : `:${shortcode}: was added to ${community.name}. It may take a moment to appear.`,
      )
    } catch (error) {
      // Native upload grants are one-use even when the network request fails.
      setEmojiRetryFilename(emojiGrant.name)
      setEmojiGrant(null)
      setEmojiError(error)
    } finally {
      setEmojiBusy(null)
    }
  }

  const handleEmojiRemove = async (shortcode: string) => {
    setEmojiBusy(shortcode)
    setEmojiError(null)
    setEmojiNotice(null)
    try {
      await bridge.removeServerEmoji(activeCommunityId, shortcode)
      removeLocalServerEmoji(activeCommunityId, shortcode)
      setEmojiPendingRemoval(null)
      setEmojiNotice(`:${shortcode}: removed from ${community.name}.`)
      try {
        await bridge.matrixSyncOnce()
        await refreshServerEmoji(activeCommunityId, true)
      } catch {
        // The removal is already confirmed and reflected locally. A later sync
        // will reconcile the shared library without relabeling success as failure.
      }
    } catch (error) {
      setEmojiError(error)
    } finally {
      setEmojiBusy(null)
    }
  }

  const cancelEmojiRemoval = (shortcode: string) => {
    setEmojiPendingRemoval(null)
    window.requestAnimationFrame(() => {
      document.getElementById(`community-emoji-remove-${shortcode}`)?.focus()
    })
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
          {/* Community identity */}
          {sectionVisible('general') && <section
            id="community-settings-summary"
            tabIndex={-1}
            aria-labelledby="community-settings-summary-heading"
            className="mb-3 scroll-mt-4 rounded-panel border border-border-subtle bg-surface-raised p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <div className="flex items-start gap-4">
              <Avatar
                color={pixelColorForSeed(community.id)}
                size={48}
                name={community.name}
                imageUrl={community.iconUrl}
                variant="community"
              />
              <div className="min-w-0 flex-1">
                <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">Community identity</p>
                <h3 id="community-settings-summary-heading" className="mt-1 truncate text-title font-semibold tracking-tight text-primary">{community.name}</h3>
                <p className="member-count mt-1 text-xs text-muted">
                  {communityRoleLabel} · {community.memberCount} member{community.memberCount !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
            {community.description && (
              <p className="mt-2 max-w-2xl text-sm leading-5 text-secondary">{community.description}</p>
            )}

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-2">
                <div className="flex items-center gap-2 text-accent">
                  <Icon name="shieldCheck" size="sm" />
                  <span className="text-xs font-semibold uppercase tracking-wide">Your role</span>
                </div>
                <p className="mt-1.5 text-sm font-semibold text-primary">{communityRoleLabel}</p>
                <p className="mt-0.5 text-xs text-muted">Verified by this community.</p>
              </div>
              <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-2">
                <div className="flex items-center gap-2 text-accent">
                  <Icon name="users" size="sm" />
                  <span className="text-xs font-semibold uppercase tracking-wide">People</span>
                </div>
                <p className="mt-1.5 text-sm font-semibold text-primary">
                  {community.memberCount} member{community.memberCount !== 1 ? 's' : ''}
                </p>
                <p className="mt-0.5 text-xs text-muted">Current community count.</p>
              </div>
              <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-2">
                <div className="flex items-center gap-2 text-accent">
                  <Icon name="activity" size="sm" />
                  <span className="text-xs font-semibold uppercase tracking-wide">Community service</span>
                </div>
                <p className="mt-1.5 truncate text-sm font-semibold text-primary">{communityService}</p>
                <p className="mt-0.5 text-xs text-muted">Where the community is hosted.</p>
              </div>
            </div>

            <details className="mt-2 border-t border-border-subtle pt-2 text-xs text-muted">
              <summary className="cursor-pointer font-semibold text-secondary">Advanced service details</summary>
              <div className="mt-2 rounded-control border border-border-subtle bg-surface-sunken px-3 py-2">
                <p>Community address</p>
                <code className="mt-1 block break-all font-mono text-secondary">{community.id}</code>
              </div>
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
            <section
              id="community-settings-overview"
              tabIndex={-1}
              aria-labelledby="community-settings-overview-heading"
              className="mb-6 scroll-mt-4 rounded-panel border border-border-subtle bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <div className="flex flex-col items-stretch gap-3 border-b border-border-subtle px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-control bg-accent/10 text-accent">
                    <Icon name="squarePen" size="sm" />
                  </div>
                  <div>
                    <h3 id="community-settings-overview-heading" className="text-sm font-semibold text-primary">Public details</h3>
                    <p className="mt-0.5 text-xs leading-5 text-muted">
                      Keep the name and description recognizable wherever this community appears.
                    </p>
                  </div>
                </div>
                <div
                  className={`flex flex-shrink-0 self-start items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
                    metadataDirty
                      ? 'border-accent/30 bg-accent/10 text-accent'
                      : 'border-border-subtle bg-surface-raised text-muted'
                  }`}
                >
                  <Icon name={metadataDirty ? 'squarePen' : 'check'} size="xs" />
                  {metadataDirty ? 'Unsaved' : 'Up to date'}
                </div>
              </div>

              <div className="space-y-3 p-3">
                <Input
                  label="Community Name"
                  value={communityName}
                  onChange={(value: string) => {
                    setCommunityName(value)
                    setMetadataError(null)
                    setMetadataNotice(null)
                  }}
                  placeholder="Community name"
                  maxLength={COMMUNITY_NAME_MAX_LENGTH}
                  hint={metadataCharactersRemaining(
                    communityName,
                    COMMUNITY_NAME_MAX_LENGTH,
                  )}
                  error={communityNameError}
                />
                <Field
                  label="Description"
                  htmlFor="community-description"
                  hint={metadataCharactersRemaining(
                    communityDescription,
                    COMMUNITY_DESCRIPTION_MAX_LENGTH,
                  )}
                  error={communityDescriptionError}
                >
                  <Textarea
                    id="community-description"
                    value={communityDescription}
                    onChange={(e) => {
                      setCommunityDescription(e.target.value)
                      setMetadataError(null)
                      setMetadataNotice(null)
                    }}
                    maxLength={COMMUNITY_DESCRIPTION_MAX_LENGTH}
                    rows={2}
                    className="min-h-16 resize-none"
                    placeholder="What is this community about?"
                  />
                </Field>
              </div>

              <div className="sticky bottom-0 z-sticky flex min-h-12 flex-col items-stretch gap-2 border-t border-border-subtle bg-surface-raised px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0 text-xs text-muted" aria-live="polite">
                  {metadataNotice ? (
                    <p role="status" className="flex items-center gap-2 text-status-success">
                      <Icon name="check" size="xs" />
                      {metadataNotice}
                    </p>
                  ) : (
                    <p>{metadataDirty ? 'Review your changes before saving.' : 'Details match the saved community profile.'}</p>
                  )}
                </div>
                <Button
                  onClick={handleSaveMetadata}
                  disabled={!communityName.trim() || hasInvalidCommunityMetadata || isSavingMetadata || !metadataDirty}
                  className="w-full flex-shrink-0 sm:w-auto"
                >
                  <span className="flex items-center gap-2">
                    <Icon name="check" size="sm" />
                    {isSavingMetadata ? 'Saving…' : 'Save Changes'}
                  </span>
                </Button>
              </div>

              {metadataError != null ? (
                <div className="border-t border-border-subtle p-4">
                  <ErrorState
                    error={metadataError}
                    context={{ operation: 'save the community details', resource: 'community' }}
                    compact
                  />
                </div>
              ) : null}
            </section>
          )}

          {embedded && sectionVisible('people-roles') && (
            <section
              id="community-settings-people"
              tabIndex={-1}
              aria-labelledby="community-settings-people-heading"
              className="mb-6 flex min-h-0 flex-1 flex-col scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <div className="rounded-panel border border-border-subtle bg-surface-raised p-3">
                <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">Community people</p>
                <h3 id="community-settings-people-heading" className="mt-1 text-title font-semibold tracking-tight text-primary">
                  People and roles
                </h3>
                <p className="mt-1 max-w-2xl text-sm leading-5 text-muted">
                  See who belongs to {community.name}, who is available now, and which actions your verified role allows.
                </p>

                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-2">
                    <div className="flex items-center gap-2 text-accent">
                      <Icon name="users" size="sm" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Membership</span>
                    </div>
                    <p className="mt-1.5 text-sm font-semibold text-primary">
                      {community.memberCount} people
                    </p>
                    <p className="mt-0.5 text-xs text-muted">Reported by the community.</p>
                  </div>
                  <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-2">
                    <div className="flex items-center gap-2 text-status-success">
                      <Icon name="activity" size="sm" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Online now</span>
                    </div>
                    <p className="mt-1.5 text-sm font-semibold text-primary">{onlineMemberCount} available</p>
                    <p className="mt-0.5 text-xs text-muted">Presence from the current roster.</p>
                  </div>
                  <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-2">
                    <div className="flex items-center gap-2 text-accent">
                      <Icon name="shieldCheck" size="sm" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Leadership</span>
                    </div>
                    <p className="mt-1.5 text-sm font-semibold text-primary">
                      {leadershipCount} verified role{leadershipCount !== 1 ? 's' : ''}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">Owners and administrators shown below.</p>
                  </div>
                </div>

                <div className="mt-2 flex items-start gap-3 rounded-control border border-border-subtle bg-surface-sunken px-3 py-2">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-control bg-accent/10 text-accent">
                    <Icon name="shieldCheck" size="sm" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-primary">Verified actions only</p>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      Messages and moderation keep their own confirmation. Granular role changes and ownership transfer stay unavailable until Mesh can verify that permission model.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-border-subtle bg-surface-sunken">
                <div className="flex items-center justify-between gap-4 border-b border-border-subtle bg-surface-raised px-4 py-3">
                  <div>
                    <h4 className="text-sm font-semibold text-primary">Current roster</h4>
                    <p className="mt-0.5 text-xs text-muted">Search by display name or full account address.</p>
                  </div>
                  <p className="flex-shrink-0 font-mono text-xs text-muted">
                    {communityMembers.length} shown
                  </p>
                </div>
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
                    joinStatus: member.joinStatus,
                    banStatus: member.banStatus,
                  }))}
                />
              </div>
            </section>
          )}

          {matrixMode && isOwnerOrAdmin && sectionVisible('discovery-access') && (
            <section id="community-settings-access" tabIndex={-1} aria-labelledby="community-settings-access-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <div className="rounded-panel border border-border-subtle bg-surface-raised p-4">
                <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">Community access</p>
                <h3 id="community-settings-access-heading" className="mt-1 text-title font-semibold tracking-tight text-primary">
                  Discovery and joining
                </h3>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                  Decide how people find {community.name} and whether they can ask to join. Invitations keep working in either mode.
                </p>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-3">
                    <div className="flex items-center gap-2 text-accent">
                      <Icon name={isDiscoverable ? 'compass' : 'lock'} size="sm" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Listing</span>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-primary">
                      {isDiscoverable ? 'Publicly listed' : 'Not publicly listed'}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {isDiscoverable ? 'People can find the community by its public link.' : 'People need an invitation to discover the community.'}
                    </p>
                  </div>
                  <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-3">
                    <div className="flex items-center gap-2 text-accent">
                      <Icon name="shieldCheck" size="sm" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Joining</span>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-primary">
                      {isDiscoverable ? 'Approval required' : 'Invitation only'}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {isDiscoverable ? 'An administrator reviews every request before access is granted.' : 'Only people with a valid invitation can join.'}
                    </p>
                  </div>
                </div>

                <p className="mt-3 rounded-control border border-border-subtle bg-surface-sunken px-3 py-2 text-xs leading-5 text-muted">
                  People can keep their account with any compatible service. These settings only control access to {community.name}.
                </p>
              </div>

              <div className="mt-4 space-y-4 rounded-panel border border-border-subtle bg-surface-sunken p-4">
                <div>
                  <h4 className="text-sm font-semibold text-primary">Public identity</h4>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Reserve a short, recognizable link even while the community is invitation only.
                  </p>
                </div>
                <Input
                  id="community-public-link"
                  label="Public link"
                  value={communityAlias}
                  onChange={(value: string) => {
                    setCommunityAlias(value)
                    setAccessError(null)
                    setAccessNotice(null)
                  }}
                  placeholder="design-club"
                  aria-describedby="community-public-link-description"
                  aria-invalid={isDiscoverable && !communityAlias.trim() ? true : undefined}
                />
                <p id="community-public-link-description" className="text-xs text-muted">
                  This is the name people use to find the community when public listing is on.
                </p>
                <Switch
                  checked={isDiscoverable}
                  onCheckedChange={(checked) => {
                    setIsDiscoverable(checked)
                    setAccessError(null)
                    setAccessNotice(null)
                  }}
                  label="List this community publicly"
                  description="People can discover it and ask to join. An administrator still approves every request."
                  className="rounded-control border border-border-subtle bg-surface-base p-3"
                />
                {accessError != null && (
                  <ErrorState
                    error={accessError}
                    context={{ operation: 'update community access settings', resource: 'community' }}
                    compact
                  />
                )}
                {accessNotice && (
                  <p role="status" className="flex items-center gap-2 text-xs text-status-success">
                    <Icon name="check" size="xs" />
                    {accessNotice}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button
                    onClick={handleSaveAccess}
                    disabled={isSavingAccess || (isDiscoverable && !communityAlias.trim())}
                  >
                    {isSavingAccess ? 'Saving…' : 'Save access settings'}
                  </Button>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between gap-3 border-b border-border-subtle pb-2">
                <div>
                  <h4 className="text-sm font-semibold text-primary">Join requests</h4>
                  <p className="mt-0.5 text-xs text-muted">Review people who found the community through its public listing.</p>
                </div>
                <span className="font-mono text-meta text-muted">{applications.length} waiting</span>
              </div>

              {applications.length === 0 ? (
                <div className="mt-3 rounded-panel border border-border-subtle bg-surface-sunken px-4 py-6 text-center">
                  <Icon name="userPlus" size="lg" className="mx-auto text-muted" />
                  <p className="mt-3 text-sm font-semibold text-primary">No requests waiting</p>
                  <p className="mt-1 text-xs text-muted">New requests appear here when public listing is on.</p>
                </div>
              ) : (
                <div className="grid gap-3 py-3 md:grid-cols-2">
                  {applications.map((application) => (
                    <article key={application.userId} className="rounded-panel border border-border-subtle bg-surface-sunken p-4">
                      <div className="flex items-center gap-3">
                        <Avatar
                          name={application.displayName}
                          color={pixelColorForSeed(application.userId)}
                          size={32}
                        />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-primary">{application.displayName}</p>
                          <p className="truncate text-xs text-muted">{application.userId}</p>
                        </div>
                      </div>
                      {application.reason && (
                        <p className="mt-3 text-xs leading-5 text-secondary">“{application.reason}”</p>
                      )}
                      <div className="mt-4 flex gap-2">
                        <Button
                          onClick={() => handleApplication(application, true)}
                          disabled={applicationBusy != null}
                          size="sm"
                          className="flex-1"
                        >
                          {applicationBusy === application.userId ? 'Reviewing…' : 'Approve'}
                        </Button>
                        <Button
                          onClick={() => handleApplication(application, false)}
                          disabled={applicationBusy != null}
                          variant="secondary"
                          size="sm"
                          className="flex-1"
                        >
                          Decline
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          {matrixMode && isOwnerOrAdmin && sectionVisible('emoji') && (
            <section id="community-settings-emoji" tabIndex={-1} aria-labelledby="community-settings-emoji-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <div className="rounded-panel border border-border-subtle bg-surface-raised p-4">
                <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">Shared expression</p>
                <h3 id="community-settings-emoji-heading" className="mt-1 text-title font-semibold tracking-tight text-primary">
                  Community emoji
                </h3>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                  Give {community.name} a recognizable visual language that members can use in conversation.
                </p>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-3">
                    <div className="flex items-center gap-2 text-accent">
                      <Icon name="smile" size="sm" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Library</span>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-primary">{serverEmoji.length} active</p>
                    <p className="mt-1 text-xs text-muted">Up to {MAX_CUSTOM_EMOJI_COUNT} emoji can belong to this community.</p>
                  </div>
                  <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-3">
                    <div className="flex items-center gap-2 text-accent">
                      <Icon name="users" size="sm" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Visibility</span>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-primary">Community-wide</p>
                    <p className="mt-1 text-xs text-muted">Every member can see and use the approved library.</p>
                  </div>
                </div>

                <p id="community-emoji-description" className="mt-3 rounded-control border border-border-subtle bg-surface-sunken px-3 py-2 text-xs leading-5 text-muted">
                  Emoji names and images are shared community settings. They are not protected like message text, so do not upload private or identifying images.
                </p>
              </div>

              <div className="mt-4 rounded-panel border border-border-subtle bg-surface-sunken p-4">
                <div className="mb-4 flex items-start gap-3">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-panel bg-accent/10 text-accent">
                    <Icon name="upload" size="sm" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-primary">Add an emoji</h4>
                    <p className="mt-1 text-xs leading-5 text-muted">Mesh sanitizes the image and resizes it to fit the community library.</p>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <Input
                    id="community-emoji-name"
                    label="Emoji name"
                    value={emojiShortcode}
                    onChange={(value: string) => {
                      setEmojiShortcode(value)
                      setEmojiError(null)
                      setEmojiNotice(null)
                    }}
                    placeholder="party_parrot"
                    maxLength={32}
                    hint={`Appears as :${emojiPreviewName}:`}
                    error={emojiNameError ?? undefined}
                    aria-describedby="community-emoji-description community-emoji-file-description"
                  />
                  <div>
                    <span className="block text-xs font-semibold uppercase text-muted">Image</span>
                    <Button
                      ref={emojiPickerRef}
                      variant="secondary"
                      className="mt-1.5 w-full"
                      onClick={handleEmojiPick}
                      disabled={emojiBusy != null}
                      aria-describedby={`community-emoji-description community-emoji-file-description${emojiGrant ? ' community-emoji-selection' : ''}${emojiRetryFilename ? ' community-emoji-retry' : ''}`}
                      aria-invalid={emojiGrantError ? true : undefined}
                    >
                      <Icon name="image" size="xs" />
                      {emojiBusy === 'pick'
                        ? 'Opening picker…'
                        : emojiGrant
                          ? 'Choose a different image'
                          : 'Choose image'}
                    </Button>
                    <p id="community-emoji-file-description" className={`mt-1.5 text-xs ${emojiGrantError ? 'text-status-danger' : 'text-muted'}`}>
                      {emojiGrantError ?? 'PNG, JPEG, or WebP · up to 512 KB.'}
                    </p>
                  </div>
                </div>

                {emojiGrant && !emojiGrantError && (
                  <div
                    id="community-emoji-selection"
                    role="status"
                    aria-live="polite"
                    className="mt-3 flex items-center gap-2 rounded-control border border-border-subtle bg-surface-base px-3 py-2 text-xs text-secondary"
                  >
                    <Icon name="image" size="xs" className="text-accent" />
                    <span className="min-w-0 flex-1 truncate">{emojiGrant.name}</span>
                    <span className="font-mono text-meta text-muted">{Math.ceil(emojiGrant.size / 1024)} KB</span>
                    <IconButton
                      aria-label="Remove selected image"
                      size="sm"
                      onClick={clearEmojiSelection}
                      disabled={emojiBusy != null}
                    >
                      <Icon name="x" size="xs" />
                    </IconButton>
                  </div>
                )}
                {emojiError != null && (
                  <ErrorState
                    error={emojiError}
                    context={{ operation: 'update custom emoji', resource: 'community' }}
                    onAction={emojiRetryFilename ? () => void handleEmojiPick() : undefined}
                    actionLabel={emojiRetryFilename ? 'Choose image again' : undefined}
                    className="mt-3"
                    compact
                  />
                )}
                {emojiRetryFilename && (
                  <p id="community-emoji-retry" className="mt-2 text-xs text-secondary">
                    {emojiRetryFilename} was not uploaded. Choose the image again to retry.
                  </p>
                )}
                {emojiNotice && (
                  <p role="status" className="mt-3 flex items-center gap-2 text-xs text-status-success">
                    <Icon name="check" size="xs" />
                    {emojiNotice}
                  </p>
                )}
                <div className="mt-4 flex justify-end">
                  <Button
                    onClick={handleEmojiUpload}
                    disabled={
                      !emojiShortcode.trim()
                      || !emojiGrant
                      || Boolean(emojiNameError)
                      || Boolean(emojiGrantError)
                      || emojiBusy != null
                      || serverEmoji.length >= MAX_CUSTOM_EMOJI_COUNT
                    }
                  >
                    {emojiBusy === 'upload' ? 'Adding…' : 'Add emoji'}
                  </Button>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between gap-3 border-b border-border-subtle pb-2">
                <div>
                  <h4 className="text-sm font-semibold text-primary">Current library</h4>
                  <p className="mt-0.5 text-xs text-muted">Use a name in colons to add an emoji to a message.</p>
                </div>
                <span className="font-mono text-meta text-muted">{serverEmoji.length} / {MAX_CUSTOM_EMOJI_COUNT}</span>
              </div>

              {emojiLoading && serverEmoji.length === 0 ? (
                <p role="status" className="py-6 text-center text-xs text-muted">Loading community emoji…</p>
              ) : serverEmoji.length === 0 ? (
                <div className="mt-3 rounded-panel border border-border-subtle bg-surface-sunken px-4 py-6 text-center">
                  <Icon name="smile" size="lg" className="mx-auto text-muted" />
                  <p className="mt-3 text-sm font-semibold text-primary">No community emoji yet</p>
                  <p className="mt-1 text-xs text-muted">Add the first image to start a shared library.</p>
                </div>
              ) : (
                <div className="grid gap-3 py-3 md:grid-cols-2">
                  {serverEmoji.map((emoji) => (
                    <article key={emoji.shortcode} className="rounded-panel border border-border-subtle bg-surface-sunken p-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-control border border-border-subtle bg-surface-base p-2">
                          {emoji.imageUrl ? (
                            <img
                              src={emoji.imageUrl}
                              alt=""
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <Icon name="image" size="sm" className="text-muted" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-sm font-medium text-primary">:{emoji.shortcode}:</p>
                          <p className="mt-0.5 text-xs text-muted">{emoji.width} × {emoji.height} · {Math.ceil(emoji.sizeBytes / 1024)} KB</p>
                        </div>
                        {emojiPendingRemoval !== emoji.shortcode && (
                          <IconButton
                            id={`community-emoji-remove-${emoji.shortcode}`}
                            onClick={() => setEmojiPendingRemoval(emoji.shortcode)}
                            disabled={emojiBusy != null}
                            aria-label={`Remove ${emoji.shortcode} emoji`}
                            aria-expanded={false}
                            aria-controls={`community-emoji-remove-confirm-${emoji.shortcode}`}
                            tone="danger"
                          >
                            <Icon name="x" size="sm" />
                          </IconButton>
                        )}
                      </div>
                      {emojiPendingRemoval === emoji.shortcode && (
                        <div
                          id={`community-emoji-remove-confirm-${emoji.shortcode}`}
                          role="group"
                          aria-labelledby={`community-emoji-remove-question-${emoji.shortcode}`}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape' && emojiBusy == null) {
                              event.preventDefault()
                              cancelEmojiRemoval(emoji.shortcode)
                            }
                          }}
                          className="mt-3 border-t border-border-subtle pt-3"
                        >
                          <p id={`community-emoji-remove-question-${emoji.shortcode}`} className="text-xs leading-5 text-secondary">Remove :{emoji.shortcode}: for everyone in {community.name}?</p>
                          <div className="mt-3 flex justify-end gap-2">
                            <Button
                              autoFocus
                              size="sm"
                              variant="secondary"
                              onClick={() => cancelEmojiRemoval(emoji.shortcode)}
                              disabled={emojiBusy != null}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              tone="danger"
                              onClick={() => void handleEmojiRemove(emoji.shortcode)}
                              disabled={emojiBusy != null}
                            >
                              {emojiBusy === emoji.shortcode ? 'Removing…' : 'Remove'}
                            </Button>
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          {matrixMode && isOwnerOrAdmin && sectionVisible('moderation') && (
            <section id="community-settings-moderation" tabIndex={-1} aria-labelledby="community-settings-moderation-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <div className="rounded-panel border border-border-subtle bg-surface-raised p-4">
                <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">Verified scope</p>
                <h3 id="community-settings-moderation-heading" className="mt-1 text-title font-semibold tracking-tight text-primary">
                  Moderation outcomes
                </h3>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                  When an administrator takes action, Mesh reports which rooms confirmed it and which need attention.
                </p>

                <div className="mt-4 flex items-start gap-3 rounded-panel border border-border-subtle bg-surface-sunken p-4">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-panel bg-accent/10 text-accent">
                    <Icon name="shieldCheck" size="sm" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-primary">Action confirmation, not an administrator history</h4>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      Mesh does not currently provide an authoritative administrator-action history. It cannot prove a complete, tamper-resistant record across every compatible service.
                    </p>
                    <p className="mt-2 text-xs leading-5 text-secondary">
                      Live moderation results only confirm per-room outcomes at the time of the action. Unverified events are never presented as an audit log.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between gap-3 border-b border-border-subtle pb-2">
                <div>
                  <h4 className="text-sm font-semibold text-primary">Recent confirmed outcomes</h4>
                  <p className="mt-0.5 text-xs text-muted">Room-by-room results returned when an action finishes.</p>
                </div>
                <span className="font-mono text-meta text-muted">{moderationAudit.length} available</span>
              </div>

              <div className="space-y-3 py-3">
                {moderationAuditError != null && (
                  <ErrorState
                    error={moderationAuditError}
                    context={{ operation: 'load moderation activity', resource: 'community' }}
                    compact
                  />
                )}
                {moderationAuditError == null && moderationAudit.length === 0 && (
                  <div className="rounded-panel border border-border-subtle bg-surface-sunken px-4 py-6 text-center">
                    <Icon name="activity" size="lg" className="mx-auto text-muted" />
                    <p className="mt-3 text-sm font-semibold text-primary">No confirmed outcomes available</p>
                    <p className="mt-1 text-xs text-muted">Completed actions show their immediate room-by-room result before you leave the moderation flow.</p>
                  </div>
                )}
                {moderationAudit.map((entry) => {
                  const failures = entry.roomOutcomes.filter((outcome) => !outcome.succeeded)
                  const succeeded = entry.roomOutcomes.length - failures.length
                  return (
                    <article key={entry.id} className="rounded-panel border border-border-subtle bg-surface-sunken p-4">
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

          {/* Rooms and room creation */}
          {isOwnerOrAdmin && sectionVisible('rooms-voice') && (
            <section id="community-settings-rooms" tabIndex={-1} aria-labelledby="community-settings-rooms-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <div className="rounded-panel border border-border-subtle bg-surface-raised p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">Community spaces</p>
                    <h3 id="community-settings-rooms-heading" className="mt-1 text-title font-semibold tracking-tight text-primary">
                      Rooms and voice
                    </h3>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                      Give every conversation a clear home. New rooms appear in the community navigation for everyone who can access them.
                    </p>
                  </div>
                  <Button
                    onClick={() => setShowCreateChannel(!showCreateChannel)}
                    variant={showCreateChannel ? 'solid' : 'primary'}
                    size="sm"
                    className="flex-shrink-0"
                    aria-expanded={showCreateChannel}
                  >
                    <Icon name={showCreateChannel ? 'x' : 'plus'} size="xs" />
                    {showCreateChannel ? 'Cancel' : 'Create room'}
                  </Button>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-3">
                    <div className="flex items-center gap-2 text-accent">
                      <Icon name="hash" size="sm" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Text rooms</span>
                    </div>
                    <p className="mt-2 font-mono text-title font-semibold text-primary">{textChannels.length}</p>
                    <p className="mt-1 text-xs text-muted">For updates, projects, and everyday conversation.</p>
                  </div>
                  <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-3">
                    <div className="flex items-center gap-2 text-accent">
                      <Icon name="volume" size="sm" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Voice rooms</span>
                    </div>
                    <p className="mt-2 font-mono text-title font-semibold text-primary">{voiceChannels.length}</p>
                    <p className="mt-1 text-xs text-muted">
                      {matrixMode && !matrixVoiceReady
                        ? VOICE_COMING_SOON_DETAIL
                        : 'For live conversation when the community is ready.'}
                    </p>
                  </div>
                </div>
              </div>

              <AnimatePresence>
                {showCreateChannel && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={transitions.enter}
                    className="mt-4 overflow-hidden"
                  >
                    <div className="rounded-panel border border-border-subtle bg-surface-sunken p-4">
                      <div className="mb-4 flex items-start gap-3">
                        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-panel bg-accent/10 text-accent">
                          <Icon name="plus" size="sm" />
                        </span>
                        <div className="min-w-0">
                          <h4 className="text-sm font-semibold text-primary">Create a room</h4>
                          <p className="mt-1 text-xs leading-5 text-muted">
                            Start with a short, recognizable name. You can manage the room from its menu after creation.
                          </p>
                        </div>
                      </div>

                      <Input
                        label="Room name"
                        value={channelName}
                        onChange={(value: string) => {
                          setChannelName(value)
                          setChannelError(null)
                        }}
                        placeholder="announcements"
                        maxLength={CHANNEL_NAME_MAX_LENGTH}
                        hint={metadataCharactersRemaining(channelName, CHANNEL_NAME_MAX_LENGTH)}
                        error={channelNameError}
                        autoFocus
                      />

                      <fieldset className="mt-4">
                        <legend className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted">
                          Room type
                        </legend>
                        <div className="grid grid-cols-2 gap-2">
                          <Button
                            onClick={() => setChannelType('text')}
                            variant={channelType === 'text' ? 'soft' : 'outline'}
                            tone={channelType === 'text' ? 'accent' : 'neutral'}
                            className="min-h-11 justify-start"
                            aria-pressed={channelType === 'text'}
                          >
                            <Icon name="hash" size="sm" />
                            Text room
                          </Button>
                          {matrixMode && !matrixVoiceReady ? (
                            <div
                              aria-disabled="true"
                              className="flex min-h-11 items-center gap-2 rounded-control border border-border-subtle bg-surface-base px-3 text-xs text-muted"
                            >
                              <Icon name="volume" size="sm" />
                              {VOICE_COMING_SOON_TITLE}
                            </div>
                          ) : (
                            <Button
                              onClick={() => setChannelType('voice')}
                              variant={channelType === 'voice' ? 'soft' : 'outline'}
                              tone={channelType === 'voice' ? 'accent' : 'neutral'}
                              className="min-h-11 justify-start"
                              aria-pressed={channelType === 'voice'}
                            >
                              <Icon name="volume" size="sm" />
                              Voice room
                            </Button>
                          )}
                        </div>
                        {matrixMode && !matrixVoiceReady && (
                          <p className="mt-2 text-xs leading-5 text-muted">
                            Voice room creation returns automatically when private calling is ready.
                          </p>
                        )}
                      </fieldset>

                      {channelError != null ? (
                        <ErrorState
                          error={channelError}
                          context={{ operation: 'create the room', resource: 'community' }}
                          className="mt-4"
                          compact
                        />
                      ) : null}

                      <div className="mt-4 flex justify-end">
                        <Button
                          onClick={handleCreateChannel}
                          disabled={!channelName.trim() || Boolean(channelNameError) || isCreatingChannel}
                        >
                          {isCreatingChannel ? 'Creating…' : 'Create room'}
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="mt-5 flex items-center justify-between gap-3 border-b border-border-subtle pb-2">
                <div>
                  <h4 className="text-sm font-semibold text-primary">Current rooms</h4>
                  <p className="mt-0.5 text-xs text-muted">Use each room's menu in the navigation to manage it.</p>
                </div>
                <span className="font-mono text-meta text-muted">{communityChannels.length} total</span>
              </div>

              {communityChannels.length === 0 ? (
                <div className="rounded-panel border border-border-subtle bg-surface-sunken px-4 py-6 text-center">
                  <Icon name="hash" size="lg" className="mx-auto text-muted" />
                  <p className="mt-3 text-sm font-semibold text-primary">No rooms yet</p>
                  <p className="mt-1 text-xs text-muted">Create the first room to give this community a place to talk.</p>
                </div>
              ) : (
                <div className="grid gap-3 py-3 md:grid-cols-2">
                  <RoomInventoryGroup
                    title="Text rooms"
                    icon="hash"
                    channels={textChannels}
                    emptyCopy="No text rooms yet."
                  />
                  <RoomInventoryGroup
                    title="Voice rooms"
                    icon="volume"
                    channels={voiceChannels}
                    emptyCopy="No voice rooms yet."
                  />
                </div>
              )}
            </section>
          )}

          {/* Danger zone */}
          {sectionVisible('danger') && <section id="community-settings-danger" tabIndex={-1} aria-labelledby="community-settings-danger-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            <div className="rounded-panel border border-border-subtle bg-surface-raised p-4">
              <p className="text-caption font-semibold uppercase tracking-eyebrow text-status-danger">Sensitive controls</p>
              <h3 id="community-settings-danger-heading" className="mt-1 text-title font-semibold tracking-tight text-primary">
                Ownership and leaving
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                Mesh shows an exit only when it can explain the consequence and verify that your role allows it.
              </p>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-3">
                  <div className="flex items-center gap-2 text-status-danger">
                    <Icon name="users" size="sm" />
                    <span className="text-xs font-semibold uppercase tracking-wide">Your role</span>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-primary">
                    {isOwner ? 'Community owner' : community.role === 'admin' ? 'Administrator' : 'Member'}
                  </p>
                  <p className="mt-1 text-xs text-muted">Current permissions come from {community.name}.</p>
                </div>
                <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-3">
                  <div className="flex items-center gap-2 text-status-danger">
                    <Icon name={matrixMode && isOwner ? 'lock' : 'triangleAlert'} size="sm" />
                    <span className="text-xs font-semibold uppercase tracking-wide">Exit state</span>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-primary">
                    {matrixMode && isOwner ? 'Locked for safety' : 'Available after review'}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {matrixMode && isOwner ? 'Mesh will not leave the community ownerless.' : 'A final confirmation is required before anything changes.'}
                  </p>
                </div>
              </div>
            </div>

            {matrixMode && isOwner ? (
              <div className="mt-4 rounded-panel border border-border-subtle bg-surface-sunken p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-panel bg-status-danger/5 text-status-danger">
                    <Icon name="shieldCheck" size="sm" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-primary">
                      You can&apos;t leave while you&apos;re the owner
                    </h4>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      Mesh doesn&apos;t support choosing a new owner yet. Until it does, this account
                      must remain in the community.
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-2 border-t border-border-subtle pt-4">
                  <p className="flex items-start gap-2 text-xs leading-5 text-secondary">
                    <Icon name="check" size="xs" className="mt-0.5 flex-shrink-0 text-status-success" />
                    Other members, rooms, and messages are unaffected.
                  </p>
                  <p className="flex items-start gap-2 text-xs leading-5 text-secondary">
                    <Icon name="check" size="xs" className="mt-0.5 flex-shrink-0 text-status-success" />
                    Nothing will be deleted or changed while the owner account stays.
                  </p>
                  <p className="flex items-start gap-2 text-xs leading-5 text-secondary">
                    <Icon name="check" size="xs" className="mt-0.5 flex-shrink-0 text-status-success" />
                    A future update will let you choose a new owner before leaving.
                  </p>
                </div>

                <p role="status" className="mt-4 flex items-center gap-2 rounded-control border border-border-subtle bg-surface-base px-3 py-2 text-xs font-medium text-muted">
                  <Icon name="lock" size="xs" />
                  This owner account must stay for now.
                </p>
              </div>
            ) : (
              <div className="mt-4 rounded-panel border border-border-subtle bg-surface-sunken p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-primary">
                      {!matrixMode && isOwner ? 'Close this local community' : 'Leave this community'}
                    </h4>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      {!matrixMode && isOwner
                        ? 'This legacy local action closes the community for its members. It does not describe compatible-service deletion.'
                        : `This account will leave ${community.name} and all ${communityChannels.length} of its rooms. Existing messages are not deleted.`}
                    </p>
                  </div>
                  {!showLeaveConfirm && (
                    <Button
                      onClick={() => {
                        setDangerError(null)
                        setShowLeaveConfirm(true)
                      }}
                      variant="outline"
                      tone="danger"
                      size="sm"
                      className="flex-shrink-0"
                    >
                      {matrixMode ? 'Leave Community' : isOwner ? 'Delete Community' : 'Leave Community'}
                    </Button>
                  )}
                </div>

                <AnimatePresence>
                  {showLeaveConfirm && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 4 }}
                      transition={transitions.enter}
                      className="mt-4 rounded-panel border border-status-danger/30 bg-status-danger/5 p-4"
                    >
                      <h5 className="text-sm font-semibold text-primary">
                        {!matrixMode && isOwner ? `Delete ${community.name}?` : `Leave ${community.name}?`}
                      </h5>
                      <p className="mt-1 text-xs leading-5 text-secondary">
                        {!matrixMode && isOwner
                          ? 'This closes the local community for every member and cannot be undone from this screen.'
                          : 'You will lose access to every room on this account. Leaving does not delete the community or messages already sent.'}
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
                          className="mt-3"
                          compact
                        />
                      ) : null}
                      <div className="mt-4 flex justify-end gap-2">
                        <Button
                          onClick={() => {
                            setShowLeaveConfirm(false)
                            setDangerError(null)
                          }}
                          variant="secondary"
                          size="sm"
                          disabled={dangerBusy}
                        >
                          Cancel
                        </Button>
                        <Button
                          onClick={matrixMode ? handleLeave : isOwner ? handleDelete : handleLeave}
                          tone="danger"
                          size="sm"
                          disabled={dangerBusy}
                        >
                          {dangerBusy ? 'Working…' : !matrixMode && isOwner ? 'Delete' : 'Leave'}
                        </Button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
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

function RoomInventoryGroup({
  title,
  icon,
  channels,
  emptyCopy,
}: {
  title: string
  icon: IconName
  channels: Channel[]
  emptyCopy: string
}) {
  return (
    <section aria-label={title} className="rounded-panel border border-border-subtle bg-surface-sunken p-3">
      <div className="flex items-center gap-2 border-b border-border-subtle pb-2">
        <Icon name={icon} size="sm" className="text-accent" />
        <h5 className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-secondary">{title}</h5>
        <span className="font-mono text-meta text-muted">{channels.length}</span>
      </div>
      {channels.length === 0 ? (
        <p className="px-2 py-4 text-center text-xs text-muted">{emptyCopy}</p>
      ) : (
        <ul className="space-y-1 pt-2">
          {channels.map((channel) => (
            <li key={channel.id} className="flex min-h-10 items-center gap-2 rounded-control px-2">
              <Icon name={icon} size="xs" className="flex-shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-secondary">{channel.name}</span>
              {channel.unreadCount > 0 ? (
                <span className="font-mono text-meta text-accent">{channel.unreadCount}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
