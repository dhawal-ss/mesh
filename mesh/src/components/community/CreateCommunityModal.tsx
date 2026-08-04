import { useRef, useState, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import * as bridge from '../../lib/bridge'
import { describeJoinRule } from '../../lib/community-access'
import { transitions } from '../../lib/motion'
import type { Community, CommunityDirectoryEntry } from '../../types/ipc'
import { showToast } from '../ui/Toast'
import { Avatar } from '../ui/Avatar'
import { pixelColorForSeed } from '../ui/PixelMark'
import { Icon } from '../ui/Icon'
import { parseCommunityInvite, type CommunityInvite } from '../../lib/community-invites'

export type CreateCommunityTab = 'create' | 'join' | 'discover'
type CommunityAccessChoice = 'invite' | 'approval'
type CreationPhase =
  | 'idle'
  | 'community'
  | 'starter-rooms'
  | 'activation'
  | 'refresh'
  | 'partial'

const GAMING_STARTER_ROOMS = ['general', 'clips-and-builds', 'playtest-notes'] as const

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
  const [createStep, setCreateStep] = useState<1 | 2>(1)
  const [createError, setCreateError] = useState<unknown | null>(null)
  const [creationPhase, setCreationPhase] = useState<CreationPhase>('idle')
  const [createdCommunity, setCreatedCommunity] = useState<Community | null>(null)
  const [missingStarterRooms, setMissingStarterRooms] = useState<string[]>([])
  const creationInFlightRef = useRef(false)

  const [inviteLink, setInviteLink] = useState(initialInvite)
  const [reviewedInvite, setReviewedInvite] = useState<CommunityInvite | null>(null)
  const [joinError, setJoinError] = useState<unknown | null>(null)
  const [joinStatus, setJoinStatus] = useState('')
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [directoryServer, setDirectoryServer] = useState('')
  const [directoryResults, setDirectoryResults] = useState<CommunityDirectoryEntry[]>([])
  const [directoryError, setDirectoryError] = useState<unknown | null>(null)
  const [applicationReason, setApplicationReason] = useState('')
  const [directoryStatus, setDirectoryStatus] = useState<Record<string, string>>({})

  const addCommunity = useCommunityStore((s) => s.addCommunity)
  const setActiveCommunity = useCommunityStore((s) => s.setActiveCommunity)
  const replaceCommunityChannels = useChannelStore((s) => s.replaceCommunityChannels)

  const resetForm = () => {
    setCommunityName('')
    setCommunityDescription('')
    setAccessChoice('invite')
    setCreateStep(1)
    setCreateError(null)
    setCreationPhase('idle')
    setCreatedCommunity(null)
    setMissingStarterRooms([])
    setInviteLink('')
    setReviewedInvite(null)
    setJoinError(null)
    setJoinStatus('')
    setDirectoryQuery('')
    setDirectoryServer('')
    setDirectoryResults([])
    setDirectoryError(null)
    setApplicationReason('')
    setDirectoryStatus({})
    setIsLoading(false)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const handleCreate = async () => {
    if (!communityName.trim() || creationInFlightRef.current) return
    creationInFlightRef.current = true
    setIsLoading(true)
    setCreateError(null)
    let community = createdCommunity
    let starterRoomFailure: unknown | null = null
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
          await bridge.updateCommunityAccess(community.id, '', accessChoice === 'approval')
        } catch (error) {
          starterRoomFailure ??= error
        }
      }

      setCreationPhase('starter-rooms')
      let existingChannels = await bridge.getChannels(community.id)
      for (const channelName of GAMING_STARTER_ROOMS) {
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
      const missingRooms = GAMING_STARTER_ROOMS.filter(
        (channelName) => !channels.some(
          (channel) => channel.name.trim().toLocaleLowerCase() === channelName.toLocaleLowerCase(),
        ),
      )
      setMissingStarterRooms([...missingRooms])

      if (starterRoomFailure && (missingRooms.length > 0 || matrixMode)) {
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
          'Access requested. An administrator will approve you before the community appears here.',
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
    if (!directoryServer.trim()) {
      setDirectoryError(new Error('Enter an explicit compatible directory address in Advanced.'))
      return
    }
    setIsLoading(true)
    setDirectoryError(null)
    try {
      setDirectoryResults(
        await bridge.searchCommunityDirectory(directoryQuery, directoryServer || undefined),
      )
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
        [entry.id]: 'Request sent. Select this community again after an administrator approves it.',
      }))
    } catch (err) {
      setDirectoryError(err)
    }
    setIsLoading(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.currentTarget instanceof HTMLTextAreaElement) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (tab === 'create') {
        if (createStep === 1 && communityName.trim()) setCreateStep(2)
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
      : 'Browse communities'
  const modalDescription = tab === 'create'
    ? 'Start a focused space for the people you talk with.'
    : tab === 'join'
      ? matrixMode
        ? 'Paste the invite you received.'
        : 'Paste the invite link you received.'
      : 'Search the public community directory. New members may need approval.'

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
      <div className={embedded ? 'px-party-gutter py-5' : undefined}>
        {/* Tab switcher */}
        {!embedded && (
        <div className="mb-5 grid grid-cols-3 gap-2">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`relative flex min-h-12 items-center justify-center gap-2 rounded-control border px-4 py-2 text-sm font-medium transition-colors ${
                tab === t
                  ? 'border-accent/40 bg-accent/10 text-primary'
                  : 'border-border-subtle bg-surface-sunken text-muted hover:border-border-emphasis hover:bg-surface-hover hover:text-secondary'
              }`}
            >
              {tab === t && (
                <motion.div
                  layoutId="tab-indicator"
                  className="absolute inset-0 rounded-control bg-accent/10"
                  transition={transitions.enter}
                />
              )}
              <Icon
                name={t === 'create' ? 'plus' : t === 'join' ? 'userPlus' : 'compass'}
                size="sm"
                className="relative z-sticky"
              />
              <span className="relative z-sticky capitalize">
                {t === 'create' ? 'Create' : t === 'join' ? 'Join' : 'Browse'}
              </span>
            </button>
          ))}
        </div>
        )}

        <AnimatePresence mode="wait">
          {tab === 'create' ? (
            <motion.div
              key="create"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={transitions.enter}
            >
              <p className="mb-4 text-xs text-muted">
                Step {createStep} of 2 · {createStep === 1 ? 'Name and identity' : 'Access and starter rooms'}
              </p>

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
                    autoFocus
                  />
                  <div className="flex items-center gap-3 rounded-control border border-border-subtle bg-surface-sunken p-3">
                    <Avatar
                      color={pixelColorForSeed(communityName || 'new-community')}
                      size={44}
                      name={communityName || 'New community'}
                      variant="community"
                    />
                    <div>
                      <p className="text-sm font-medium text-primary">Mesh pixel identity</p>
                      <p className="mt-0.5 text-xs text-muted">
                        Your community starts with a distinct pixel mark. A custom image replaces it when one is set.
                      </p>
                    </div>
                  </div>
                  <div>
                    <label
                      htmlFor="create-community-description"
                      className="mb-1.5 block text-xs font-semibold uppercase text-muted"
                    >
                      Description
                    </label>
                    <textarea
                      id="create-community-description"
                      value={communityDescription}
                      onChange={(e) => setCommunityDescription(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="What's this community about?"
                      rows={2}
                      className="w-full resize-none rounded-control border border-border bg-surface-sunken px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <fieldset>
                    <legend className="text-xs font-semibold uppercase tracking-eyebrow text-muted">Who can join</legend>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {([
                        ['invite', 'Invitation only', 'Players join from an invitation you create.'],
                        ['approval', 'Approval required', 'Players can request access and wait for an administrator.'],
                      ] as const).map(([value, label, description]) => (
                        <label
                          key={value}
                          className={`cursor-pointer rounded-control border px-3 py-3 ${
                            accessChoice === value
                              ? 'border-accent bg-accent/10'
                              : 'border-border-subtle bg-surface-sunken hover:bg-surface-hover'
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
                          <span className="block text-sm font-semibold text-primary">{label}</span>
                          <span className="mt-1 block text-xs leading-5 text-muted">{description}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <section className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-3" aria-labelledby="starter-rooms-heading">
                    <h3 id="starter-rooms-heading" className="text-xs font-semibold uppercase tracking-eyebrow text-muted">Gaming starter rooms</h3>
                    <ul className="mt-2 space-y-1 text-sm text-secondary">
                      {GAMING_STARTER_ROOMS.map((room) => <li key={room}>#{room}</li>)}
                    </ul>
                    <p className="mt-2 text-xs leading-5 text-muted">
                      A voice room is added only when this account service reports that private calling and voice-room creation are ready.
                    </p>
                  </section>
                  <p className="text-xs leading-5 text-muted">
                    This community will use your current account service. Members may use other compatible services.
                    Mesh does not provision paid hosting, DNS, or server setup.
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
                  className="mt-3 rounded-control border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-sm text-secondary"
                >
                  <p>Community created. Some rooms still need attention.</p>
                  {missingStarterRooms.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 text-xs">
                      {missingStarterRooms.map((room) => <li key={room}>#{room}</li>)}
                    </ul>
                  )}
                  <p className="mt-2 text-xs">Retry adds only missing rooms and refreshes this community.</p>
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
                    if (createStep === 1) setCreateStep(2)
                    else void handleCreate()
                  }}
                  disabled={!communityName.trim() || isLoading}
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
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
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
                autoFocus
              />

              {joinError != null && (
                <ErrorState
                  error={joinError}
                  context={{ operation: reviewedInvite ? 'join this community' : 'review this invitation', resource: 'community' }}
                  onAction={reviewedInvite ? handleJoin : handleInviteReview}
                  className="mt-2"
                  compact
                />
              )}

              {joinStatus && (
                <p
                  role="status"
                  className="mt-2 rounded-control border border-status-success/30 bg-status-success/10 px-3 py-2 text-sm text-status-success"
                >
                  {joinStatus}
                </p>
              )}

              {reviewedInvite && (
                <section className="mt-3 rounded-control border border-border-control bg-surface-sunken px-3 py-3" aria-labelledby="invitation-preview-heading">
                  <h3 id="invitation-preview-heading" className="text-sm font-semibold text-primary">Destination ready to review</h3>
                  <dl className="mt-2 space-y-2 text-xs">
                    <div className="flex items-start justify-between gap-3"><dt className="text-muted">Community</dt><dd className="text-right text-secondary">Confirmed when you continue</dd></div>
                    <div className="flex items-start justify-between gap-3"><dt className="text-muted">Access</dt><dd className="text-right text-secondary">Join or request approval</dd></div>
                    {suggestedServiceLabel(reviewedInvite) && (
                      <div className="flex items-start justify-between gap-3"><dt className="text-muted">Service suggested by this invitation</dt><dd className="text-right text-secondary">{suggestedServiceLabel(reviewedInvite)}</dd></div>
                    )}
                  </dl>
                  <p className="mt-3 text-xs leading-5 text-muted">
                    Your current account service and this destination community can be different.
                    A suggested service is never selected for you.
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
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={transitions.enter}
            >
              <section className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-4" aria-labelledby="browse-unavailable-heading">
                <h3 id="browse-unavailable-heading" className="text-sm font-semibold text-primary">Browsing is not available yet</h3>
                <p className="mt-2 text-xs leading-5 text-muted">
                  Mesh has no reviewed public directory source configured. You can still join with an invitation or create a community.
                </p>
              </section>
              <details className="mt-4 rounded-control border border-border-subtle bg-surface-raised px-3">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                  Use another directory
                </summary>
                <div className="space-y-3 border-t border-border-subtle py-3">
                <Input
                  label="Compatible directory address"
                  value={directoryServer}
                  onChange={(value: string) => {
                    setDirectoryServer(value)
                    setDirectoryError(null)
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="https://directory.example.org"
                />
                <Input
                  label="Search"
                  value={directoryQuery}
                  onChange={setDirectoryQuery}
                  onKeyDown={handleKeyDown}
                  placeholder="Community name or topic"
                />
                <div>
                  <label
                    htmlFor="community-application-note"
                    className="mb-1.5 block text-xs font-semibold uppercase text-muted"
                  >
                    Application note (optional)
                  </label>
                  <textarea
                    id="community-application-note"
                    value={applicationReason}
                    onChange={(event) => setApplicationReason(event.target.value)}
                    rows={2}
                    className="w-full resize-none rounded-control border border-border bg-surface-sunken px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                    placeholder="Why would you like to join?"
                  />
                </div>

              <Button variant="primary" onClick={handleDirectorySearch} disabled={isLoading || !directoryServer.trim() || !directoryQuery.trim()} className="w-full">
                {isLoading ? 'Searching…' : 'Search directory'}
              </Button>

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
                  <p className="text-caption text-muted">{directoryResults.length} result{directoryResults.length === 1 ? '' : 's'}</p>
                )}
                {directoryResults.map((entry) => (
                  <div key={entry.id} className="rounded-panel bg-surface-sunken p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-primary">{entry.name}</p>
                        {entry.description && (
                          <p className="mt-1 line-clamp-2 text-xs text-muted">{entry.description}</p>
                        )}
                        <p className="member-count mt-1 text-meta text-muted">
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
                      <p className="mt-2 text-xs text-green">{directoryStatus[entry.id]}</p>
                    )}
                  </div>
                ))}
                {!isLoading && directoryResults.length === 0 && !directoryError && (
                  <p className="py-3 text-center text-xs text-muted">Enter an explicit compatible directory to search.</p>
                )}
              </div>
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
  if (embedded) return <div className="min-h-0 overflow-y-auto">{children}</div>
  return <Modal {...modalProps}>{children}</Modal>
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
