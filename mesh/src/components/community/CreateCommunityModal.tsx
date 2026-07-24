import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { useCommunityStore } from '../../store/communities'
import { useChannelStore } from '../../store/channels'
import * as bridge from '../../lib/bridge'
import { transitions } from '../../lib/motion'
import type { CommunityDirectoryEntry } from '../../types/ipc'

type Tab = 'create' | 'join' | 'discover'

interface CreateCommunityModalProps {
  isOpen: boolean
  onClose: () => void
}

export function CreateCommunityModal({ isOpen, onClose }: CreateCommunityModalProps) {
  const matrixMode = bridge.isMatrixBackend()
  const tabs: Tab[] = matrixMode ? ['create', 'join', 'discover'] : ['create', 'join']
  const [tab, setTab] = useState<Tab>('create')
  const [isLoading, setIsLoading] = useState(false)

  const [communityName, setCommunityName] = useState('')
  const [communityDescription, setCommunityDescription] = useState('')

  const [inviteLink, setInviteLink] = useState('')
  const [joinError, setJoinError] = useState('')
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [directoryServer, setDirectoryServer] = useState('')
  const [directoryResults, setDirectoryResults] = useState<CommunityDirectoryEntry[]>([])
  const [directoryError, setDirectoryError] = useState('')
  const [applicationReason, setApplicationReason] = useState('')
  const [directoryStatus, setDirectoryStatus] = useState<Record<string, string>>({})

  const addCommunity = useCommunityStore((s) => s.addCommunity)
  const setActiveCommunity = useCommunityStore((s) => s.setActiveCommunity)
  const setChannels = useChannelStore((s) => s.setChannels)

  const resetForm = () => {
    setCommunityName('')
    setCommunityDescription('')
    setInviteLink('')
    setJoinError('')
    setDirectoryQuery('')
    setDirectoryServer('')
    setDirectoryResults([])
    setDirectoryError('')
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

  const handleDirectorySearch = async () => {
    setIsLoading(true)
    setDirectoryError('')
    try {
      setDirectoryResults(
        await bridge.searchCommunityDirectory(directoryQuery, directoryServer || undefined),
      )
    } catch (err) {
      setDirectoryError(err instanceof Error ? err.message : 'Directory search failed')
    }
    setIsLoading(false)
  }

  const handleDirectoryAccess = async (entry: CommunityDirectoryEntry) => {
    const target = entry.alias ?? entry.id
    setIsLoading(true)
    setDirectoryError('')
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
        [entry.id]: 'Application sent. Select this community again after an administrator approves it.',
      }))
    } catch (err) {
      setDirectoryError(err instanceof Error ? err.message : 'Could not request access')
    }
    setIsLoading(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (tab === 'create') handleCreate()
      else if (tab === 'join') handleJoin()
      else handleDirectorySearch()
    }
  }

  return (
    <Modal open={isOpen} onClose={handleClose}>
      <div>
        {/* Tab switcher */}
        <div className="mb-5 flex rounded-md bg-bg-tertiary p-1">
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
                  className="absolute inset-0 rounded-md bg-bg-modifier-active"
                  transition={transitions.softSpring}
                />
              )}
              <span className="relative z-10 capitalize">
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
              transition={{ duration: 0.12 }}
            >
              <h2 className="mb-1 text-base font-semibold text-primary">Create a Server</h2>
              <p className="mb-4 text-xs text-muted">
                {matrixMode
                  ? 'Creates a private Matrix Space with an encrypted general room.'
                  : 'Your server is yours — fully decentralized, no central servers required.'}
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
          ) : tab === 'join' ? (
            <motion.div
              key="join"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.12 }}
            >
              <h2 className="mb-1 text-base font-semibold text-primary">Join a Server</h2>
              <p className="mb-4 text-xs text-muted">
                {matrixMode
                  ? 'Enter the Matrix Space room ID or alias from your invitation.'
                  : 'Paste an invite link to connect directly to the community mesh.'}
              </p>

              <Input
                label={matrixMode ? 'Space ID or alias' : 'Invite Link'}
                value={inviteLink}
                onChange={(v: string) => {
                  setInviteLink(v)
                  setJoinError('')
                }}
                onKeyDown={handleKeyDown}
                placeholder={matrixMode ? '!room:example.org or #community:example.org' : 'mesh://join?c=...'}
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
          ) : (
            <motion.div
              key="discover"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.12 }}
            >
              <h2 className="mb-1 text-base font-semibold text-primary">Discover Communities</h2>
              <p className="mb-4 text-xs text-muted">
                Search a Matrix homeserver directory. Discoverable Mesh communities require administrator approval by default.
              </p>

              <div className="space-y-3">
                <Input
                  label="Search"
                  value={directoryQuery}
                  onChange={setDirectoryQuery}
                  onKeyDown={handleKeyDown}
                  placeholder="Community name, topic, or alias"
                  autoFocus
                />
                <Input
                  label="Homeserver (optional)"
                  value={directoryServer}
                  onChange={setDirectoryServer}
                  onKeyDown={handleKeyDown}
                  placeholder="matrix.example.org"
                />
                <div>
                  <label className="mb-1.5 block text-xs font-bold uppercase text-muted">
                    Application note (optional)
                  </label>
                  <textarea
                    value={applicationReason}
                    onChange={(event) => setApplicationReason(event.target.value)}
                    rows={2}
                    className="w-full resize-none rounded-md bg-bg-tertiary px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none"
                    placeholder="Why would you like to join?"
                  />
                </div>
              </div>

              <Button onClick={handleDirectorySearch} disabled={isLoading} className="mt-4 w-full">
                {isLoading ? 'Searching…' : 'Search Directory'}
              </Button>

              {directoryError && <p className="mt-3 text-xs text-red">{directoryError}</p>}

              <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
                {directoryResults.map((entry) => (
                  <div key={entry.id} className="rounded-lg bg-bg-primary p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-primary">{entry.name}</p>
                        <p className="truncate text-xs text-text-link">{entry.alias ?? entry.id}</p>
                        {entry.description && (
                          <p className="mt-1 line-clamp-2 text-xs text-muted">{entry.description}</p>
                        )}
                        <p className="mt-1 text-[11px] text-muted">
                          {entry.memberCount} member{entry.memberCount === 1 ? '' : 's'} · {entry.joinRule}
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
                  <p className="py-3 text-center text-xs text-muted">Search to find published Matrix Spaces.</p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Modal>
  )
}
