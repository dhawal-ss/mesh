import { useCallback, useEffect, useMemo, useState } from 'react'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useDmStore } from '../../store/dms'
import { dmPrimaryPeer, type DirectoryPerson } from '../../types/ipc'
import { useIdentityStore } from '../../store/identity'
import { useMembershipStore } from '../../store/membership'
import { useVoiceStore } from '../../store/voice'
import * as bridge from '../../lib/bridge'
import { showToast } from '../ui/Toast'
import {
  Command,
  fuzzySearchScore,
  type ComboboxOption,
} from '../ui/InteractivePrimitives'
import { Modal } from '../ui/Modal'
import { Kbd } from '../ui/Primitives'
import { Icon, type IconName } from '../ui/Icon'
import { COMMAND_PALETTE_OPEN_EVENT } from '../../lib/command-palette'
import { isMatrixUserId } from '../../lib/structured-mentions'
import { describeError, normalizeError, errorLine } from '../../lib/errors'
import { safeLocalStorageGet, safeLocalStorageSet } from '../../lib/safe-storage'
import { useMeshNavigationStore } from '../../store/navigation'
import { shouldExposeVoiceRoutes } from '../../lib/voice-runtime'

/**
 * Long enough that typing a name is one search rather than six, short enough
 * that the answer arrives while the person is still looking at the field.
 */
const DIRECTORY_SEARCH_DEBOUNCE_MS = 250

const RECENT_COMMANDS_KEY = 'mesh-command-palette-recents'
const MAX_RECENT_COMMANDS = 20

interface PaletteCommand {
  id: string
  group: 'Communities' | 'Rooms' | 'Messages' | 'People' | 'Settings' | 'Actions'
  title: string
  subtitle?: string
  icon: IconName
  keywords: string[]
  activityRank: number
  run: () => void | Promise<void>
}

const SHORTCUTS = [
  ['Ctrl/⌘ K', 'Open command palette', false],
  ['Ctrl/⌘ Shift A', 'Jump to next unread room', false],
  ['Alt ↑ / ↓', 'Previous / next room', false],
  ['Ctrl/⌘ Alt ↑ / ↓', 'Previous / next community', false],
  ['Esc', 'Mark the current room read', false],
  ['↑ in empty composer', 'Edit your latest message', false],
  ['Shift Esc', 'Mark the current community read', false],
  ['Ctrl/⌘ Shift M', 'Toggle mute', true],
  ['Ctrl/⌘ Shift D', 'Toggle deafen', true],
  ['Ctrl/⌘ /', 'Show keyboard shortcuts', false],
] as const

function loadRecents(): string[] {
  try {
    const value = JSON.parse(safeLocalStorageGet(RECENT_COMMANDS_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_RECENT_COMMANDS)
  } catch {
    return []
  }
}

function saveRecent(commandId: string, current: string[]): string[] {
  const next = [commandId, ...current.filter((id) => id !== commandId)].slice(0, MAX_RECENT_COMMANDS)
  safeLocalStorageSet(RECENT_COMMANDS_KEY, JSON.stringify(next))
  return next
}

export function sortCommandsByRecency<T extends { id: string }>(
  commands: T[],
  recents: string[],
): T[] {
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

export function parsePaletteQuery(query: string): {
  scope: 'rooms' | 'people' | 'communities' | null
  term: string
} {
  const normalized = query.trimStart()
  const sigil = normalized[0]
  if (sigil === '#') return { scope: 'rooms', term: normalized.slice(1).trimStart() }
  if (sigil === '@') return { scope: 'people', term: normalized.slice(1).trimStart() }
  if (sigil === '*') return { scope: 'communities', term: normalized.slice(1).trimStart() }
  return { scope: null, term: normalized }
}

export function filterPaletteOptions(
  options: ComboboxOption[],
  query: string,
): ComboboxOption[] {
  const { scope, term } = parsePaletteQuery(query)
  const scoped = scope === 'rooms'
    ? options.filter((option) => option.value.startsWith('channel:'))
    : scope === 'people'
      ? options.filter((option) => (
          option.value.startsWith('dm:')
          || option.value.startsWith('person:')
          // A typed address is a person. It has to survive the `@` sigil, which
          // every full Matrix address begins with, or the one query that most
          // clearly means "this person" is the one that hides them.
          || option.value.startsWith('address:')
        ))
      : scope === 'communities'
        ? options.filter((option) => option.value.startsWith('server:'))
        : options
  const normalized = term.trim().toLocaleLowerCase()
  if (!normalized) return scoped

  return scoped
    .map((option, optionIndex) => {
      const scores = [option.label, ...(option.keywords ?? [])]
        .map((candidate) => fuzzySearchScore(candidate, normalized))
        .filter((score): score is number => score !== null)
      return {
        option,
        optionIndex,
        score: scores.length > 0 ? Math.min(...scores) : null,
      }
    })
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.optionIndex - right.optionIndex)
    .map(({ option }) => option)
}

/**
 * How many recent commands the empty palette offers back.
 *
 * Three, the same count Home features under `Continue`. The palette and Home
 * then tell one story about resumption instead of two, and a longer list would
 * simply be the whole activity ranking with a different heading on it.
 */
export const RECENT_GROUP_SIZE = 3

/**
 * Lifts the last few commands into a leading `Recent` group.
 *
 * Only while the query is empty: once someone is typing, the ranked match is
 * the answer and a pinned block of history is in the way. Everything else
 * keeps its own taxonomy heading, so no command appears twice.
 */
export function withRecentGroup(
  options: ComboboxOption[],
  recents: string[],
  query: string,
): ComboboxOption[] {
  if (query.trim()) return options
  const byValue = new Map(options.map((option) => [option.value, option] as const))
  const recent = recents
    .map((id) => byValue.get(id))
    .filter((option): option is ComboboxOption => option !== undefined)
    .slice(0, RECENT_GROUP_SIZE)
  if (recent.length === 0) return options
  const recentValues = new Set(recent.map((option) => option.value))
  return [
    ...recent.map((option) => ({ ...option, group: 'Recent', groupTone: 'accent' as const })),
    ...options.filter((option) => !recentValues.has(option.value)),
  ]
}

export function sortCommandsByActivity<T extends { activityRank: number }>(
  commands: T[],
): T[] {
  return commands
    .map((command, index) => ({ command, index }))
    .sort((left, right) => (
      right.command.activityRank - left.command.activityRank
      || left.index - right.index
    ))
    .map(({ command }) => command)
}

export function accountServiceContext(userId: string): string | null {
  const separator = userId.lastIndexOf(':')
  const service = separator >= 0 ? userId.slice(separator + 1).trim() : ''
  return service
    ? `Account service: ${service}`
    : null
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

/**
 * Clears one room's unread state.
 *
 * Returns whether anything was actually cleared, so a caller that fired from
 * the keyboard can say so exactly once: silently discarding unread state is
 * the failure mode this guards against, and a sweep across a community must
 * not produce one toast per room.
 */
function markChannelRead(channelId: string): boolean {
  const channel = useChannelStore.getState().channelEntities[channelId]
  if (!channel || (channel.unreadCount ?? 0) === 0) return false
  useChannelStore.getState().patchChannel(channelId, { unreadCount: 0, unreadMentions: 0 })
  void bridge.markChannelRead(channelId).catch(() => {
    useChannelStore.getState().patchChannel(channelId, {
      unreadCount: channel.unreadCount,
      unreadMentions: channel.unreadMentions,
    })
    showToast('This room could not be marked as read. Try again.', 'error')
  })
  return true
}

/**
 * Whether the keyboard focus is parked inside a message timeline.
 *
 * Escape is the key a screen-reader or keyboard user presses most reflexively,
 * and NVDA uses it to leave focus mode, so a timeline that has the caret must
 * not treat it as "discard this room's unread state". This reads the focused
 * element rather than the browse-mode virtual cursor, which no API exposes, so
 * it covers focus mode and a clicked row and cannot cover everything.
 */
function isInsideMessageFeed(target: EventTarget | null): boolean {
  const focused = target instanceof HTMLElement ? target : document.activeElement
  return focused instanceof HTMLElement && focused.closest('[role="feed"]') !== null
}

function selectChannel(channelId: string) {
  const channel = useChannelStore.getState().channelEntities[channelId]
  if (!channel) return
  if (
    channel.channelType === 'voice'
    && !shouldExposeVoiceRoutes(bridge.isMatrixBackend(), bridge.getBackendStatusSnapshot())
  ) return
  useDmStore.getState().setDmMode(false)
  useCommunityStore.getState().setActiveCommunity(channel.communityId)
  useChannelStore.getState().setActiveChannel(channel.id)
  useMeshNavigationStore.getState().navigate({
    kind: channel.channelType === 'voice' ? 'voice' : 'room',
    communityId: channel.communityId,
    roomId: channel.id,
  })
}

function selectCommunity(communityId: string) {
  useDmStore.getState().setDmMode(false)
  useCommunityStore.getState().setActiveCommunity(communityId)
  useMeshNavigationStore.getState().navigate({ kind: 'community', communityId })
}

function selectConversation(conversationId: string) {
  useDmStore.getState().setDmMode(true)
  useDmStore.getState().setActiveConversation(conversationId)
  useMeshNavigationStore.getState().navigate({ kind: 'direct', conversationId })
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
  const [scope, setScope] = useState<'all' | 'people'>('all')
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [recents, setRecents] = useState(loadRecents)
  const [query, setQuery] = useState('')
  /*
    One answer, stamped with the term it answers. Everything else is derived
    from comparing that stamp against what is currently typed, so no effect
    has to synchronously reset state to clear a stale result -- which is both
    a cascading render and the diagnostic Lane D5 is driving to zero.
  */
  const [directoryAnswer, setDirectoryAnswer] = useState<
    { term: string; people: readonly DirectoryPerson[]; truncated: boolean } | null
  >(null)
  const matrixMode = bridge.isMatrixBackend()
  const voiceAvailable = bridge.getBackendCapabilities().voice
    && shouldExposeVoiceRoutes(matrixMode, bridge.getBackendStatusSnapshot())

  const commands = useMemo<PaletteCommand[]>(() => {
    const entries: PaletteCommand[] = []

    for (const community of communities) {
      entries.push({
        id: `server:${community.id}`,
        group: 'Communities',
        title: community.name,
        subtitle: community.description || `${community.memberCount} members`,
        icon: 'users',
        keywords: [community.name, community.description],
        activityRank: community.id === activeCommunityId ? 850 : 700,
        run: () => selectCommunity(community.id),
      })
    }

    for (const channel of channels) {
      if (channel.channelType === 'voice' && !voiceAvailable) continue
      const communityName = communities.find((community) => community.id === channel.communityId)?.name ?? ''
      entries.push({
        id: `channel:${channel.id}`,
        group: 'Rooms',
        title: channel.name,
        subtitle: `${communityName} › ${channel.channelType === 'voice' ? 'Voice room' : 'Text room'}`,
        icon: channel.channelType === 'voice' ? 'volume' : 'hash',
        keywords: [channel.channelType, channel.name, communityName],
        activityRank: channel.id === activeChannelId
          ? 1_000
          : (channel.unreadCount ?? 0) > 0
            ? 900 + Math.min(channel.unreadCount ?? 0, 99)
            : 600,
        run: () => selectChannel(channel.id),
      })
    }

    for (const conversation of conversations) {
      const serviceContext = accountServiceContext(dmPrimaryPeer(conversation).userId)
      const lastActivity = conversation.lastMessageAt
        ? Date.parse(conversation.lastMessageAt)
        : 0
      entries.push({
        id: `dm:${conversation.id}`,
        group: 'Messages',
        title: dmPrimaryPeer(conversation).displayName,
        subtitle: serviceContext
          ? `Direct message › ${serviceContext}`
          : 'Direct message',
        icon: 'messageCircle',
        keywords: ['dm', 'direct message', dmPrimaryPeer(conversation).displayName, dmPrimaryPeer(conversation).userId],
        activityRank: 800 + (
          Number.isFinite(lastActivity)
            ? Math.min(lastActivity / 10_000_000_000_000, 0.99)
            : 0
        ),
        run: () => selectConversation(conversation.id),
      })
    }

    const existingDmByUser = new Map(
      conversations.map((conversation) => [dmPrimaryPeer(conversation).userId, conversation] as const),
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
          group: 'People',
          title: member.displayName,
          subtitle: [
            communityName,
            accountServiceContext(member.publicKey),
          ].filter(Boolean).join(' › ') || 'Start a conversation',
          icon: 'userPlus',
          keywords: [member.displayName, member.publicKey, communityName],
          activityRank: communityId === activeCommunityId ? 550 : 500,
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
        id: 'action:go-to-inbox',
        group: 'Actions',
        title: 'Go to Inbox',
        icon: 'inbox',
        keywords: ['inbox', 'unread', 'attention', 'mentions'],
        activityRank: 150,
        run: () => {
          useMeshNavigationStore.getState().navigate({ kind: 'inbox' })
        },
      },
      {
        id: 'settings:profile',
        group: 'Settings',
        title: 'Profile and preferences',
        icon: 'settings',
        keywords: ['profile', 'preferences', 'account'],
        activityRank: 200,
        run: () => {
          useMeshNavigationStore.getState().navigate({ kind: 'you', section: 'profile' })
        },
      },
      {
        id: 'action:create-server',
        group: 'Actions',
        title: 'Create a community',
        icon: 'plus',
        keywords: ['create', 'new', 'community'],
        activityRank: 100,
        run: () => {
          useMeshNavigationStore.getState().navigate({ kind: 'communities', mode: 'create' })
        },
      },
      {
        id: 'action:join-server',
        group: 'Actions',
        title: 'Join a community',
        icon: 'userPlus',
        keywords: ['join', 'invite', 'community'],
        activityRank: 100,
        run: () => {
          useMeshNavigationStore.getState().navigate({ kind: 'communities', mode: 'join' })
        },
      },
    )
    if (voiceAvailable) {
      entries.push(
        {
        id: 'action:toggle-mute',
        group: 'Actions',
        title: `${isMuted ? 'Unmute' : 'Mute'} microphone`,
        icon: isMuted ? 'mic' : 'micOff',
        keywords: ['toggle', 'mute', 'microphone', 'voice'],
        activityRank: 100,
        run: () => useVoiceStore.getState().setMuted(!useVoiceStore.getState().isMuted),
        },
        {
        id: 'action:toggle-deafen',
        group: 'Actions',
        title: `${isDeafened ? 'Undeafen' : 'Deafen'} audio`,
        icon: isDeafened ? 'headphones' : 'headphoneOff',
        keywords: ['toggle', 'deafen', 'audio', 'voice'],
        activityRank: 100,
        run: () => useVoiceStore.getState().setDeafened(!useVoiceStore.getState().isDeafened),
        },
      )
    }
    entries.push(
      {
        id: 'action:show-shortcuts',
        group: 'Actions',
        title: 'Show keyboard shortcuts',
        icon: 'settings',
        keywords: ['keyboard', 'shortcut', 'keys', 'help'],
        activityRank: 100,
        run: () => setShortcutsOpen(true),
      },
    )

    return entries
  }, [
    activeChannelId,
    activeCommunityId,
    channels,
    communities,
    conversations,
    isDeafened,
    isMuted,
    matrixMode,
    membersByCommunity,
    ownPublicKey,
    voiceAvailable,
  ])

  /*
    The people list is built from communities this account has joined plus
    conversations it already has, so an account with neither had "Message a
    friend" offered to it and nothing behind it. There is no roster to draw
    from in that state and there never will be; what there is, is the thing
    Matrix identity actually gives you -- an address somebody told you.

    Offered only when what has been typed is a full address, so it never
    competes with a name being typed. The backend refuses an address no
    service knows, which is what keeps a typo from becoming a conversation
    that looks delivered forever.
  */
  const typedAddressCommand = useMemo<PaletteCommand | null>(() => {
    if (!matrixMode) return null
    const address = query.trim()
    if (!isMatrixUserId(address) || address === ownPublicKey) return null
    // Somebody already in the list, or already in a conversation, is reached
    // through that entry rather than through a second one that would open a
    // duplicate room.
    if (commands.some((command) => command.id === `person:${address}`)) return null
    const existingDm = conversations
      .find((conversation) => dmPrimaryPeer(conversation).userId === address)
    return {
      id: `address:${address}`,
      group: 'People',
      title: `Message ${address}`,
      subtitle: existingDm
        ? 'Open your conversation'
        : accountServiceContext(address) || 'Start a conversation',
      icon: 'userPlus',
      keywords: [address],
      activityRank: 600,
      run: async () => {
        const conversation = existingDm ?? await bridge.ensureDm(address)
        useDmStore.getState().upsertConversation(conversation)
        selectConversation(conversation.id)
      },
    }
  }, [commands, conversations, matrixMode, ownPublicKey, query])

  /*
    What has been typed leaves this machine only when somebody is explicitly
    looking for a person: the palette was opened to start a conversation, or
    the query carries the `@` sigil that means "people". The general command
    palette does not ship keystrokes to a homeserver to find a settings page.

    A complete address is excluded too. typedAddressCommand already handles it
    and ensure_dm confirms it, so searching would send a resolved address for
    no answer worth having.
  */
  const directoryTerm = useMemo(() => {
    if (!matrixMode) return ''
    const { scope: sigil, term } = parsePaletteQuery(query)
    const looking = scope === 'people' || sigil === 'people'
    const trimmed = term.trim()
    if (!looking || trimmed.length < 2 || isMatrixUserId(query.trim())) return ''
    return trimmed
  }, [matrixMode, query, scope])

  useEffect(() => {
    if (!directoryTerm) return
    let active = true
    const handle = window.setTimeout(() => {
      void bridge.searchPersonDirectory(directoryTerm)
        .then((result) => {
          if (!active) return
          setDirectoryAnswer({
            term: directoryTerm,
            people: result.people,
            truncated: result.truncated,
          })
        })
        .catch((error) => {
          if (!active) return
          // A superseded keystroke cancels the one before it. That is the
          // mechanism working, not a failure worth showing anybody.
          if (normalizeError(error).code === 'cancelled') return
          setDirectoryAnswer({ term: directoryTerm, people: [], truncated: false })
        })
    }, DIRECTORY_SEARCH_DEBOUNCE_MS)
    return () => {
      active = false
      window.clearTimeout(handle)
    }
  }, [directoryTerm])

  // Either the stored answer object or null, both stable references, so this
  // is safe to depend on directly. A `?? []` fallback beside it would not be:
  // a fresh array every render defeats every memo downstream.
  const answeredTerm = directoryAnswer?.term === directoryTerm ? directoryAnswer : null
  const directoryState = !directoryTerm
    ? 'idle'
    : answeredTerm
      ? 'answered'
      : 'searching'

  const directoryCommands = useMemo<PaletteCommand[]>(() => {
    if (!directoryTerm) return []
    const existingDmByUser = new Map(
      conversations.map((conversation) => [dmPrimaryPeer(conversation).userId, conversation] as const),
    )
    return (answeredTerm?.people ?? [])
      .filter((person) => (
        person.userId !== ownPublicKey
        // Somebody already reachable is reached through the entry that knows
        // which community they are in, rather than through a second one.
        && !commands.some((command) => command.id === `person:${person.userId}`)
      ))
      .map((person) => ({
        id: `directory:${person.userId}`,
        group: 'People',
        title: person.displayName,
        subtitle: [person.userId, accountServiceContext(person.userId)]
          .filter(Boolean).join(' › '),
        icon: 'userPlus' as IconName,
        keywords: [person.displayName, person.userId],
        activityRank: 450,
        run: async () => {
          const existingDm = existingDmByUser.get(person.userId)
          const conversation = existingDm ?? await bridge.ensureDm(person.userId)
          useDmStore.getState().upsertConversation(conversation)
          selectConversation(conversation.id)
        },
      }))
  }, [answeredTerm, commands, conversations, directoryTerm, ownPublicKey])

  const allCommands = useMemo(
    () => [
      ...(typedAddressCommand ? [typedAddressCommand] : []),
      ...directoryCommands,
      ...commands,
    ],
    [commands, directoryCommands, typedAddressCommand],
  )

  const orderedCommands = useMemo(
    () => sortCommandsByRecency(sortCommandsByActivity(allCommands), recents),
    [allCommands, recents],
  )
  const scopedCommands = useMemo(
    () => scope === 'people'
      ? orderedCommands.filter((command) => command.group === 'People' || command.group === 'Messages')
      : orderedCommands,
    [orderedCommands, scope],
  )
  const commandById = useMemo(
    () => new Map(allCommands.map((command) => [command.id, command] as const)),
    [allCommands],
  )
  const options = useMemo<ComboboxOption[]>(
    () => scopedCommands.map((command) => ({
      value: command.id,
      label: command.title,
      group: command.group,
      title: command.title,
      subtitle: command.subtitle,
      icon: <Icon name={command.icon} size="sm" />,
      keywords: command.keywords,
    })),
    [scopedCommands],
  )
  /*
   * Recency is applied at filter time rather than baked into the option list,
   * because only the filter knows whether anything has been typed yet.
   */
  const filterOptions = useCallback(
    (candidates: ComboboxOption[], query: string) => (
      withRecentGroup(filterPaletteOptions(candidates, query), recents, query)
    ),
    [recents],
  )

  useEffect(() => {
    const openPalette = (event: Event) => {
      const nextScope = event instanceof CustomEvent && event.detail === 'people'
        ? 'people'
        : 'all'
      setScope(nextScope)
      setOpen(true)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      // Another handler (the navigation drawer, the room-context panel) has
      // already claimed this key. Without this guard, Escape both dismissed the
      // drawer and silently marked the room read.
      if (event.defaultPrevented) return
      const primary = event.ctrlKey || event.metaKey
      const key = event.key.toLocaleLowerCase()
      if (primary && !event.altKey && !event.shiftKey && key === 'k') {
        event.preventDefault()
        setOpen((current) => {
          const nextOpen = !current
          if (nextOpen) setScope('all')
          return nextOpen
        })
        return
      }
      if (primary && !event.altKey && !event.shiftKey && event.key === '/') {
        event.preventDefault()
        setShortcutsOpen(true)
        return
      }
      if (open || shortcutsOpen) return

      // Hoisted above the mute/deafen/next-unread/mark-read branches. It used to
      // sit below them, so Shift+Escape mid-compose wiped unread state across
      // every room in the community while the user was typing.
      if (isEditableTarget(event.target)) return

      if (voiceAvailable && primary && event.shiftKey && !event.altKey && key === 'm') {
        event.preventDefault()
        const voice = useVoiceStore.getState()
        voice.setMuted(!voice.isMuted)
        return
      }
      if (voiceAvailable && primary && event.shiftKey && !event.altKey && key === 'd') {
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
        const cleared = channels
          .filter((channel) => channel.communityId === activeCommunityId && channel.unreadCount > 0)
          .filter((channel) => markChannelRead(channel.id))
        if (cleared.length > 0) {
          showToast(
            cleared.length === 1
              ? 'Marked 1 room as read.'
              : `Marked ${cleared.length} rooms as read.`,
            'success',
          )
        }
        return
      }

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
        // Radix popovers, tooltips, context menus and our own drawers all mark
        // themselves with data-state="open". Matching on the attribute alone
        // (rather than only on role="dialog") stops Escape-to-dismiss-a-popover
        // from also marking the room read.
        && !document.querySelector('[data-state="open"]')
        // Escape inside the timeline is "leave this control", not "throw away
        // what I have not read". The room list, the context menu and the
        // unread divider all keep an explicit mark-read action.
        && !isInsideMessageFeed(event.target)
        && activeChannelId
      ) {
        // Announced, because this is otherwise an invisible, unprompted and
        // irreversible change to state the person was relying on. The read
        // receipt has left the device by the time a toast could offer an undo,
        // so this reports rather than pretends to offer one.
        if (markChannelRead(activeChannelId)) {
          showToast('Escape marked this room as read.', 'success')
        }
      }
    }

    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, openPalette)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, openPalette)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    activeChannelId,
    activeCommunityId,
    channels,
    communities,
    open,
    shortcutsOpen,
    voiceAvailable,
  ])

  /*
    Worded as the service's answer, never as absence. Most homeservers publish
    only people who share a room with the searcher or are in public rooms, so
    an account with no communities -- the account this whole path exists for --
    can get nothing back from a service behaving exactly as designed. Saying
    "no such person" there would be Mesh inventing a fact, and it would be
    wrong precisely for the people least able to check.
  */
  const directoryNote = useMemo(() => {
    if (!directoryTerm) return null
    if (directoryState === 'searching') return 'Asking your account service…'
    if (directoryState !== 'answered') return null
    if (directoryCommands.length === 0) {
      return `Your account service found nobody published under “${directoryTerm}”. `
        + 'Type their full address instead.'
    }
    return answeredTerm?.truncated
      ? 'More matches than shown. Narrow the search or type a full address.'
      : 'Found through your account service.'
  }, [directoryCommands.length, directoryState, directoryTerm, answeredTerm?.truncated])

  const execute = async (commandId: string) => {
    const command = commandById.get(commandId)
    if (!command) return
    setRecents((current) => saveRecent(commandId, current))
    try {
      await command.run()
    } catch (error) {
      // "That action could not be completed" was all this said, which is the
      // least useful thing to hear after typing an address: whether it was a
      // typo, a blocked account or an unreachable service is the whole
      // question, and the backend already answers it.
      const description = describeError(error, { operation: 'run that command' })
      showToast(errorLine(description), 'error')
      throw error
    }
  }

  return (
    <>
      <Command
        open={open}
        onOpenChange={setOpen}
        title={scope === 'people' ? 'Start a private conversation' : 'Command palette'}
        description={scope === 'people'
          ? 'Find people from your communities and conversations.'
          : 'Rooms, people, settings, and actions'}
        placeholder={scope === 'people' ? 'Find someone to message…' : 'Search Mesh…'}
        options={options}
        onSelect={execute}
        filterOptions={filterOptions}
        onQueryChange={setQuery}
        note={directoryNote}
        maxEmptyOptions={20}
      />
      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title="Keyboard shortcuts"
        description="Navigate Mesh without leaving the keyboard."
      >
        <dl className="space-y-2">
          {SHORTCUTS.filter(([, , voiceOnly]) => !voiceOnly || voiceAvailable)
            .map(([keys, description]) => (
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
