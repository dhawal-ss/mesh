import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion, AnimatePresence } from '../../lib/lazy-motion'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { Sheet } from '../ui/InteractivePrimitives'
import { Field, Textarea } from '../ui/Primitives'
import { Modal } from '../ui/Modal'
import { InviteModal } from './InviteModal'
import { MemberList } from './MemberList'
import { useActiveCommunity, useCommunityStore } from '../../store/communities'
import { useServerEmoji, useServerEmojiStore } from '../../store/custom-emoji'
import { useChannelStore } from '../../store/channels'
import {
  useBannedCommunityMembers,
  useCommunityMembers,
  useMembershipStore,
} from '../../store/membership'
import * as bridge from '../../lib/bridge'
import { motionOffsets, transitions } from '../../lib/motion'
import { shouldExposeVoiceRoutes } from '../../lib/voice-runtime'
import type {
  Channel,
  CommunityAccessSettings,
  CommunityApplication,
  CommunityJoinRule,
} from '../../types/ipc'
import { Icon, type IconName } from '../ui/Icon'
import { Avatar } from '../ui/Avatar'
import { pixelColorForSeed } from '../ui/PixelMark'
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
      description={`Manage ${communityName}.`}
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
  // The same predicate the navigation uses, so this screen and the sidebar agree.
  const voiceRoutesEnabled = shouldExposeVoiceRoutes(matrixMode, bridge.getBackendStatusSnapshot())
  const communityOrder = useCommunityStore((state) => state.communityOrder)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const removeCommunity = useCommunityStore((state) => state.removeCommunity)
  const setActiveCommunity = useCommunityStore((state) => state.setActiveCommunity)
  const patchCommunity = useCommunityStore((state) => state.patchCommunity)
  const channels = useChannelStore((state) => state.channels)
  const addChannel = useChannelStore((state) => state.addChannel)
  const clearCommunityMembership = useMembershipStore((s) => s.clearCommunity)
  const communityMembers = useCommunityMembers(activeCommunityId)
  // Banned accounts surface only here, where an administrator can lift the ban.
  const bannedMembers = useBannedCommunityMembers(activeCommunityId)
  const rosterWithBanned = useMemo(
    () => [...communityMembers, ...bannedMembers],
    [bannedMembers, communityMembers],
  )
  const serverEmoji = useServerEmoji(activeCommunityId)
  const refreshServerEmoji = useServerEmojiStore((state) => state.load)
  const [emojiShortcode, setEmojiShortcode] = useState('')
  const [emojiBusy, setEmojiBusy] = useState<string | null>(null)
  const [emojiError, setEmojiError] = useState<unknown>(null)

  const community = useActiveCommunity()
  const communityChannels = channels.filter((channel) => channel.communityId === activeCommunityId)
  const textChannels = communityChannels.filter((channel) => channel.channelType === 'text')
  const voiceChannels = communityChannels.filter((channel) => channel.channelType === 'voice')
  const listedChannels = voiceRoutesEnabled ? communityChannels : textChannels

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
  const [accessError, setAccessError] = useState<unknown | null>(null)
  const [accessNotice, setAccessNotice] = useState<string | null>(null)
  const [applications, setApplications] = useState<CommunityApplication[]>([])
  const [applicationBusy, setApplicationBusy] = useState<string | null>(null)
  /*
    The community's own access setting. matrix_community_access_settings was
    registered and permitted from the start but no surface ever read it, so an
    owner who picked "Approval required" at creation had no way to see what
    actually applied, and no way to change it afterwards.
  */
  const [accessSettings, setAccessSettings] = useState<CommunityAccessSettings | null>(null)
  const [accessSettingsBusy, setAccessSettingsBusy] = useState(false)
  /*
    Approving a join request grants access to everything in the community and
    cannot be undone from here. Removing a member, which is reversible, was
    already behind a confirmation while this was a single click on a card
    showing nothing but a display name the requester chose.
  */
  const [pendingApproval, setPendingApproval] = useState<CommunityApplication | null>(null)
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
  useEffect(() => {
    if (!isOpen || !matrixMode || !community || !activeCommunityId) return
    if (activeSection && activeSection !== 'discovery-access') return
    if (community.role !== 'owner' && community.role !== 'admin') return

    let cancelled = false
    bridge.getCommunityApplications(activeCommunityId)
      .then((pending) => {
        if (cancelled) return
        setApplications(pending)
        setAccessError(null)
        setAccessNotice(null)
      })
      .catch((error) => {
        if (!cancelled) {
          setAccessError(error)
        }
      })
    bridge.communityAccessSettings(activeCommunityId)
      .then((settings) => {
        if (!cancelled) setAccessSettings(settings)
      })
      .catch((error) => {
        if (!cancelled) setAccessError(error)
      })

    /*
      A knock arrives while nobody is looking at this panel, and the list was
      fetched once on mount with no refetch, poll, or revalidation: someone who
      left the settings sheet open saw an empty queue indefinitely.
    */
    const revalidate = () => {
      if (document.visibilityState !== 'visible') return
      bridge.getCommunityApplications(activeCommunityId)
        .then((pending) => {
          if (!cancelled) setApplications(pending)
        })
        .catch(() => {
          // A failed background refresh must not replace what is on screen with
          // an error; the list simply stays as it was until the next attempt.
        })
    }
    window.addEventListener('focus', revalidate)
    document.addEventListener('visibilitychange', revalidate)

    return () => {
      cancelled = true
      window.removeEventListener('focus', revalidate)
      document.removeEventListener('visibilitychange', revalidate)
    }
  }, [activeCommunityId, activeSection, community, isOpen, matrixMode])

  const handleAccessChange = async (joinRule: CommunityJoinRule) => {
    if (!activeCommunityId || !accessSettings || accessSettings.joinRule === joinRule) return
    setAccessSettingsBusy(true)
    setAccessError(null)
    setAccessNotice(null)
    try {
      /*
        The alias and directory listing are carried through untouched: this
        control changes who may join, not whether the community is published.
      */
      const updated = await bridge.updateCommunityAccess(
        activeCommunityId,
        accessSettings.alias ?? '',
        accessSettings.discoverable,
        joinRule,
      )
      setAccessSettings(updated)
      setAccessNotice(
        updated.joinRule === 'knock'
          ? 'People can now request access and wait for an administrator.'
          : 'People can now join only from an invitation.',
      )
    } catch (error) {
      setAccessError(error)
    } finally {
      setAccessSettingsBusy(false)
    }
  }

  const iconInputRef = useRef<HTMLInputElement>(null)
  const [iconBusy, setIconBusy] = useState(false)
  const [iconError, setIconError] = useState<unknown | null>(null)
  const [iconNotice, setIconNotice] = useState<string | null>(null)

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
          { id: 'community-settings-access', label: 'Join requests', keywords: 'applications approval authority' },
          { id: 'community-settings-moderation', label: 'Moderation activity', keywords: 'authority actions outcomes' },
        ]
      : []),
    ...(isOwnerOrAdmin
      ? [{ id: 'community-settings-rooms', label: 'Rooms', keywords: 'create text voice channel' }]
      : []),
    ...(matrixMode && isOwnerOrAdmin
      ? [{ id: 'community-settings-emoji', label: 'Custom emoji', keywords: 'expression reactions shortcode' }]
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

  const handleEmojiUpload = async () => {
    const shortcode = emojiShortcode.trim()
    if (!activeCommunityId || !shortcode || emojiBusy) return
    setEmojiBusy('upload')
    setEmojiError(null)
    try {
      const grant = await bridge.pickCustomEmojiGrant(activeCommunityId)
      // A null grant means the native picker was dismissed; that is not an error.
      if (!grant) return
      await bridge.uploadServerEmoji(activeCommunityId, shortcode, grant.grant)
      await bridge.matrixSyncOnce()
      await refreshServerEmoji(activeCommunityId, true)
      setEmojiShortcode('')
    } catch (error) {
      setEmojiError(error)
    } finally {
      setEmojiBusy(null)
    }
  }

  const handleEmojiRemove = async (shortcode: string) => {
    if (!activeCommunityId || emojiBusy) return
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

  /*
    The community icon applies on choice rather than on Save.

    Name and description share a dirty-state badge and one Save button; an
    image does not belong in that model, because there is nothing to review
    between choosing a file and seeing the result, and holding an uploaded
    image as pending state would mean the badge claiming unsaved changes for
    something already sanitised and bounded. This mirrors the personal profile
    picture, which applies on choice for the same reason.
  */
  const chooseCommunityIcon = async (file: File) => {
    if (!activeCommunityId) return
    setIconBusy(true)
    setIconError(null)
    setIconNotice(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const avatarUrl = await bridge.matrixSetCommunityIcon(
        activeCommunityId,
        file.name,
        file.type,
        bytes,
      )
      // Patch the store the way handleSaveMetadata does, so the rail and the
      // summary card show it without waiting for the next sync. Avatar resolves
      // the mxc address, so this displays the sanitized bytes the room now
      // carries rather than the local file that was picked.
      patchCommunity(activeCommunityId, { avatarUrl })
      setIconNotice('Community image updated.')
    } catch (error) {
      setIconError(error)
    } finally {
      setIconBusy(false)
      // Without this, choosing the same file twice fires no change event.
      if (iconInputRef.current) iconInputRef.current.value = ''
    }
  }

  const removeCommunityIcon = async () => {
    if (!activeCommunityId) return
    setIconBusy(true)
    setIconError(null)
    setIconNotice(null)
    try {
      await bridge.matrixClearCommunityIcon(activeCommunityId)
      patchCommunity(activeCommunityId, { avatarUrl: null })
      setIconNotice('Community image removed.')
    } catch (error) {
      setIconError(error)
    } finally {
      setIconBusy(false)
    }
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

  return (
    <>
      <CommunitySettingsFrame
        embedded={embedded}
        isOpen={isOpen}
        onClose={onClose}
        communityName={community.name}
      >
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-5 py-6">
          {/* Community identity */}
          {sectionVisible('general') && <section
            id="community-settings-summary"
            tabIndex={-1}
            aria-labelledby="community-settings-summary-heading"
            className="mb-3 scroll-mt-4 rounded-xl border border-outline-variant bg-surface-container p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            <div className="flex items-start gap-4">
              <Avatar
                color={pixelColorForSeed(community.id)}
                size={48}
                name={community.name}
                imageUrl={community.avatarUrl}
                variant="community"
              />
              <div className="min-w-0 flex-1">
                <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">Community profile</p>
                <h3 id="community-settings-summary-heading" className="mt-1 truncate text-title-sm font-semibold text-on-surface">{community.name}</h3>
                <p className="member-count mt-1 text-body-sm text-on-surface-variant">
                  {communityRoleLabel} · {community.memberCount} member{community.memberCount !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
            {community.description && (
              <p className="mt-2 max-w-2xl text-body-md text-on-surface-variant">{community.description}</p>
            )}

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {/*
                Tinted rows inside an already-bordered, already-tinted card were
                drawing a border of their own, so a settings section spent three
                nested outlines to show two facts. The sunken tint against the
                raised card is the separation; the border was the level to lose.
              */}
              <div className="rounded-full bg-surface-container-lowest px-3 py-2">
                <div className="flex items-center gap-2 text-primary">
                  <Icon name="shieldCheck" size="sm" />
                  <span className="text-label-sm font-semibold lowercase tracking-label-md">Your role</span>
                </div>
                <p className="mt-1.5 text-body-md font-semibold text-on-surface">{communityRoleLabel}</p>
              </div>
              <div className="rounded-full bg-surface-container-lowest px-3 py-2">
                <div className="flex items-center gap-2 text-primary">
                  <Icon name="users" size="sm" />
                  <span className="text-label-sm font-semibold lowercase tracking-label-md">People</span>
                </div>
                <p className="mt-1.5 text-body-md font-semibold text-on-surface">
                  {community.memberCount} member{community.memberCount !== 1 ? 's' : ''}
                </p>
              </div>
              <div className="rounded-full bg-surface-container-lowest px-3 py-2">
                <div className="flex items-center gap-2 text-primary">
                  <Icon name="activity" size="sm" />
                  <span className="text-label-sm font-semibold lowercase tracking-label-md">Community service</span>
                </div>
                <p className="mt-1.5 truncate text-body-md font-semibold text-on-surface">{communityService}</p>
              </div>
            </div>

          </section>}

          {/* Invite */}
          {!embedded && sectionVisible('invitations') && <section
            id="community-settings-invitations"
            tabIndex={-1}
            aria-labelledby="community-settings-invitations-heading"
            className="mb-4 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            <h3 id="community-settings-invitations-heading" className="sr-only">Invitations</h3>
            <Button onClick={() => setShowInvite(true)} className="w-full" variant="secondary">
              <span className="flex items-center gap-2">
                <Icon name="userPlus" size="sm" />
                Invite people
              </span>
            </Button>
          </section>}

          {!embedded && <div className="mb-6 rounded-xl border border-outline-variant bg-surface-container-lowest p-3">
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
              <p role="status" className="mt-3 text-body-sm text-on-surface-variant">
                Try a different settings search.
              </p>
            )}
          </div>}

          {isOwnerOrAdmin && sectionVisible('general') && (
            <section
              id="community-settings-overview"
              tabIndex={-1}
              aria-labelledby="community-settings-overview-heading"
              className="mb-6 scroll-mt-4 rounded-xl border border-outline-variant bg-surface-container-lowest focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              <div className="flex flex-col items-stretch gap-3 border-b border-outline-variant px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container">
                    <Icon name="squarePen" size="sm" />
                  </div>
                  <div>
                    <h3 id="community-settings-overview-heading" className="text-title-sm font-semibold text-on-surface">Public details</h3>
                  </div>
                </div>
                <div
                  className={`flex flex-shrink-0 self-start items-center gap-1.5 rounded-full border px-2.5 py-1 text-body-sm font-semibold ${
                    metadataDirty
                      ? 'border-primary-container-line bg-primary-container text-on-primary-container'
                      : 'border-outline-variant bg-surface-container text-on-surface-variant'
                  }`}
                >
                  <Icon name={metadataDirty ? 'squarePen' : 'check'} size="xs" />
                  {metadataDirty ? 'Unsaved' : 'Up to date'}
                </div>
              </div>

              <div className="space-y-3 p-3">
                {matrixMode && (
                  <div className="space-y-2 border-b border-outline-variant pb-3">
                    <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">
                      Community image
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      <Avatar
                        color={pixelColorForSeed(community.id)}
                        size={48}
                        name={community.name}
                        imageUrl={community.avatarUrl}
                        variant="community"
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={iconBusy}
                          onClick={() => iconInputRef.current?.click()}
                        >
                          {iconBusy ? 'Working...' : community.avatarUrl ? 'Replace image' : 'Choose image'}
                        </Button>
                        {community.avatarUrl ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={iconBusy}
                            onClick={() => void removeCommunityIcon()}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </div>
                      <input
                        ref={iconInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="sr-only"
                        aria-label="Choose a community image"
                        onChange={(event) => {
                          const file = event.target.files?.[0]
                          if (file) void chooseCommunityIcon(file)
                        }}
                      />
                    </div>
                    {/*
                      The disclosure is permanent, not a placeholder for the
                      success notice. Routing both through one element would
                      remove "everyone who can see this community can see the
                      image" at the exact moment it starts being true, which is
                      the moment it matters. Same split as the personal profile
                      picture.
                    */}
                    <p className="text-body-sm text-on-surface-variant">
                      PNG, JPEG or WebP up to 1 MB. Everyone who can see this community can see the image.
                    </p>
                    {iconNotice ? (
                      <p role="status" className="flex items-center gap-2 text-body-sm text-primary">
                        <Icon name="check" size="xs" />
                        {iconNotice}
                      </p>
                    ) : null}
                    {iconError != null ? (
                      <ErrorState
                        error={iconError}
                        context={{ operation: 'change the community image', resource: 'community' }}
                        compact
                      />
                    ) : null}
                  </div>
                )}
                <Input
                  label="Community name"
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

              <div className="sticky bottom-0 z-sticky flex min-h-12 flex-col items-stretch gap-2 border-t border-outline-variant bg-surface-container px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0 text-body-sm text-on-surface-variant" aria-live="polite">
                  {metadataNotice ? (
                    <p role="status" className="flex items-center gap-2 text-primary">
                      <Icon name="check" size="xs" />
                      {metadataNotice}
                    </p>
                  ) : (
                    metadataDirty ? <p>Review your changes before saving.</p> : null
                  )}
                </div>
                <Button
                  onClick={handleSaveMetadata}
                  disabled={!communityName.trim() || hasInvalidCommunityMetadata || isSavingMetadata || !metadataDirty}
                  className="w-full flex-shrink-0 sm:w-auto"
                >
                  <span className="flex items-center gap-2">
                    <Icon name="check" size="sm" />
                    {isSavingMetadata ? 'Saving…' : 'Save changes'}
                  </span>
                </Button>
              </div>

              {metadataError != null ? (
                <div className="border-t border-outline-variant p-4">
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
              className="mb-6 flex min-h-0 flex-1 flex-col scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            >
              <div className="rounded-xl border border-outline-variant bg-surface-container p-3">
                <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">Community people</p>
                <h3 id="community-settings-people-heading" className="mt-1 text-title-sm font-semibold text-on-surface">
                  People and roles
                </h3>

                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="rounded-full bg-surface-container-lowest px-3 py-2">
                    <div className="flex items-center gap-2 text-primary">
                      <Icon name="users" size="sm" />
                      <span className="text-label-sm font-semibold lowercase tracking-label-md">Membership</span>
                    </div>
                    <p className="mt-1.5 text-body-md font-semibold text-on-surface">
                      {community.memberCount} people
                    </p>
                  </div>
                  <div className="rounded-full bg-surface-container-lowest px-3 py-2">
                    <div className="flex items-center gap-2 text-primary">
                      <Icon name="activity" size="sm" />
                      <span className="text-label-sm font-semibold lowercase tracking-label-md">Online now</span>
                    </div>
                    <p className="mt-1.5 text-body-md font-semibold text-on-surface">{onlineMemberCount} available</p>
                  </div>
                  <div className="rounded-full bg-surface-container-lowest px-3 py-2">
                    <div className="flex items-center gap-2 text-primary">
                      <Icon name="shieldCheck" size="sm" />
                      <span className="text-label-sm font-semibold lowercase tracking-label-md">Leadership</span>
                    </div>
                    <p className="mt-1.5 text-body-md font-semibold text-on-surface">
                      {leadershipCount} verified role{leadershipCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>

                <div className="mt-2 flex items-start gap-3 rounded-full border border-outline-variant bg-surface-container-lowest px-3 py-2">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container">
                    <Icon name="shieldCheck" size="sm" />
                  </div>
                  <div>
                    <p className="text-body-md font-semibold text-on-surface">Verified actions only</p>
                    <p className="mt-1 text-body-sm text-on-surface-variant">
                      Membership and moderation actions confirm before they run.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
                <div className="flex items-center justify-between gap-4 border-b border-outline-variant bg-surface-container px-4 py-3">
                  <div>
                    <h4 className="text-body-md font-semibold text-on-surface">Current roster</h4>
                    <p className="mt-0.5 text-body-sm text-on-surface-variant">Search by display name or full account address.</p>
                  </div>
                  <p className="flex-shrink-0 text-body-sm text-on-surface-variant">
                    {communityMembers.length} in the community
                  </p>
                </div>
                <MemberList
                  embedded
                  isOpen
                  onClose={() => {}}
                  members={rosterWithBanned.map((member) => ({
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
            <section id="community-settings-access" tabIndex={-1} aria-labelledby="community-settings-access-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
              <div className="rounded-xl border border-outline-variant bg-surface-container p-4">
                <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">Community access</p>
                <h3 id="community-settings-access-heading" className="mt-1 text-title-sm font-semibold text-on-surface">
                  Join requests
                </h3>
              </div>

              {accessError != null && (
                <ErrorState
                  error={accessError}
                  context={{ operation: 'review join requests', resource: 'community' }}
                  className="mt-4"
                  compact
                />
              )}
              {accessNotice && (
                <p role="status" className="mt-4 flex items-center gap-2 text-body-sm text-primary">
                  <Icon name="check" size="xs" />
                  {accessNotice}
                </p>
              )}

              <div className="mt-5 border-b border-outline-variant pb-2">
                <h4 className="text-body-md font-semibold text-on-surface">Who can join</h4>
                <p className="mt-0.5 text-body-sm text-on-surface-variant">
                  Changing this does not publish the community anywhere.
                </p>
              </div>
              {accessSettings ? (
                <fieldset className="mt-3" disabled={accessSettingsBusy}>
                  <legend className="sr-only">Who can join {community.name}</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {([
                      ['invite', 'Invitation only'],
                      ['knock', 'Approval required'],
                    ] as const).map(([value, label]) => (
                      <label
                        key={value}
                        className={`cursor-pointer rounded-lg border px-3 py-3 has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-focus ${
                          accessSettings.joinRule === value
                            ? 'border-primary bg-secondary-container'
                            : 'border-outline-variant bg-surface-container-lowest'
                        }`}
                      >
                        <input
                          type="radio"
                          name="community-join-rule"
                          className="sr-only"
                          value={value}
                          checked={accessSettings.joinRule === value}
                          onChange={() => void handleAccessChange(value)}
                        />
                        <span className="block text-body-md font-semibold text-on-surface">{label}</span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-body-sm text-on-surface-variant">
                    {accessSettings.discoverable
                      ? `Listed in the account service directory as ${accessSettings.alias ?? 'its published address'}.`
                      : 'Not listed in any directory.'}
                  </p>
                </fieldset>
              ) : (
                <p className="mt-3 text-body-sm text-on-surface-variant">Checking who can join.</p>
              )}

              <div className="mt-5 flex items-center justify-between gap-3 border-b border-outline-variant pb-2">
                <div>
                  <h4 className="text-body-md font-semibold text-on-surface">Pending requests</h4>
                </div>
                <span className="text-body-sm text-on-surface-variant">{applications.length} waiting</span>
              </div>

              {applications.length === 0 ? (
                <div className="mt-3 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-6 text-center">
                  <Icon name="userPlus" size="lg" className="mx-auto text-on-surface-variant" />
                  <p className="mt-3 text-body-md font-semibold text-on-surface">No pending requests</p>
                </div>
              ) : (
                <div className="grid gap-3 py-3 md:grid-cols-2">
                  {applications.map((application) => (
                    <article key={application.userId} className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
                      <div className="flex items-center gap-3">
                        <Avatar
                          name={application.displayName}
                          color={pixelColorForSeed(application.userId)}
                          size={32}
                        />
                        {/*
                          The display name is chosen by the requester and can be
                          anyone's. Approving on that alone is how an
                          administrator lets in someone impersonating a member,
                          so the account address, which cannot be forged, is
                          shown beside it.
                        */}
                        <div className="min-w-0">
                          <p className="truncate text-body-md font-semibold text-on-surface">{application.displayName}</p>
                          <p className="truncate text-body-sm text-on-surface-variant">{application.userId}</p>
                        </div>
                      </div>
                      {application.reason && (
                        <p className="mt-3 text-body-sm text-on-surface-variant">“{application.reason}”</p>
                      )}
                      {application.requestedAt && (
                        <p className="mt-2 text-body-sm text-on-surface-variant">
                          Requested {new Date(application.requestedAt).toLocaleString()}
                        </p>
                      )}
                      <div className="mt-4 flex gap-2">
                        <Button
                          onClick={() => setPendingApproval(application)}
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

          {matrixMode && isOwnerOrAdmin && sectionVisible('moderation') && (
            <section id="community-settings-moderation" tabIndex={-1} aria-labelledby="community-settings-moderation-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
              <div className="rounded-xl border border-outline-variant bg-surface-container p-4">
                <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">Verified scope</p>
                <h3 id="community-settings-moderation-heading" className="mt-1 text-title-sm font-semibold text-on-surface">
                  Moderation outcomes
                </h3>

                <div className="mt-4 flex items-start gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-primary-container text-on-primary-container">
                    <Icon name="shieldCheck" size="sm" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-body-md font-semibold text-on-surface">Review each moderation result</h4>
                    <p className="mt-1 text-body-sm text-on-surface-variant">
                      Mesh does not keep a complete administrator-action history across every account service.
                    </p>
                    <p className="mt-2 text-body-sm text-on-surface-variant">
                      The result shows what changed in each room.
                    </p>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Rooms and room creation */}
          {isOwnerOrAdmin && sectionVisible('rooms-voice') && (
            <section id="community-settings-rooms" tabIndex={-1} aria-labelledby="community-settings-rooms-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
              <div className="rounded-xl border border-outline-variant bg-surface-container p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">Community spaces</p>
                    <h3 id="community-settings-rooms-heading" className="mt-1 text-title-sm font-semibold text-on-surface">
                      Rooms and voice
                    </h3>
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

                <div className={`mt-4 grid gap-3 ${voiceRoutesEnabled ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  <div className="rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-3">
                    <div className="flex items-center gap-2 text-primary">
                      <Icon name="hash" size="sm" />
                      <span className="text-label-sm font-semibold lowercase tracking-label-md">Text rooms</span>
                    </div>
                    <p className="mt-2 text-body-lg font-semibold text-on-surface">{textChannels.length}</p>
                  </div>
                  {voiceRoutesEnabled && (
                    <div className="rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-3">
                      <div className="flex items-center gap-2 text-primary">
                        <Icon name="volume" size="sm" />
                        <span className="text-label-sm font-semibold lowercase tracking-label-md">Voice rooms</span>
                      </div>
                      <p className="mt-2 text-body-lg font-semibold text-on-surface">{voiceChannels.length}</p>
                    </div>
                  )}
                </div>
              </div>

              <AnimatePresence>
                {showCreateChannel && (
                  <motion.div
                    initial={{ opacity: 0, y: -motionOffsets.tight }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -motionOffsets.tight }}
                    transition={transitions.enter}
                    className="mt-4 overflow-hidden"
                  >
                    <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
                      <div className="mb-4 flex items-start gap-3">
                        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-primary-container text-on-primary-container">
                          <Icon name="plus" size="sm" />
                        </span>
                        <div className="min-w-0">
                          <h4 className="text-body-md font-semibold text-on-surface">Create a room</h4>
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
                        <legend className="mb-2 block text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">
                          Room type
                        </legend>
                        <div className={`grid gap-2 ${voiceRoutesEnabled ? 'grid-cols-2' : 'grid-cols-1'}`}>
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
                          {voiceRoutesEnabled && (
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

              <div className="mt-5 flex items-center justify-between gap-3 border-b border-outline-variant pb-2">
                <div>
                  <h4 className="text-body-md font-semibold text-on-surface">Current rooms</h4>
                  <p className="mt-0.5 text-body-sm text-on-surface-variant">Rename or remove a room from its menu in the navigation.</p>
                </div>
                <span className="text-body-sm text-on-surface-variant">{listedChannels.length} total</span>
              </div>

              {listedChannels.length === 0 ? (
                <div className="rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-6 text-center">
                  <Icon name="hash" size="lg" className="mx-auto text-on-surface-variant" />
                  <p className="mt-3 text-body-md font-semibold text-on-surface">Create the first room</p>
                </div>
              ) : (
                <div className={`grid gap-3 py-3${voiceRoutesEnabled ? ' md:grid-cols-2' : ''}`}>
                  <RoomInventoryGroup
                    title="Text rooms"
                    icon="hash"
                    channels={textChannels}
                    emptyCopy="No text rooms yet."
                  />
                  {voiceRoutesEnabled && (
                    <RoomInventoryGroup
                      title="Voice rooms"
                      icon="volume"
                      channels={voiceChannels}
                      emptyCopy="No voice rooms yet."
                    />
                  )}
                </div>
              )}
            </section>
          )}

          {/* Custom emoji lives with the rest of community identity and customization */}
          {matrixMode && isOwnerOrAdmin && sectionVisible('general') && (
            <section id="community-settings-emoji" tabIndex={-1} aria-labelledby="community-settings-emoji-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
              <div className="rounded-xl border border-outline-variant bg-surface-container p-4">
                <div className="min-w-0">
                  <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">Community expression</p>
                  <h3 id="community-settings-emoji-heading" className="mt-1 text-title-sm font-semibold text-on-surface">
                    Custom emoji
                  </h3>
                  <p className="mt-1 max-w-2xl text-body-md text-on-surface-variant">
                    Visible to everyone here and not end to end encrypted. PNG, JPEG or WebP up to 512 KB.
                  </p>
                </div>

                <div className="mt-4 flex flex-wrap items-end gap-3">
                  <div className="min-w-48 flex-1">
                    <Input
                      label="Emoji name"
                      value={emojiShortcode}
                      onChange={(value: string) => {
                        setEmojiShortcode(value)
                        setEmojiError(null)
                      }}
                      placeholder="party_parrot"
                      maxLength={32}
                    />
                  </div>
                  <Button
                    onClick={handleEmojiUpload}
                    variant="primary"
                    size="sm"
                    className="flex-shrink-0"
                    disabled={!emojiShortcode.trim() || emojiBusy !== null}
                    loading={emojiBusy === 'upload'}
                  >
                    <Icon name="plus" size="xs" />
                    Add emoji
                  </Button>
                </div>

                {emojiError != null && (
                  <div className="mt-3">
                    <ErrorState
                      error={emojiError}
                      context={{ operation: 'update custom emoji', resource: 'community' }}
                      compact
                    />
                  </div>
                )}

                {serverEmoji.length > 0 && (
                  <ul className="mt-4 space-y-2">
                    {serverEmoji.map((emoji) => (
                      <li key={emoji.shortcode} className="flex items-center gap-3 rounded-full border border-outline-variant bg-surface-container-lowest px-3 py-2">
                        <img src={emoji.imageUrl} alt="" className="h-7 w-7 flex-shrink-0 object-contain" />
                        <span className="min-w-0 flex-1 truncate text-body-sm text-on-surface-variant">:{emoji.shortcode}:</span>
                        <button
                          type="button"
                          onClick={() => handleEmojiRemove(emoji.shortcode)}
                          disabled={emojiBusy !== null}
                          aria-label={`Remove custom emoji ${emoji.shortcode}`}
                          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
                        >
                          <Icon name="x" size="xs" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          {sectionVisible('danger') && <section id="community-settings-danger" tabIndex={-1} aria-labelledby="community-settings-danger-heading" className="mb-6 scroll-mt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
            <div className="rounded-xl border border-outline-variant bg-surface-container p-4">
              <p className="text-label-sm font-semibold lowercase tracking-label-md text-error">Sensitive controls</p>
              <h3 id="community-settings-danger-heading" className="mt-1 text-title-sm font-semibold text-on-surface">
                Ownership and leaving
              </h3>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-3">
                  <div className="flex items-center gap-2 text-error">
                    <Icon name="users" size="sm" />
                    <span className="text-label-sm font-semibold lowercase tracking-label-md">Your role</span>
                  </div>
                  <p className="mt-2 text-body-md font-semibold text-on-surface">
                    {isOwner ? 'Community owner' : community.role === 'admin' ? 'Administrator' : 'Member'}
                  </p>
                </div>
                <div className="rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-3">
                  <div className="flex items-center gap-2 text-error">
                    <Icon name={matrixMode && isOwner ? 'lock' : 'triangleAlert'} size="sm" />
                    <span className="text-label-sm font-semibold lowercase tracking-label-md">Exit state</span>
                  </div>
                  <p className="mt-2 text-body-md font-semibold text-on-surface">
                    {matrixMode && isOwner ? 'Locked for safety' : 'Available after review'}
                  </p>
                </div>
              </div>
            </div>

            {matrixMode && isOwner ? (
              <div className="mt-4 rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-error-container text-on-error-container">
                    <Icon name="shieldCheck" size="sm" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-body-md font-semibold text-on-surface">
                      You can&apos;t leave while you&apos;re the owner
                    </h4>
                    <p className="mt-1 text-body-sm text-on-surface-variant">
                      Mesh doesn&apos;t support choosing a new owner yet.
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-2 border-t border-outline-variant pt-4">
                  <p className="flex items-start gap-2 text-body-sm text-on-surface-variant">
                    <Icon name="check" size="xs" className="mt-0.5 flex-shrink-0 text-primary" />
                    Nothing will be deleted or changed while the owner account stays.
                  </p>
                </div>

                <p role="status" className="mt-4 flex items-center gap-2 rounded-full border border-outline-variant bg-surface px-3 py-2 text-body-sm font-medium text-on-surface-variant">
                  <Icon name="lock" size="xs" />
                  This owner account must stay for now.
                </p>
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h4 className="text-body-md font-semibold text-on-surface">
                      {!matrixMode && isOwner ? 'Close this local community' : 'Leave this community'}
                    </h4>
                    <p className="mt-1 text-body-sm text-on-surface-variant">
                      {!matrixMode && isOwner
                        ? 'Closes this local community for its members.'
                        : `This account will leave ${community.name} and all ${communityChannels.length} of its rooms.`}
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
                      {matrixMode ? 'Leave community' : isOwner ? 'Delete community' : 'Leave community'}
                    </Button>
                  )}
                </div>

                <AnimatePresence>
                  {showLeaveConfirm && (
                    <motion.div
                      initial={{ opacity: 0, y: motionOffsets.tight }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: motionOffsets.tight }}
                      transition={transitions.enter}
                      className="mt-4 rounded-xl border border-error-container-line bg-error-container p-4"
                    >
                      <h5 className="text-body-md font-semibold text-on-surface">
                        {!matrixMode && isOwner ? `Delete ${community.name}?` : `Leave ${community.name}?`}
                      </h5>
                      <p className="mt-1 text-body-sm text-on-surface-variant">
                        {!matrixMode && isOwner
                          ? 'This closes the local community for every member and cannot be undone from this screen.'
                          : 'You will lose access to every room on this account.'}
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
            && ['rooms-voice', 'discovery-access', 'moderation'].includes(activeSection) && (
              <section role="alert" className="rounded-xl border border-marker-container-line bg-marker-container p-4">
                <h3 className="text-title-sm font-semibold text-on-surface">Your community permissions changed</h3>
                <p className="mt-1 text-body-md text-on-surface-variant">
                  This section requires an owner or administrator role.
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

      {/*
        Approval is the irreversible half of this pair and was the unconfirmed
        one. Declining can be undone by approving a later request; approving
        grants access to every room in the community immediately.
      */}
      <Modal
        open={pendingApproval !== null}
        onClose={() => {
          if (applicationBusy != null) return
          setPendingApproval(null)
        }}
        title={pendingApproval ? `Approve ${pendingApproval.displayName}?` : 'Approve request'}
        description={pendingApproval
          ? `${pendingApproval.userId} gains immediate access to every room in ${community.name}, and removing them later does not undo what they read.`
          : undefined}
        size="sm"
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => setPendingApproval(null)}
            disabled={applicationBusy != null}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              const target = pendingApproval
              if (!target) return
              setPendingApproval(null)
              void handleApplication(target, true)
            }}
            disabled={applicationBusy != null}
          >
            Approve request
          </Button>
        </div>
      </Modal>
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
    <section aria-label={title} className="rounded-xl border border-outline-variant bg-surface-container-lowest p-3">
      <div className="flex items-center gap-2 border-b border-outline-variant pb-2">
        <Icon name={icon} size="sm" className="text-primary" />
        <h5 className="min-w-0 flex-1 text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">{title}</h5>
        <span className="text-body-sm text-on-surface-variant">{channels.length}</span>
      </div>
      {channels.length === 0 ? (
        <p className="px-2 py-4 text-center text-body-sm text-on-surface-variant">{emptyCopy}</p>
      ) : (
        <ul className="space-y-1 pt-2">
          {channels.map((channel) => (
            <li key={channel.id} className="flex min-h-10 items-center gap-2 rounded-full px-2">
              <Icon name={icon} size="xs" className="flex-shrink-0 text-on-surface-variant" />
              <span className="min-w-0 flex-1 truncate text-body-md font-medium text-on-surface-variant">{channel.name}</span>
              {channel.unreadCount > 0 ? (
                <span className="text-body-sm text-primary">{channel.unreadCount}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
