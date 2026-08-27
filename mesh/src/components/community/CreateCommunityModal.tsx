import { useRef, useState, type ReactNode } from 'react'
import { motion, AnimatePresence } from '../../lib/lazy-motion'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import * as bridge from '../../lib/bridge'
import { describeJoinRule } from '../../lib/community-access'
import { motionOffsets, transitions } from '../../lib/motion'
import type { Community, CommunityDirectoryEntry } from '../../types/ipc'
import { showToast } from '../ui/Toast'
import { Avatar } from '../ui/Avatar'
import { pixelColorForSeed } from '../ui/PixelMark'
import { Icon } from '../ui/Icon'
import { parseCommunityInvite, type CommunityInvite } from '../../lib/community-invites'
import {
  COMMUNITY_DESCRIPTION_MAX_LENGTH,
  COMMUNITY_NAME_MAX_LENGTH,
  metadataCharactersRemaining,
  metadataLengthError,
} from '../../lib/community-metadata-limits'

export type CreateCommunityTab = 'create' | 'join' | 'discover'
type CommunityAccessChoice = 'invite' | 'approval'
type CreationPhase =
  | 'idle'
  | 'community'
  | 'starter-rooms'
  | 'activation'
  | 'refresh'
  | 'partial'

/*
 * Every community used to get the gaming set unconditionally, which put
 * "clips-and-builds" and "playtest-notes" into communities that were never
 * about gaming at all. A picker fixes that without touching the backend:
 * community/room creation and default power levels are already generic
 * (`community_role_power_level_override` applies the same way regardless of
 * room name), so a template here is nothing more than which room names to
 * create. Gaming stays the default selection to preserve existing behavior
 * for anyone who does not interact with the picker.
 */
const COMMUNITY_TEMPLATES = [
  {
    id: 'gaming',
    label: 'Gaming',
    starterRooms: ['general', 'clips-and-builds', 'playtest-notes'],
  },
  {
    id: 'general',
    label: 'General',
    starterRooms: ['general'],
  },
] as const
type CommunityTemplateId = (typeof COMMUNITY_TEMPLATES)[number]['id']

const tabId = (tab: CreateCommunityTab) => `community-tools-tab-${tab}`

interface CreateCommunityModalProps {
  isOpen: boolean
  onClose: () => void
  initialTab?: CreateCommunityTab
  initialInvite?: string
  embedded?: boolean
  activeTab?: CreateCommunityTab
  onTabChange?: (tab: CreateCommunityTab) => void
}

export function CreateCommunityModal({
  isOpen,
  onClose,
  initialTab = 'create',
  initialInvite = '',
  embedded = false,
  activeTab,
  onTabChange,
}: CreateCommunityModalProps) {
  const matrixMode = bridge.isMatrixBackend()
  const tabs: CreateCommunityTab[] = matrixMode ? ['join', 'discover', 'create'] : ['join', 'create']
  const [localTab, setLocalTab] = useState<CreateCommunityTab>(initialTab)
  const tab = activeTab ?? localTab
  const setTab = (next: CreateCommunityTab) => {
    if (onTabChange) onTabChange(next)
    else setLocalTab(next)
  }
  const [isLoading, setIsLoading] = useState(false)

  const [communityName, setCommunityName] = useState('')
  const [communityDescription, setCommunityDescription] = useState('')
  const [accessChoice, setAccessChoice] = useState<CommunityAccessChoice>('invite')
  const [template, setTemplate] = useState<CommunityTemplateId>('gaming')
  const selectedTemplate = COMMUNITY_TEMPLATES.find((option) => option.id === template)
    ?? COMMUNITY_TEMPLATES[0]
  const [createStep, setCreateStep] = useState<1 | 2>(1)
  const [createError, setCreateError] = useState<unknown | null>(null)
  const [creationPhase, setCreationPhase] = useState<CreationPhase>('idle')
  const [createdCommunity, setCreatedCommunity] = useState<Community | null>(null)
  const [missingStarterRooms, setMissingStarterRooms] = useState<string[]>([])
  // Tracked separately from the starter-room outcome so the partial state can
  // name which thing actually failed.
  const [accessSettingFailed, setAccessSettingFailed] = useState(false)
  const creationInFlightRef = useRef(false)

  const [inviteLink, setInviteLink] = useState(initialInvite)
  const [reviewedInvite, setReviewedInvite] = useState<CommunityInvite | null>(null)
  const [joinError, setJoinError] = useState<unknown | null>(null)
  const [joinStatus, setJoinStatus] = useState('')
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [directoryServer, setDirectoryServer] = useState('')
  const [directoryResults, setDirectoryResults] = useState<CommunityDirectoryEntry[]>([])
  const [directoryError, setDirectoryError] = useState<unknown | null>(null)
  const [directorySearched, setDirectorySearched] = useState(false)
  const [applicationReason, setApplicationReason] = useState('')
  const [directoryStatus, setDirectoryStatus] = useState<Record<string, string>>({})
  const accountService = matrixMode ? accountServiceName() : null
  const directorySource = directoryServer.trim() || accountService

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
  const hasInvalidCommunityMetadata = Boolean(
    communityNameError || communityDescriptionError,
  )

  const addCommunity = useCommunityStore((s) => s.addCommunity)
  const setActiveCommunity = useCommunityStore((s) => s.setActiveCommunity)
  const replaceCommunityChannels = useChannelStore((s) => s.replaceCommunityChannels)

  const resetForm = () => {
    setCommunityName('')
    setCommunityDescription('')
    setAccessChoice('invite')
    setTemplate('gaming')
    setCreateStep(1)
    setCreateError(null)
    setCreationPhase('idle')
    setCreatedCommunity(null)
    setMissingStarterRooms([])
    setAccessSettingFailed(false)
    setInviteLink('')
    setReviewedInvite(null)
    setJoinError(null)
    setJoinStatus('')
    setDirectoryQuery('')
    setDirectoryServer('')
    setDirectoryResults([])
    setDirectoryError(null)
    setDirectorySearched(false)
    setApplicationReason('')
    setDirectoryStatus({})
    setIsLoading(false)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const handleCreate = async () => {
    if (!communityName.trim() || hasInvalidCommunityMetadata || creationInFlightRef.current) return
    creationInFlightRef.current = true
    setIsLoading(true)
    setCreateError(null)
    setAccessSettingFailed(false)
    let community = createdCommunity
    let starterRoomFailure: unknown | null = null
    let accessFailure: unknown | null = null
    try {
      if (!community) {
        setCreationPhase('community')
        community = await bridge.createCommunity(
          communityName.trim(),
          communityDescription.trim(),
        )
        setCreatedCommunity(community)
        addCommunity(community)
      }

      if (matrixMode) {
        try {
          /*
            Not discoverable: publishing to the account service's directory is a
            separate, later choice made in community settings, and it needs an
            address to publish. What the two radio options actually choose is the
            join rule, so that is what is sent.
          */
          await bridge.updateCommunityAccess(
            community.id,
            '',
            false,
            accessChoice === 'approval' ? 'knock' : 'invite',
          )
        } catch (error) {
          /*
            Kept separate from starterRoomFailure on purpose. Folding it in
            reported an access failure as "some starter rooms still need setup",
            which named the wrong thing, blamed rooms that were fine, and left
            the owner with no idea their chosen access setting had not applied.
          */
          accessFailure ??= error
        }
      }

      setCreationPhase('starter-rooms')
      let existingChannels = await bridge.getChannels(community.id)
      for (const channelName of selectedTemplate.starterRooms) {
        const alreadyExists = existingChannels.some(
          (channel) => channel.name.trim().toLocaleLowerCase() === channelName.toLocaleLowerCase(),
        )
        if (alreadyExists) continue
        try {
          const created = await bridge.createChannel(community.id, channelName, 'text')
          existingChannels = [...existingChannels, created]
        } catch (error) {
          starterRoomFailure ??= error
        }
      }

      setCreationPhase('activation')
      addCommunity(community)
      setActiveCommunity(community.id)

      setCreationPhase('refresh')
      const channels = await bridge.getChannels(community.id)
      replaceCommunityChannels(community.id, channels)
      const missingRooms = selectedTemplate.starterRooms.filter(
        (channelName) => !channels.some(
          (channel) => channel.name.trim().toLocaleLowerCase() === channelName.toLocaleLowerCase(),
        ),
      )
      setMissingStarterRooms([...missingRooms])

      if (accessFailure) {
        setCreationPhase('partial')
        setCreateError(accessFailure)
        setAccessSettingFailed(true)
        showToast(
          `${community.name} was created, but who can join could not be set. It is invitation only for now.`,
          'error',
        )
      } else if (starterRoomFailure && missingRooms.length > 0) {
        setCreationPhase('partial')
        setCreateError(starterRoomFailure)
        showToast(
          `${community.name} was created, but some starter rooms still need setup.`,
          'error',
        )
      } else {
        handleClose()
      }
    } catch (err) {
      setCreationPhase(community ? 'partial' : 'idle')
      setCreateError(err)
      console.error('Failed to create community:', err)
    } finally {
      creationInFlightRef.current = false
      setIsLoading(false)
    }
  }

  const handleJoin = async () => {
    if (!inviteLink.trim() || !reviewedInvite) return
    setIsLoading(true)
    setJoinError(null)
    setJoinStatus('')
    try {
      const outcome = await bridge.joinOrRequestCommunity(inviteLink.trim())
      if (outcome.status === 'knocked' || !outcome.community) {
        setJoinStatus(
          'Access requested. It appears here once an administrator approves.',
        )
        setIsLoading(false)
        return
      }
      const community = outcome.community
      addCommunity(community)
      setActiveCommunity(community.id)
      const channels = await bridge.getChannels(community.id)
      replaceCommunityChannels(community.id, channels)
      handleClose()
    } catch (err) {
      setJoinError(err)
      console.error('Failed to join community:', err)
    }
    setIsLoading(false)
  }

  const handleInviteReview = () => {
    setJoinError(null)
    setJoinStatus('')
    const parsed = parseCommunityInvite(inviteLink)
    if (!parsed) {
      setReviewedInvite(null)
      setJoinError(new Error('Check the invitation link or code and try again.'))
      return
    }
    setReviewedInvite(parsed)
  }

  const handleDirectorySearch = async () => {
    if (!directoryQuery.trim()) return
    setIsLoading(true)
    setDirectoryError(null)
    try {
      // No explicit address means the account service answers for itself, which
      // is what the native command already does with a null server.
      setDirectoryResults(
        await bridge.searchCommunityDirectory(
          directoryQuery.trim(),
          directoryServer.trim() || undefined,
        ),
      )
      setDirectorySearched(true)
    } catch (err) {
      setDirectoryError(err)
    }
    setIsLoading(false)
  }

  const handleDirectoryAccess = async (entry: CommunityDirectoryEntry) => {
    const target = entry.alias ?? entry.id
    setIsLoading(true)
    setDirectoryError(null)
    try {
      if (entry.joinRule === 'public') {
        const community = await bridge.joinCommunity(target)
        addCommunity(community)
        setActiveCommunity(community.id)
        replaceCommunityChannels(community.id, await bridge.getChannels(community.id))
        handleClose()
        return
      }

      const result = await bridge.requestCommunityAccess(target, applicationReason)
      if (result.status === 'joined' && result.community) {
        addCommunity(result.community)
        setActiveCommunity(result.community.id)
        replaceCommunityChannels(
          result.community.id,
          await bridge.getChannels(result.community.id),
        )
        handleClose()
        return
      }
      setDirectoryStatus((current) => ({
        ...current,
        [entry.id]: 'Request sent. Select it again once an administrator approves.',
      }))
    } catch (err) {
      setDirectoryError(err)
    }
    setIsLoading(false)
  }

  /*
    Whether the panel that is about to mount may take focus.

    Each panel autofocuses its first field, which is right when someone opens
    the modal or picks a tab deliberately: they came here to type. It is wrong
    while arrowing across the tablist, because a roving tabindex requires focus
    to stay on the tab so the person can keep exploring. Without this, one
    ArrowRight threw the keyboard user into a text box they never chose.
  */
  const panelMayTakeFocus = useRef(true)
  const claimPanelFocus = (element: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (!element || !panelMayTakeFocus.current) return
    panelMayTakeFocus.current = false
    element.focus()
  }

  const moveTabFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = tabs[(index + step + tabs.length) % tabs.length]
    panelMayTakeFocus.current = false
    setTab(next)
    document.getElementById(tabId(next))?.focus()
  }

  // Embedded use has no switcher of its own, so a panel role would name a tab
  // that is not on the page.
  const panelProps = (panelTab: CreateCommunityTab) => embedded
    ? {}
    : {
        role: 'tabpanel' as const,
        id: `community-tools-panel-${panelTab}`,
        'aria-labelledby': tabId(panelTab),
      }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.currentTarget instanceof HTMLTextAreaElement) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (tab === 'create') {
        if (createStep === 1 && communityName.trim() && !hasInvalidCommunityMetadata) setCreateStep(2)
        else if (createStep === 2) void handleCreate()
      }
      else if (tab === 'join') {
        if (reviewedInvite) void handleJoin()
        else handleInviteReview()
      }
      else handleDirectorySearch()
    }
  }

  const modalTitle = tab === 'create'
    ? 'Create a community'
    : tab === 'join'
      ? 'Join a community'
      : 'Find a community'
  const modalDescription = tab === 'create'
    ? 'Name it, then choose who can join.'
    : tab === 'join'
      ? matrixMode
        ? 'Paste the invite you received.'
        : 'Paste the invite link you received.'
      : 'Search the public communities your account service lists.'

  return (
    <CommunityToolsFrame
      embedded={embedded}
      open={isOpen}
      onClose={handleClose}
      title={modalTitle}
      description={modalDescription}
      size="xl"
      className="mesh-community-tools-dialog"
    >
      <div className={embedded ? 'mesh-form-card border border-outline-variant p-5 sm:p-6' : undefined}>
        {/* Tab switcher */}
        {!embedded && (
        <div
          role="tablist"
          aria-label="Create, join, or find a community"
          className="mb-5 grid gap-2"
          /* Column count follows the tab count. It was hardcoded to three, so
             the two-tab case left an empty third column. */
          style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
          data-design-token-exception="data-driven-tab-column-count"
        >
          {tabs.map((t, index) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={tabId(t)}
              aria-selected={tab === t}
              aria-controls={`community-tools-panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => {
                // Choosing a tab outright is a decision to work in it.
                panelMayTakeFocus.current = true
                setTab(t)
              }}
              onKeyDown={(event) => moveTabFocus(event, index)}
              className={`relative flex min-h-12 items-center justify-center gap-2 rounded-full border px-4 py-2 text-body-md font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
                tab === t
                  ? 'border-primary-container-line bg-primary-container text-on-surface'
                  : 'border-outline-variant bg-surface-container-lowest text-on-surface-variant hover:border-outline hover:bg-surface-container-high hover:text-on-surface-variant'
              }`}
            >
              {/*
                A tint is the one selected signal a colour-blind user cannot
                read, so the indicator carries a shape and a position too.

                This used to be a shared `layoutId` element, which is the only
                thing in the app that needed framer-motion's layout projection,
                and a direct framer import to get it. That pulled the whole DOM
                feature set: 38 KiB of gesture and projection code shipped for
                one underline. A scale transition reads the same and
                costs nothing, and both reduced-motion routes already clamp
                transition-duration, so it is quiet by default when asked.
              */}
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 bottom-0 origin-center border-b-bar border-primary transition-transform duration-fast ease-enter ${
                  tab === t ? 'scale-x-100' : 'scale-x-0'
                }`}
              />
              <Icon
                name={t === 'create' ? 'plus' : t === 'join' ? 'userPlus' : 'compass'}
                size="sm"
                className="relative z-sticky"
              />
              <span className="relative z-sticky capitalize">
                {t === 'create' ? 'Create' : t === 'join' ? 'Join' : 'Find'}
              </span>
            </button>
          ))}
        </div>
        )}

        <AnimatePresence mode="wait">
          {tab === 'create' ? (
            <motion.div
              key="create"
              {...panelProps('create')}
              initial={{ opacity: 0, x: -motionOffsets.panel }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: motionOffsets.panel }}
              transition={transitions.enter}
            >
              <div className="mb-5 flex items-center justify-between gap-3 border-b border-outline-variant pb-3">
                <p className="text-body-md font-semibold text-on-surface-variant">
                  {createStep === 1 ? 'Name and image' : 'Access and starter rooms'}
                </p>
                <span className="rounded-full bg-secondary-container px-2.5 py-1 text-body-sm text-on-surface-variant">
                  Step {createStep} of 2
                </span>
              </div>

              {createStep === 1 ? (
                <div className="space-y-3">
                  <Input
                    label="Community name"
                    value={communityName}
                    onChange={(value: string) => {
                      setCommunityName(value)
                      setCreateError(null)
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="e.g. Canyon Raiders"
                    maxLength={COMMUNITY_NAME_MAX_LENGTH}
                    hint={metadataCharactersRemaining(
                      communityName,
                      COMMUNITY_NAME_MAX_LENGTH,
                    )}
                    error={communityNameError}
                    ref={claimPanelFocus}
                  />
                  <div className="flex items-center gap-3 rounded-xl border border-outline-variant bg-surface p-3">
                    <Avatar
                      color={pixelColorForSeed(communityName || 'new-community')}
                      size={44}
                      name={communityName || 'New community'}
                      variant="community"
                    />
                    <div>
                      <p className="text-body-md font-medium text-on-surface">Default community image</p>
                      <p className="mt-0.5 text-body-sm text-on-surface-variant">Replace it in community settings.</p>
                    </div>
                  </div>
                  <div>
                    <label
                      htmlFor="create-community-description"
                      className="mb-1.5 block text-body-sm font-semibold lowercase text-on-surface-variant"
                    >
                      Description
                    </label>
                    <textarea
                      id="create-community-description"
                      value={communityDescription}
                      onChange={(e) => {
                        setCommunityDescription(e.target.value)
                        setCreateError(null)
                      }}
                      onKeyDown={handleKeyDown}
                      placeholder="What's this community about?"
                      maxLength={COMMUNITY_DESCRIPTION_MAX_LENGTH}
                      aria-describedby="create-community-description-supporting"
                      aria-invalid={communityDescriptionError ? true : undefined}
                      rows={2}
                      className={`w-full resize-none rounded-full border bg-surface px-3 py-2 text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-none ${
                        communityDescriptionError
                          ? 'border-error focus:border-error'
                          : 'border-outline focus:border-primary'
                      }`}
                    />
                    <p
                      id="create-community-description-supporting"
                      role={communityDescriptionError ? 'alert' : undefined}
                      className={`mt-1.5 text-body-sm ${
                        communityDescriptionError ? 'text-error' : 'text-on-surface-variant'
                      }`}
                    >
                      {communityDescriptionError
                        ?? metadataCharactersRemaining(
                          communityDescription,
                          COMMUNITY_DESCRIPTION_MAX_LENGTH,
                        )}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <fieldset>
                    <legend className="text-body-sm font-semibold lowercase tracking-label-md text-on-surface-variant">Who can join</legend>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {([
                        ['invite', 'Invitation only'],
                        ['approval', 'Approval required'],
                      ] as const).map(([value, label]) => (
                        <label
                          key={value}
                          // The radio itself is visually hidden, so the card has
                          // to carry the focus ring for it.
                          className={`cursor-pointer rounded-full border px-3 py-3 has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-focus ${
                            accessChoice === value
                              ? 'border-primary bg-primary-container'
                              : 'border-outline-variant bg-surface-container-lowest hover:bg-surface-container-high'
                          }`}
                        >
                          <input
                            type="radio"
                            name="community-access"
                            value={value}
                            checked={accessChoice === value}
                            onChange={() => setAccessChoice(value)}
                            className="sr-only"
                          />
                          <span className="block text-body-md font-semibold text-on-surface">{label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="text-body-sm font-semibold lowercase tracking-label-md text-on-surface-variant">Starter rooms</legend>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {COMMUNITY_TEMPLATES.map((option) => (
                        <label
                          key={option.id}
                          className={`cursor-pointer rounded-full border px-3 py-3 has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-focus ${
                            template === option.id
                              ? 'border-primary bg-primary-container'
                              : 'border-outline-variant bg-surface-container-lowest hover:bg-surface-container-high'
                          }`}
                        >
                          <input
                            type="radio"
                            name="community-template"
                            value={option.id}
                            checked={template === option.id}
                            onChange={() => setTemplate(option.id)}
                            className="sr-only"
                          />
                          <span className="block text-body-md font-semibold text-on-surface">{option.label}</span>
                        </label>
                      ))}
                    </div>
                    <div className="mt-2 rounded-full border border-outline-variant bg-surface-container-lowest px-3 py-3">
                      <ul className="space-y-1 text-body-md text-on-surface-variant">
                        {selectedTemplate.starterRooms.map((room) => <li key={room}>#{room}</li>)}
                      </ul>
                      <p className="mt-2 text-body-sm text-on-surface-variant">
                        Mesh adds a voice room automatically when private calling is available.
                      </p>
                    </div>
                  </fieldset>
                  <p className="text-body-sm text-on-surface-variant">
                    Created with your current account service.
                  </p>
                </div>
              )}

              {createError != null && (
                <ErrorState
                  error={createError}
                  context={{
                    operation: createdCommunity
                      ? 'finish setting up this community'
                      : 'create this community',
                    resource: 'community',
                  }}
                  onAction={handleCreate}
                  className="mt-3"
                  compact
                />
              )}

              {createdCommunity && creationPhase === 'partial' && (
                <div
                  role="status"
                  className="mt-3 rounded-full border border-marker-container-line bg-marker-container px-3 py-2 text-body-md text-on-surface-variant"
                >
                  {accessSettingFailed ? (
                    <>
                      <p>
                        Community created, but who can join could not be set. It is invitation
                        only for now.
                      </p>
                      <p className="mt-2 text-body-sm">
                        Retry, or set it in community settings under Access and discovery.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>Community created. Some rooms still need attention.</p>
                      {missingStarterRooms.length > 0 && (
                        <ul className="mt-2 list-disc pl-5 text-body-sm">
                          {missingStarterRooms.map((room) => <li key={room}>#{room}</li>)}
                        </ul>
                      )}
                      <p className="mt-2 text-body-sm">Retry adds only the missing rooms.</p>
                    </>
                  )}
                </div>
              )}

              <div className="mt-4 flex gap-2">
                {createStep === 2 && (
                  <Button variant="ghost" onClick={() => setCreateStep(1)} disabled={isLoading}>
                    Back
                  </Button>
                )}
                <Button
                  variant="primary"
                  onClick={() => {
                    if (createStep === 1 && !hasInvalidCommunityMetadata) setCreateStep(2)
                    else void handleCreate()
                  }}
                  disabled={!communityName.trim() || hasInvalidCommunityMetadata || isLoading}
                  className="flex-1"
                >
                  {createStep === 1
                    ? 'Next'
                    : isLoading
                      ? creationPhase === 'community'
                        ? 'Creating community…'
                        : creationPhase === 'starter-rooms'
                          ? 'Adding starter rooms…'
                          : creationPhase === 'refresh'
                            ? 'Refreshing rooms…'
                            : 'Finishing setup…'
                      : createdCommunity
                        ? 'Finish setup'
                        : 'Create community'}
                </Button>
              </div>
            </motion.div>
          ) : tab === 'join' ? (
            <motion.div
              key="join"
              {...panelProps('join')}
              initial={{ opacity: 0, x: motionOffsets.panel }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -motionOffsets.panel }}
              transition={transitions.enter}
            >
              <Input
                label="Invitation link or code"
                value={inviteLink}
                onChange={(v: string) => {
                  setInviteLink(v)
                  setJoinError(null)
                  setJoinStatus('')
                  setReviewedInvite(null)
                }}
                onKeyDown={handleKeyDown}
                placeholder={matrixMode ? 'mesh.app/i/aB3xK9' : 'Paste your invite link'}
                ref={claimPanelFocus}
              />

              {joinError != null && (
                <ErrorState
                  error={joinError}
                  userMessage={reviewedInvite ? undefined : 'Check the invitation link or code and try again.'}
                  context={{ operation: reviewedInvite ? 'join this community' : 'review this invitation', resource: 'community' }}
                  onAction={reviewedInvite ? handleJoin : handleInviteReview}
                  className="mt-2"
                  compact
                />
              )}

              {joinStatus && (
                <p
                  role="status"
                  className="mt-2 rounded-full border border-primary-container-line bg-primary-container px-3 py-2 text-body-md text-primary"
                >
                  {joinStatus}
                </p>
              )}

              {reviewedInvite && (
                <section className="mt-3 rounded-full border border-outline bg-surface-container-lowest px-3 py-3" aria-labelledby="invitation-preview-heading">
                  <h3 id="invitation-preview-heading" className="text-body-md font-semibold text-on-surface">Destination ready to review</h3>
                  <dl className="mt-2 space-y-2 text-body-sm">
                    <div className="flex items-start justify-between gap-3"><dt className="text-on-surface-variant">Community</dt><dd className="text-right text-on-surface-variant">Confirmed when you continue</dd></div>
                    <div className="flex items-start justify-between gap-3"><dt className="text-on-surface-variant">Access</dt><dd className="text-right text-on-surface-variant">Join or request approval</dd></div>
                    {suggestedServiceLabel(reviewedInvite) && (
                      <div className="flex items-start justify-between gap-3"><dt className="text-on-surface-variant">Service suggested by this invitation</dt><dd className="text-right text-on-surface-variant">{suggestedServiceLabel(reviewedInvite)}</dd></div>
                    )}
                  </dl>
                  <p className="mt-3 text-body-sm text-on-surface-variant">
                    Mesh never switches your account service for you.
                  </p>
                </section>
              )}

              <Button
                variant="primary"
                onClick={reviewedInvite ? handleJoin : handleInviteReview}
                disabled={!inviteLink.trim() || isLoading}
                className="mt-4 w-full"
              >
                {isLoading
                  ? 'Checking access…'
                  : reviewedInvite
                    ? 'Continue with current account'
                    : 'Review invitation'}
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="discover"
              {...panelProps('discover')}
              initial={{ opacity: 0, x: motionOffsets.panel }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -motionOffsets.panel }}
              transition={transitions.enter}
            >
              <section className="rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-5" aria-labelledby="find-community-heading">
                <h3 id="find-community-heading" className="text-body-lg font-semibold text-on-surface">Search public communities</h3>
                {/*
                  Honest about the source: Mesh has no catalog of its own, and a
                  community that is not published stays invisible here however
                  well the search works.
                */}
                <p className="mt-2 text-body-md text-on-surface-variant">
                  Searches the public list
                  {directorySource ? ` published by ${directorySource}` : ' published by your account service'},
                  so unlisted communities do not appear.
                </p>
                <div className="mt-4 space-y-3">
                  <Input
                    label="Search"
                    value={directoryQuery}
                    onChange={(value: string) => {
                      setDirectoryQuery(value)
                      setDirectoryError(null)
                      setDirectorySearched(false)
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="Community name or topic"
                  />
                  <Button
                    variant="primary"
                    onClick={handleDirectorySearch}
                    disabled={isLoading || !directoryQuery.trim()}
                    className="w-full"
                  >
                    {isLoading ? 'Searching…' : 'Search'}
                  </Button>
                </div>

                {directoryError != null && (
                  <ErrorState
                    error={directoryError}
                    context={{ operation: 'search or join from the community directory', resource: 'community' }}
                    className="mt-3"
                    compact
                  />
                )}

                <div className="mt-4 max-h-64 space-y-2 overflow-y-auto" aria-live="polite">
                  {directoryResults.length > 0 && (
                    <p className="text-label-sm text-on-surface-variant">{directoryResults.length} result{directoryResults.length === 1 ? '' : 's'}</p>
                  )}
                  {directoryResults.map((entry) => (
                    <div key={entry.id} className="rounded-xl bg-surface p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-body-md font-semibold text-on-surface">{entry.name}</p>
                          {entry.description && (
                            <p className="mt-1 line-clamp-2 text-body-sm text-on-surface-variant">{entry.description}</p>
                          )}
                          <p className="member-count mt-1 text-body-sm text-on-surface-variant">
                            {entry.memberCount} member{entry.memberCount === 1 ? '' : 's'} · {describeJoinRule(entry.joinRule)}
                          </p>
                        </div>
                        <Button
                          onClick={() => handleDirectoryAccess(entry)}
                          disabled={isLoading || directoryStatus[entry.id] != null}
                          variant="secondary"
                        >
                          {entry.joinRule === 'public' ? 'Join' : 'Apply'}
                        </Button>
                      </div>
                      {directoryStatus[entry.id] && (
                        <p className="mt-2 text-body-sm text-primary">{directoryStatus[entry.id]}</p>
                      )}
                    </div>
                  ))}
                  {!isLoading && directoryResults.length === 0 && !directoryError && (
                    <p className="py-3 text-center text-body-sm text-on-surface-variant">
                      {directorySearched
                        ? 'No listed community matched that search.'
                        : 'Search by community name or topic.'}
                    </p>
                  )}
                </div>

                {directoryResults.length > 0 && (
                  <div className="mt-3">
                    <label
                      htmlFor="community-application-note"
                      className="mb-1.5 block text-body-sm font-semibold lowercase text-on-surface-variant"
                    >
                      Application note (optional)
                    </label>
                    <textarea
                      id="community-application-note"
                      value={applicationReason}
                      onChange={(event) => setApplicationReason(event.target.value)}
                      rows={2}
                      className="w-full resize-none rounded-full border border-outline bg-surface px-3 py-2 text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none"
                      placeholder="Why would you like to join?"
                    />
                    <p className="mt-1.5 text-body-sm text-on-surface-variant">
                      Sent only when a community asks you to apply.
                    </p>
                  </div>
                )}
              </section>

              <section className="mt-4 rounded-xl border border-outline-variant bg-surface-container px-4 py-4" aria-labelledby="find-community-alternatives-heading">
                <h3 id="find-community-alternatives-heading" className="text-body-md font-semibold text-on-surface">Other ways in</h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <Button variant="secondary" onClick={() => setTab('join')}>
                    Use an invitation
                  </Button>
                  <Button variant="secondary" onClick={() => setTab('create')}>
                    Create a community
                  </Button>
                </div>
              </section>

              <details className="mt-4 rounded-full border border-outline-variant bg-surface-container px-3">
                <summary className="flex min-h-11 cursor-pointer items-center text-body-md font-semibold text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
                  Advanced: use another directory
                </summary>
                <div className="space-y-3 border-t border-outline-variant py-3">
                  <Input
                    label="Compatible directory address"
                    value={directoryServer}
                    onChange={(value: string) => {
                      setDirectoryServer(value)
                      setDirectoryError(null)
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="directory.example.org"
                    hint="A service name, without https:// or a path. Empty uses your account service."
                  />
                </div>
              </details>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </CommunityToolsFrame>
  )
}

function CommunityToolsFrame({
  embedded,
  children,
  ...modalProps
}: React.ComponentProps<typeof Modal> & { embedded: boolean; children: ReactNode }) {
  if (embedded) return <div className="min-h-0">{children}</div>
  return <Modal {...modalProps}>{children}</Modal>
}

/**
 * The service that answers a directory search when no other address is given.
 * The native command takes an optional server and asks the signed-in account
 * service when it is absent, so this is a label, never a routing decision.
 */
function accountServiceName(): string | null {
  const homeserver = bridge.getBackendStatusSnapshot()?.homeserver
  if (homeserver) {
    try {
      return new URL(homeserver).hostname
    } catch {
      const trimmed = homeserver.replace(/^https?:\/\//i, '').split('/')[0]
      if (trimmed) return trimmed
    }
  }
  const domain = bridge.getMatrixUserId()?.split(':').slice(1).join(':')
  return domain || null
}

function suggestedServiceLabel(invite: CommunityInvite): string | null {
  const value = invite.kind === 'matrix'
    ? invite.service
    : invite.kind === 'community'
      ? invite.communityService
      : null
  if (!value) return null
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}
