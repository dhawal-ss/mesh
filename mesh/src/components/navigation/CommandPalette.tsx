import { useEffect, useMemo, useState } from 'react'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { useIdentityStore } from '../../store/identity'
import { useMembershipStore } from '../../store/membership'
import { useShellStore } from '../../store/shell'
import { useVoiceStore } from '../../store/voice'
import * as bridge from '../../lib/bridge'
import { showToast } from '../ui/Toast'
import { Command, type ComboboxOption } from '../ui/InteractivePrimitives'
import { Modal } from '../ui/Modal'
import { Kbd } from '../ui/Primitives'

const RECENT_COMMANDS_KEY = 'mesh-command-palette-recents'
const MAX_RECENT_COMMANDS = 20

interface PaletteCommand {
  id: string
  label: string
  keywords: string[]
  run: () => void | Promise<void>
}

const SHORTCUTS = [
  ['Ctrl/⌘ K', 'Open command palette'],
  ['Ctrl/⌘ Shift A', 'Jump to next unread channel'],
  ['Alt ↑ / ↓', 'Previous / next channel'],
  ['Ctrl/⌘ Alt ↑ / ↓', 'Previous / next server'],
  ['Esc', 'Mark the current channel read'],
  ['↑ in empty composer', 'Edit your latest message'],
  ['Shift Esc', 'Mark the current server read'],
  ['Ctrl/⌘ Shift M', 'Toggle mute'],
  ['Ctrl/⌘ Shift D', 'Toggle deafen'],
  ['Ctrl/⌘ /', 'Show keyboard shortcuts'],
] as const

function loadRecents(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_COMMANDS_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_RECENT_COMMANDS)
  } catch {
    return []
  }
}

function saveRecent(commandId: string, current: string[]): string[] {
  const next = [commandId, ...current.filter((id) => id !== commandId)].slice(0, MAX_RECENT_COMMANDS)
  try {
    window.localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next))
  } catch {
    // Navigation must keep working when storage is unavailable.
  }
  return next
}

export function sortCommandsByRecency(
  commands: PaletteCommand[],
  recents: string[],
): PaletteCommand[] {
  const positions = new Map(recents.map((id, index) => [id, index]))
  return commands
    .map((command, index) => ({ command, index, recent: positions.get(command.id) }))
    .sort((left, right) => {
      if (left.recent !== undefined && right.recent !== undefined) return left.recent - right.recent
      if (left.recent !== undefined) return -1
      if (right.recent !== undefined) return 1
      return left.index - right.index
    })
    .map(({ command }) => command)
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable
    || target.contentEditable === 'true'
    || target.closest('[contenteditable="true"]') !== null
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  )
}

export function nextCyclicIndex(currentIndex: number, length: number, direction: 1 | -1): number {
  if (length <= 0) return -1
  if (currentIndex < 0 || currentIndex >= length) return direction === 1 ? 0 : length - 1
  return (currentIndex + direction + length) % length
}

function markChannelRead(channelId: string) {
  const channel = useChannelStore.getState().channelEntities[channelId]
  if (!channel || (channel.unreadCount ?? 0) === 0) return
  useChannelStore.getState().patchChannel(channelId, { unreadCount: 0, unreadMentions: 0 })
  void bridge.markChannelRead(channelId).catch(() => {
    useChannelStore.getState().patchChannel(channelId, {
      unreadCount: channel.unreadCount,
      unreadMentions: channel.unreadMentions,
    })
    showToast('This channel could not be marked as read. Try again.', 'error')
  })
}

function selectChannel(channelId: string) {
  const channel = useChannelStore.getState().channelEntities[channelId]
  if (!channel) return
  useDmStore.getState().setDmMode(false)
  useCommunityStore.getState().setActiveCommunity(channel.communityId)
  useChannelStore.getState().setActiveChannel(channel.id)
}

function selectCommunity(communityId: string) {
  useDmStore.getState().setDmMode(false)
  useCommunityStore.getState().setActiveCommunity(communityId)
}

function selectConversation(conversationId: string) {
  useDmStore.getState().setDmMode(true)
  useDmStore.getState().setActiveConversation(conversationId)
}

export function CommandPalette() {
  const communities = useCommunityStore((state) => state.communities)
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId)
  const channels = useChannelStore((state) => state.channels)
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  const conversations = useDmStore((state) => state.conversations)
  const membersByCommunity = useMembershipStore((state) => state.members)
  const ownPublicKey = useIdentityStore((state) => state.identity?.publicKey)
  const isMuted = useVoiceStore((state) => state.isMuted)
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const [open, setOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [recents, setRecents] = useState(loadRecents)
  const matrixMode = bridge.isMatrixBackend()

  const commands = useMemo<PaletteCommand[]>(() => {
    const entries: PaletteCommand[] = []

    for (const community of communities) {
      entries.push({
        id: `server:${community.id}`,
        label: `Server · ${community.name}`,
        keywords: ['server', 'community', community.name, community.description],
        run: () => selectCommunity(community.id),
      })
    }

    for (const channel of channels) {
      const communityName = communities.find((community) => community.id === channel.communityId)?.name ?? ''
      entries.push({
        id: `channel:${channel.id}`,
        label: `${channel.channelType === 'voice' ? 'Voice' : 'Channel'} · ${channel.name}`,
        keywords: ['channel', channel.channelType, channel.name, communityName],
        run: () => selectChannel(channel.id),
      })
    }

    for (const conversation of conversations) {
      entries.push({
        id: `dm:${conversation.id}`,
        label: `Message · ${conversation.peerDisplayName}`,
        keywords: ['dm', 'direct message', conversation.peerDisplayName, conversation.peerPublicKey],
        run: () => selectConversation(conversation.id),
      })
    }

    const existingDmByUser = new Map(
      conversations.map((conversation) => [conversation.peerPublicKey, conversation] as const),
    )
    const seenPeople = new Set<string>()
    const orderedCommunityIds = [
      ...(activeCommunityId ? [activeCommunityId] : []),
      ...communities.map((community) => community.id).filter((id) => id !== activeCommunityId),
    ]
    for (const communityId of orderedCommunityIds) {
      const communityName = communities.find((community) => community.id === communityId)?.name ?? ''
      for (const member of membersByCommunity[communityId] ?? []) {
        if (
          member.publicKey === ownPublicKey
          || member.joinStatus !== 'joined'
          || member.banStatus !== 'none'
          || seenPeople.has(member.publicKey)
        ) continue
        const existingDm = existingDmByUser.get(member.publicKey)
        if (!matrixMode && !existingDm) continue
        seenPeople.add(member.publicKey)
        entries.push({
          id: `person:${member.publicKey}`,
          label: `Person · ${member.displayName}`,
          keywords: ['person', 'member', member.displayName, member.publicKey, communityName],
          run: async () => {
            const conversation = existingDm ?? await bridge.ensureDm(member.publicKey)
            useDmStore.getState().upsertConversation(conversation)
            selectConversation(conversation.id)
          },
        })
      }
    }

    entries.push(
      {
        id: 'settings:profile',
        label: 'Settings · Profile and preferences',
        keywords: ['settings', 'profile', 'preferences', 'account'],
        run: () => useShellStore.getState().setProfileOpen(true),
      },
      {
        id: 'action:create-server',
        label: 'Action · Create a server',
        keywords: ['action', 'create', 'new', 'server', 'community'],
        run: () => useShellStore.getState().openServerModal('create'),
      },
      {
        id: 'action:join-server',
        label: 'Action · Join a server',
        keywords: ['action', 'join', 'invite', 'server', 'community'],
        run: () => useShellStore.getState().openServerModal('join'),
      },
    )
    if (matrixMode) {
      entries.push({
        id: 'action:explore-servers',
        label: 'Action · Explore servers',
        keywords: ['action', 'explore', 'discover', 'search', 'server', 'community'],
        run: () => useShellStore.getState().openServerModal('discover'),
      })
    }
    entries.push(
      {
        id: 'action:toggle-mute',
        label: `Action · ${isMuted ? 'Unmute' : 'Mute'} microphone`,
        keywords: ['action', 'toggle', 'mute', 'microphone', 'voice'],
        run: () => useVoiceStore.getState().setMuted(!useVoiceStore.getState().isMuted),
      },
      {
        id: 'action:toggle-deafen',
        label: `Action · ${isDeafened ? 'Undeafen' : 'Deafen'} audio`,
        keywords: ['action', 'toggle', 'deafen', 'audio', 'voice'],
        run: () => useVoiceStore.getState().setDeafened(!useVoiceStore.getState().isDeafened),
      },
      {
        id: 'action:show-shortcuts',
        label: 'Action · Show keyboard shortcuts',
        keywords: ['action', 'keyboard', 'shortcut', 'keys', 'help'],
        run: () => setShortcutsOpen(true),
      },
    )

    return entries
  }, [
    activeCommunityId,
    channels,
    communities,
    conversations,
    isDeafened,
    isMuted,
    matrixMode,
    membersByCommunity,
    ownPublicKey,
  ])

  const orderedCommands = useMemo(
    () => sortCommandsByRecency(commands, recents),
    [commands, recents],
  )
  const commandById = useMemo(
    () => new Map(commands.map((command) => [command.id, command] as const)),
    [commands],
  )
  const options = useMemo<ComboboxOption[]>(
    () => orderedCommands.map((command) => ({
      value: command.id,
      label: command.label,
      keywords: command.keywords,
    })),
    [orderedCommands],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const primary = event.ctrlKey || event.metaKey
      const key = event.key.toLocaleLowerCase()
      if (primary && !event.altKey && !event.shiftKey && key === 'k') {
        event.preventDefault()
        setOpen((current) => !current)
        return
      }
      if (primary && !event.altKey && !event.shiftKey && event.key === '/') {
        event.preventDefault()
        setShortcutsOpen(true)
        return
      }
      if (open || shortcutsOpen) return

      if (primary && event.shiftKey && !event.altKey && key === 'm') {
        event.preventDefault()
        const voice = useVoiceStore.getState()
        voice.setMuted(!voice.isMuted)
        return
      }
      if (primary && event.shiftKey && !event.altKey && key === 'd') {
        event.preventDefault()
        const voice = useVoiceStore.getState()
        voice.setDeafened(!voice.isDeafened)
        return
      }
      if (primary && event.shiftKey && !event.altKey && key === 'a') {
        const state = useChannelStore.getState()
        const unread = state.channels.filter((channel) => channel.unreadCount > 0)
        if (unread.length === 0) return
        event.preventDefault()
        const currentIndex = unread.findIndex((channel) => channel.id === state.activeChannelId)
        selectChannel(unread[(currentIndex + 1) % unread.length].id)
        return
      }
      if (primary && event.altKey && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (communities.length === 0) return
        event.preventDefault()
        const currentIndex = communities.findIndex((community) => community.id === activeCommunityId)
        const direction = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = nextCyclicIndex(currentIndex, communities.length, direction)
        selectCommunity(communities[nextIndex].id)
        return
      }
      if (event.key === 'Escape' && event.shiftKey && activeCommunityId) {
        event.preventDefault()
        channels
          .filter((channel) => channel.communityId === activeCommunityId && channel.unreadCount > 0)
          .forEach((channel) => markChannelRead(channel.id))
        return
      }
      if (isEditableTarget(event.target)) return

      if (!primary && event.altKey && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const available = channels.filter((channel) => channel.communityId === activeCommunityId)
        if (available.length === 0) return
        event.preventDefault()
        const currentIndex = available.findIndex((channel) => channel.id === activeChannelId)
        const direction = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = nextCyclicIndex(currentIndex, available.length, direction)
        selectChannel(available[nextIndex].id)
        return
      }
      if (
        event.key === 'Escape'
        && !event.shiftKey
        && !document.querySelector('[role="dialog"][data-state="open"]')
        && activeChannelId
      ) {
        markChannelRead(activeChannelId)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    activeChannelId,
    activeCommunityId,
    channels,
    communities,
    open,
    shortcutsOpen,
  ])

  const execute = (commandId: string) => {
    const command = commandById.get(commandId)
    if (!command) return
    setRecents((current) => saveRecent(commandId, current))
    void Promise.resolve(command.run()).catch(() => {
      showToast('That action could not be completed. Try again.', 'error')
    })
  }

  return (
    <>
      <Command
        open={open}
        onOpenChange={setOpen}
        options={options}
        onSelect={execute}
      />
      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title="Keyboard shortcuts"
        description="Navigate Mesh without leaving the keyboard."
      >
        <dl className="space-y-2">
          {SHORTCUTS.map(([keys, description]) => (
            <div key={keys} className="flex items-center justify-between gap-4">
              <dt><Kbd>{keys}</Kbd></dt>
              <dd className="text-right text-sm text-content-secondary">{description}</dd>
            </div>
          ))}
        </dl>
      </Modal>
    </>
  )
}
