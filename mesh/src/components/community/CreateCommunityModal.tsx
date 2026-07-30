import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { ErrorState } from '../ui/ErrorState'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import { useShellStore } from '../../store/shell'
import * as bridge from '../../lib/bridge'
import { describeJoinRule } from '../../lib/community-access'
import { transitions } from '../../lib/motion'
import type { CommunityDirectoryEntry } from '../../types/ipc'
import { showToast } from '../ui/Toast'

export type CreateCommunityTab = 'create' | 'join' | 'discover'
type ServerTemplate = 'gaming' | 'friends' | 'community'

const SERVER_ICONS = ['🎮', '🌟', '🧭', '🎨', '🏡'] as const
const SERVER_TEMPLATES: Record<
  ServerTemplate,
  { label: string; description: string; channels: string[] }
> = {
  gaming: {
    label: 'Gaming',
    description: 'Squads, clips, and game nights',
    channels: ['squad-up', 'clips'],
  },
  friends: {
    label: 'Friends',
    description: 'Plans, photos, and everyday chat',
    channels: ['plans', 'photos'],
  },
  community: {
    label: 'Community',
    description: 'Introductions and announcements',
    channels: ['announcements', 'introductions'],
  },
}

interface CreateCommunityModalProps {
  isOpen: boolean
  onClose: () => void
  initialTab?: CreateCommunityTab
  initialInvite?: string
}

export function CreateCommunityModal({
  isOpen,
  onClose,
  initialTab = 'create',
  initialInvite = '',
}: CreateCommunityModalProps) {
  const matrixMode = bridge.isMatrixBackend()
  const tabs: CreateCommunityTab[] = matrixMode ? ['create', 'join', 'discover'] : ['create', 'join']
  const [tab, setTab] = useState<CreateCommunityTab>(initialTab)
  const [isLoading, setIsLoading] = useState(false)

  const [communityName, setCommunityName] = useState('')
  const [communityDescription, setCommunityDescription] = useState('')
  const [communityIcon, setCommunityIcon] = useState<(typeof SERVER_ICONS)[number]>('🌟')
  const [serverTemplate, setServerTemplate] = useState<ServerTemplate>('friends')
  const [createStep, setCreateStep] = useState<1 | 2>(1)
  const [createError, setCreateError] = useState<unknown | null>(null)

  const [inviteLink, setInviteLink] = useState(initialInvite)
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
  const setChannels = useChannelStore((s) => s.setChannels)

  const resetForm = () => {
    setCommunityName('')
    setCommunityDescription('')
    setCommunityIcon('🌟')
    setServerTemplate('friends')
    setCreateStep(1)
    setCreateError(null)
    setInviteLink('')
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
    if (!communityName.trim()) return
    setIsLoading(true)
    setCreateError(null)
    try {
      const community = await bridge.createCommunity(
        `${communityIcon} ${communityName.trim()}`,
        communityDescription.trim(),
      )
      addCommunity(community)
      setActiveCommunity(community.id)
      const templateResults = await Promise.allSettled(
        SERVER_TEMPLATES[serverTemplate].channels.map((channelName) =>
          bridge.createChannel(community.id, channelName, 'text'),
        ),
      )
      if (templateResults.some((result) => result.status === 'rejected')) {
        console.warn('The community was created, but one or more starter rooms could not be added.')
      }
      const channels = await bridge.getChannels(community.id)
      setChannels(channels)
      handleClose()
    } catch (err) {
      setCreateError(err)
      console.error('Failed to create community:', err)
    }
    setIsLoading(false)
  }

  const handleJoin = async () => {
    if (!inviteLink.trim()) return
    setIsLoading(true)
    setJoinError(null)
    setJoinStatus('')
    try {
      if (matrixMode) {
        const pending = await bridge.storePendingInvitation(inviteLink.trim())
        useShellStore.getState().setPendingInvitation(pending)
        showToast('Review the invitation details before Mesh continues.', 'success')
        handleClose()
        setIsLoading(false)
        return
      }
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
      setChannels(channels)
      handleClose()
    } catch (err) {
      setJoinError(err)
      console.error('Failed to join community:', err)
    }
    setIsLoading(false)
  }

  const handleDirectorySearch = async () => {
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
        setChannels(await bridge.getChannels(community.id))
        handleClose()
        return
      }

      const result = await bridge.requestCommunityAccess(target, applicationReason)
      if (result.status === 'joined' && result.community) {
        addCommunity(result.community)
        setActiveCommunity(result.community.id)
        setChannels(await bridge.getChannels(result.community.id))
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (tab === 'create') {
        if (createStep === 1 && communityName.trim()) setCreateStep(2)
        else if (createStep === 2) void handleCreate()
      }
      else if (tab === 'join') handleJoin()
      else handleDirectorySearch()
    }
  }

  const modalTitle = tab === 'create'
    ? 'Create a community'
    : tab === 'join'
      ? 'Join a community'
      : 'Discover communities'
  const modalDescription = tab === 'create'
    ? 'Start a focused space for the people you talk with.'
    : tab === 'join'
      ? matrixMode
        ? 'Paste the invite you received.'
        : 'Paste the invite link you received.'
      : 'Search the public community directory. New members may need approval.'

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title={modalTitle}
      description={modalDescription}
    >
      <div>
        {/* Tab switcher */}
        <div className="mb-5 flex rounded-control bg-surface-hover p-1">
          {tabs.map((t) => (
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
                  className="absolute inset-0 rounded-control bg-surface-active"
                  transition={transitions.enter}
                />
              )}
              <span className="relative z-sticky capitalize">
                {t === 'create' ? 'Create' : t === 'join' ? 'Join' : 'Discover'}
              </span>
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
              transition={transitions.enter}
            >
              <p className="mb-4 text-xs text-muted">
                Step {createStep} of 2 · {createStep === 1 ? 'Name and icon' : 'Choose a starting layout'}
              </p>

              {createStep === 1 ? (
                <div className="space-y-3">
                  <Input
                    label="Community Name"
                    value={communityName}
                    onChange={(value: string) => {
                      setCommunityName(value)
                      setCreateError(null)
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="e.g. Design Club"
                    autoFocus
                  />
                  <fieldset>
                    <legend className="mb-1.5 text-xs font-semibold uppercase text-muted">
                      Icon
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      {SERVER_ICONS.map((icon) => (
                        <button
                          key={icon}
                          type="button"
                          className={`flex h-10 w-10 items-center justify-center rounded-md text-lg ${
                            communityIcon === icon
                              ? 'bg-accent ring-2 ring-accent'
                               : 'bg-surface-hover hover:bg-surface-active'
                          }`}
                          aria-label={`Use ${icon} as the community icon`}
                          aria-pressed={communityIcon === icon}
                          onClick={() => setCommunityIcon(icon)}
                        >
                          {icon}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase text-muted">
                      Description
                    </label>
                    <textarea
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
                <fieldset className="space-y-2">
                  <legend className="sr-only">Community template</legend>
                  {(Object.entries(SERVER_TEMPLATES) as Array<
                    [ServerTemplate, (typeof SERVER_TEMPLATES)[ServerTemplate]]
                  >).map(([value, template]) => (
                    <button
                      key={value}
                      type="button"
                      className={`w-full rounded-panel border p-3 text-left ${
                        serverTemplate === value
                          ? 'border-accent bg-accent/10'
                          : 'border-border-subtle bg-surface-hover hover:bg-surface-active'
                      }`}
                      aria-pressed={serverTemplate === value}
                      onClick={() => setServerTemplate(value)}
                    >
                      <span className="block text-sm font-semibold text-primary">{template.label}</span>
                      <span className="mt-1 block text-xs text-muted">{template.description}</span>
                    </button>
                  ))}
                </fieldset>
              )}

              {createError != null && (
                <ErrorState
                  error={createError}
                  context={{ operation: 'create this community', resource: 'community' }}
                  onAction={handleCreate}
                  className="mt-3"
                  compact
                />
              )}

              <div className="mt-4 flex gap-2">
                {createStep === 2 && (
                  <Button variant="ghost" onClick={() => setCreateStep(1)} disabled={isLoading}>
                    Back
                  </Button>
                )}
                <Button
                  onClick={() => {
                    if (createStep === 1) setCreateStep(2)
                    else void handleCreate()
                  }}
                  disabled={!communityName.trim() || isLoading}
                  className="flex-1"
                >
                  {createStep === 1 ? 'Next' : isLoading ? 'Creating…' : 'Create Community'}
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
                label="Invite code or link"
                value={inviteLink}
                onChange={(v: string) => {
                  setInviteLink(v)
                  setJoinError(null)
                  setJoinStatus('')
                }}
                onKeyDown={handleKeyDown}
                placeholder={matrixMode ? 'mesh.app/i/aB3xK9' : 'Paste your invite link'}
                autoFocus
              />

              {joinError != null && (
                <ErrorState
                  error={joinError}
                  context={{ operation: 'join this community', resource: 'community' }}
                  onAction={handleJoin}
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

              <Button
                onClick={handleJoin}
                disabled={!inviteLink.trim() || isLoading}
                className="mt-4 w-full"
              >
                {isLoading ? 'Joining…' : 'Join Community'}
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
              <div className="space-y-3">
                <Input
                  label="Search"
                  value={directoryQuery}
                  onChange={setDirectoryQuery}
                  onKeyDown={handleKeyDown}
                  placeholder="Community name or topic"
                  autoFocus
                />
                <Input
                  label="Search source (optional)"
                  value={directoryServer}
                  onChange={setDirectoryServer}
                  onKeyDown={handleKeyDown}
                  placeholder="Leave blank to search Mesh"
                />
                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase text-muted">
                    Application note (optional)
                  </label>
                  <textarea
                    value={applicationReason}
                    onChange={(event) => setApplicationReason(event.target.value)}
                    rows={2}
                    className="w-full resize-none rounded-control border border-border bg-surface-sunken px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                    placeholder="Why would you like to join?"
                  />
                </div>
              </div>

              <Button onClick={handleDirectorySearch} disabled={isLoading} className="mt-4 w-full">
                {isLoading ? 'Searching…' : 'Search Directory'}
              </Button>

              {directoryError != null && (
                <ErrorState
                  error={directoryError}
                  context={{ operation: 'search or join from the community directory', resource: 'community' }}
                  className="mt-3"
                  compact
                />
              )}

              <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
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
                  <p className="py-3 text-center text-xs text-muted">Search to find public communities.</p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Modal>
  )
}
