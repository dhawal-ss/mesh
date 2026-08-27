import lanternGuildEnvironment from '../assets/lantern-guild-environment.png'
import { ROOM_CONTEXT_OPEN_KEY } from '../lib/layout-preferences'
import { safeLocalStorageGet, safeLocalStorageSet } from '../lib/safe-storage'
import type { Channel, CommunityApplication, DirectMessage, Message } from '../types/ipc'

type PreviewIpcArgs = Record<string, unknown>

type PreviewCallback = (...args: unknown[]) => void
type PreviewLoadState = 'ready' | 'loading' | 'empty' | 'error'

const COMMUNITY_ID = '!lantern-guild:mesh.test'
const ACTIVE_ROOM_ID = '!concept-art:mesh.test'
const INVITED_COMMUNITY_ID = '!canyon-crew:canyon.example'
const INVITED_ROOM_ID = '!controller-lab:canyon.example'
let simulateVoice = false
let simulateInvitation = false
let simulateSignedOut = false
let simulateQueue = false
let simulateOffline = false
let simulateRoomState: PreviewLoadState = 'ready'
let simulateDmListState: PreviewLoadState = 'ready'
let simulateDmMessageState: PreviewLoadState = 'ready'
let simulateLargeTimeline = false
let previewQueueRestoreFailuresRemaining = 0
let previewQueueListenerFailuresRemaining = 0
let previewLoginAttemptCounter = 0
let activePreviewLoginAttemptIds = new Set<string>()
let performanceDirectMessages: DirectMessage[] = []

const initialPreviewApplications: CommunityApplication[] = [
  {
    userId: '@avery:open-matrix.example',
    displayName: 'Avery Stone',
    reason: 'I joined the last open playtest and would love to help with the next one.',
    requestedAt: '2026-08-04T21:18:00.000Z',
  },
  {
    userId: '@noor:matrix.org',
    displayName: 'Noor',
    reason: 'Maya shared the community after we met in a co-op accessibility group.',
    requestedAt: '2026-08-05T01:42:00.000Z',
  },
]

let previewApplications: CommunityApplication[] = []
let previewCommunityAccess = {
  alias: 'lantern-guild',
  discoverable: false,
  joinRule: 'invite',
}

const community = {
  id: COMMUNITY_ID,
  name: 'Lantern Guild',
  description: 'A late-night community for playtests, clips, art, and co-op runs.',
  memberCount: 15,
  role: 'owner',
  joinedAt: '2026-07-24T00:00:00.000Z',
  // A bundled asset path, not an mxc URI: Avatar passes a source it does not
  // have to resolve straight through, so the preview needs no native reader.
  avatarUrl: lanternGuildEnvironment,
}

const secondCommunity = {
  id: '!field-notes:mesh.test',
  name: 'Field Notes',
  description: 'A small community for exploration games, screenshots, and field notes.',
  memberCount: 8,
  role: 'member',
  joinedAt: '2026-07-26T00:00:00.000Z',
}

const channels: Channel[] = [
  { id: ACTIVE_ROOM_ID, communityId: COMMUNITY_ID, name: 'concept-art', topic: 'Reference, sketches, and work in progress. Post the source when you can.', channelType: 'text', unreadCount: 0, joined: true },
  { id: '!welcome:mesh.test', communityId: COMMUNITY_ID, name: 'welcome', topic: 'Start here. Say hello and pick up the reading list.', channelType: 'text', unreadCount: 2, joined: true },
  { id: '!announcements:mesh.test', communityId: COMMUNITY_ID, name: 'announcements', topic: 'Releases and schedule changes. Read only.', channelType: 'text', unreadCount: 1, joined: true },
  { id: '!lobby:mesh.test', communityId: COMMUNITY_ID, name: 'lobby', topic: '', channelType: 'text', unreadCount: 0, joined: true },
  { id: '!screenshots:mesh.test', communityId: COMMUNITY_ID, name: 'screenshots', topic: '', channelType: 'text', unreadCount: 0, joined: true },
  { id: '!game-night:mesh.test', communityId: COMMUNITY_ID, name: 'game-night', topic: '', channelType: 'text', unreadCount: 0, joined: true },
  { id: '!dev-log:mesh.test', communityId: COMMUNITY_ID, name: 'dev-log', topic: 'What changed today, in the words of whoever changed it.', channelType: 'text', unreadCount: 0, joined: true },
  { id: '!feedback:mesh.test', communityId: COMMUNITY_ID, name: 'feedback', topic: '', channelType: 'text', unreadCount: 0, joined: true },
  { id: '!project-ember:mesh.test', communityId: COMMUNITY_ID, name: 'project-ember', topic: '', channelType: 'text', unreadCount: 0, joined: true },
  { id: '!project-abyss:mesh.test', communityId: COMMUNITY_ID, name: 'project-abyss', topic: '', channelType: 'text', unreadCount: 0, joined: true },
  { id: '!lounge:mesh.test', communityId: COMMUNITY_ID, name: 'Lounge', topic: 'Open mic, no agenda.', channelType: 'voice', unreadCount: 0, joined: true },
  { id: '!studio:mesh.test', communityId: COMMUNITY_ID, name: 'Studio', topic: '', channelType: 'voice', unreadCount: 0, joined: true },
  { id: '!quiet-cowork:mesh.test', communityId: COMMUNITY_ID, name: 'Quiet Co-work', topic: '', channelType: 'voice', unreadCount: 0, joined: true },
]

const fieldNotesChannels: Channel[] = [
  { id: '!notes:mesh.test', communityId: secondCommunity.id, name: 'notes', topic: '', channelType: 'text', unreadCount: 3, joined: true },
  { id: '!field-guide:mesh.test', communityId: secondCommunity.id, name: 'field-guide', topic: '', channelType: 'text', unreadCount: 0, joined: true },
  { id: '!screenshots-field:mesh.test', communityId: secondCommunity.id, name: 'screenshots', topic: '', channelType: 'text', unreadCount: 0, joined: true },
  { id: '!trail-talk:mesh.test', communityId: secondCommunity.id, name: 'trail-talk', topic: '', channelType: 'text', unreadCount: 0, joined: true },
]
/*
 * A room created in this community after this account arrived. Nothing joins an
 * existing member to a new room, so this is the state a real community reaches
 * the first time anybody adds a room, and the preview carries one permanently so
 * every run exercises a room list that contains one.
 */
const UNJOINED_ROOM_ID = '!raid-planning:mesh.test'
let previewJoinedRoomIds: string[] = []
const unjoinedChannels: Channel[] = [
  { id: UNJOINED_ROOM_ID, communityId: COMMUNITY_ID, name: 'raid-planning', topic: 'Sign-up sheets and route notes for the weekend runs.', channelType: 'text', unreadCount: 0, joined: false },
]
let createdPreviewChannels: Channel[] = []

const people = [
  ['@maya:mesh.test', 'Maya Chen', '#9b7cff', 'owner', true],
  ['@rohan:mesh.test', 'Rohan', '#f1a45b', 'admin', true],
  ['@devon:mesh.test', 'Devon', '#55a8df', 'member', true],
  ['@ari:mesh.test', 'Ari', '#d76aa8', 'member', true],
  ['@kira:mesh.test', 'Kira', '#e85d75', 'member', true],
  ['@pixelpanda:mesh.test', 'PixelPanda', '#6fcf97', 'member', true],
  ['@sam:mesh.test', 'Sam Lee', '#f2c14e', 'member', true],
  ['@zoe:mesh.test', 'Zoe', '#8e7dff', 'member', false],
  ['@taylor:mesh.test', 'Taylor', 'var(--mark-slate)', 'member', true],
].map(([publicKey, displayName, avatarColor, role, online]) => ({
  publicKey,
  displayName,
  avatarColor,
  role,
  joinStatus: 'joined',
  banStatus: 'none',
  lastSeen: '2026-08-01T15:00:00.000Z',
  online,
}))

const timeline: Message[] = [
  {
    id: '$maya-color-pass',
    channelId: ACTIVE_ROOM_ID,
    authorPublicKey: '@maya:mesh.test',
    authorDisplayName: 'Maya Chen',
    authorAvatarColor: '#9b7cff',
    content: 'Color pass: warmer lantern glow, with enough blue distance to keep the scene open.',
    attachments: [{
      fileHash: 'matrix-sha256:lantern-color-pass',
      filename: 'lantern-color-pass.png',
      size: 1_204_992,
      chunks: 1,
      sourcePeerId: 'matrix',
      contentType: 'image/png',
    }],
    reactions: { '🔥': ['@rohan:mesh.test', '@ari:mesh.test'], '👀': ['@devon:mesh.test'] },
    timestamp: '2026-08-01T14:42:00.000Z',
    signature: '',
    replyToId: null,
    deliveryStatus: 'sent',
  },
  {
    id: '$rohan-atmosphere',
    channelId: ACTIVE_ROOM_ID,
    authorPublicKey: '@rohan:mesh.test',
    authorDisplayName: 'Rohan',
    authorAvatarColor: '#f1a45b',
    content: 'Love the atmosphere. The backlight on the ferns sells it.',
    attachments: [{
      fileHash: 'matrix-sha256:fern-backlight',
      filename: 'fern-backlight-detail.png',
      size: 1_204_992,
      chunks: 1,
      sourcePeerId: 'matrix',
      contentType: 'image/png',
    }],
    reactions: { '💯': ['@maya:mesh.test'] },
    timestamp: '2026-08-01T14:45:00.000Z',
    signature: '',
    replyToId: '$maya-color-pass',
    deliveryStatus: 'sent',
  },
  {
    id: '$devon-bounce',
    channelId: ACTIVE_ROOM_ID,
    authorPublicKey: '@devon:mesh.test',
    authorDisplayName: 'Devon',
    authorAvatarColor: '#55a8df',
    content: 'Could we push the warm bounce from the lanterns a little more? It may help lead the eye.',
    attachments: [],
    reactions: { '👍': ['@maya:mesh.test', '@ari:mesh.test'] },
    timestamp: '2026-08-01T14:47:00.000Z',
    signature: '',
    replyToId: null,
    deliveryStatus: 'sent',
  },
  {
    id: '$ari-pass',
    channelId: ACTIVE_ROOM_ID,
    authorPublicKey: '@ari:mesh.test',
    authorDisplayName: 'Ari',
    authorAvatarColor: '#d76aa8',
    content: 'Here is a pass with warmer bounce and a slight fog adjustment. The path reads more clearly now.',
    attachments: [{
      fileHash: 'matrix-sha256:warmer-bounce',
      filename: 'warmer-bounce-pass.png',
      size: 1_204_992,
      chunks: 1,
      sourcePeerId: 'matrix',
      contentType: 'image/png',
    }],
    reactions: { '✨': ['@maya:mesh.test', '@kira:mesh.test'], '👏': ['@rohan:mesh.test'] },
    timestamp: '2026-08-01T14:49:00.000Z',
    signature: '',
    replyToId: '$devon-bounce',
    deliveryStatus: 'sent',
    designPreviewImageUrl: lanternGuildEnvironment,
  },
  {
    id: '$kira-path',
    channelId: ACTIVE_ROOM_ID,
    authorPublicKey: '@kira:mesh.test',
    authorDisplayName: 'Kira',
    authorAvatarColor: '#e85d75',
    content: 'This reads so much better. The path feels like a path now.',
    attachments: [],
    reactions: { '✨': ['@ari:mesh.test'] },
    timestamp: '2026-08-01T14:52:00.000Z',
    signature: '',
    replyToId: null,
    deliveryStatus: 'sent',
  },
]

const directConversations = [
  {
    id: '!dm-maya:mesh.test',
    peers: [{ userId: '@maya:mesh.test', displayName: 'Maya Chen', avatarColor: 'var(--mark-azure-pale)' }],
    lastMessageAt: '2026-08-01T15:06:00.000Z',
    unreadCount: 1,
    createdAt: '2026-07-25T00:00:00.000Z',
  },
  {
    id: '!dm-rohan:mesh.test',
    peers: [{ userId: '@rohan:mesh.test', displayName: 'Rohan', avatarColor: 'var(--mark-amber)' }],
    lastMessageAt: '2026-08-01T14:18:00.000Z',
    unreadCount: 0,
    createdAt: '2026-07-27T00:00:00.000Z',
  },
]

const directMessages = [
  {
    id: '$dm-maya-reference',
    conversationId: '!dm-maya:mesh.test',
    authorPublicKey: '@maya:mesh.test',
    authorDisplayName: 'Maya Chen',
    authorAvatarColor: '#9b7cff',
    content: 'I added the lighting reference to concept-art. The warmer pass is ready for another look.',
    timestamp: '2026-08-01T15:04:00.000Z',
    signature: '',
    attachments: [],
    reactions: {},
    deliveryStatus: 'sent',
  },
  {
    id: '$dm-maya-thread-reply',
    conversationId: '!dm-maya:mesh.test',
    authorPublicKey: '@taylor:mesh.test',
    authorDisplayName: 'Taylor',
    authorAvatarColor: '#f2b84b',
    content: 'Perfect. I will keep the warmer pass in the thread so the main chat stays clean.',
    timestamp: '2026-08-01T15:06:00.000Z',
    signature: '',
    attachments: [],
    reactions: {},
    replyToId: '$dm-maya-reference',
    threadRootId: '$dm-maya-reference',
    deliveryStatus: 'sent',
  },
  {
    id: '$dm-rohan-review',
    conversationId: '!dm-rohan:mesh.test',
    authorPublicKey: '@rohan:mesh.test',
    authorDisplayName: 'Rohan',
    authorAvatarColor: '#f1a45b',
    content: 'The community guide looks good. I left one note on the welcome room.',
    timestamp: '2026-08-01T14:18:00.000Z',
    signature: '',
    attachments: [],
    reactions: {},
    deliveryStatus: 'sent',
  },
]

function largeDirectMessageTimeline(): DirectMessage[] {
  return Array.from({ length: 10_000 }, (_, index) => ({
    id: `$performance-${index}`,
    conversationId: '!dm-maya:mesh.test',
    authorPublicKey: index % 2 === 0 ? '@maya:mesh.test' : '@taylor:mesh.test',
    authorDisplayName: index % 2 === 0 ? 'Maya Chen' : 'Taylor',
    authorAvatarColor: index % 2 === 0 ? '#9b7cff' : '#f2b84b',
    content: `Performance timeline message ${index + 1} of 10000`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    signature: '',
    attachments: [],
    reactions: {},
    replyToId: null,
    deliveryStatus: 'sent',
  }))
}

const queuedPreviewMessages = [{
  id: 'preview-queued-lighting-note',
  channelId: ACTIVE_ROOM_ID,
  authorPublicKey: '@taylor:mesh.test',
  authorDisplayName: 'Taylor',
  authorAvatarColor: '#4ecdc4',
  content: 'Uploading the controller-lighting notes when the connection is ready.',
  attachments: [],
  reactions: {},
  timestamp: '2026-08-01T15:08:00.000Z',
  signature: '',
  transactionId: 'preview-queued-lighting-note',
  clientRequestId: 'preview-queued-lighting-note',
  deliveryStatus: 'pending',
}]

function backendStatus() {
  return {
    kind: 'matrix',
    capabilities: {
      encryptedText: true,
      encryptedAttachments: true,
      directMessages: true,
      voice: simulateVoice,
      durableTimeouts: false,
      deviceManagement: true,
      recovery: true,
      legacyMigration: false,
    },
    voiceService: {
      provider: 'matrix-rtc',
      availability: simulateVoice ? 'ready' : 'not-configured',
      discoveryKey: 'org.matrix.msc4143.rtc_foci',
      livekitServiceUrl: null,
      tokenEndpoint: null,
      livekitSfuUrl: null,
      cspReady: false,
      mediaE2eeReady: simulateVoice,
      reason: simulateVoice ? null : 'Voice is unavailable in this design preview.',
    },
    authenticated: !simulateSignedOut,
    userId: simulateSignedOut ? null : '@taylor:mesh.test',
    deviceId: simulateSignedOut ? null : 'TAYLOR-PREVIEW',
    homeserver: simulateSignedOut ? null : 'https://mesh.test',
    syncRunning: !simulateSignedOut && !simulateOffline,
    durableHistory: true,
    supportsE2ee: true,
    sessionE2eeReady: true,
    warnings: [],
  }
}

function recoveryHealth() {
  return {
    recoveryState: 'enabled',
    backupState: 'enabled',
    backupExistsOnServer: true,
    backupEnabled: true,
    healthy: true,
    checkedAt: '2026-08-01T15:00:00.000Z',
    lastSuccessfulTestAt: '2026-08-01T15:00:00.000Z',
    secureStorageState: 'saved',
    warnings: [],
  }
}

function responseFor(command: string, args: PreviewIpcArgs): unknown | Promise<unknown> {
  switch (command) {
    case 'ensure_backend_started':
      return { phase: 'ready', issue: null }
    case 'get_backend_status':
      return backendStatus()
    case 'matrix_service_capabilities':
      return {
        homeserver: String(args.homeserver ?? 'https://matrix.org'),
        serverVersions: ['v1.13'],
        passwordLogin: true,
        browserLogin: true,
        registration: 'open',
        maxUploadBytes: 10 * 1024 * 1024,
      }
    case 'matrix_reserve_login_attempt': {
      previewLoginAttemptCounter += 1
      const attemptId = `preview-login-attempt-${previewLoginAttemptCounter}`
      activePreviewLoginAttemptIds.add(attemptId)
      return attemptId
    }
    case 'matrix_login':
      if (typeof args.attemptId !== 'string' || !activePreviewLoginAttemptIds.delete(args.attemptId)) {
        throw new Error('The preview sign-in attempt is no longer active. Try again.')
      }
      simulateSignedOut = false
      return backendStatus()
    case 'peek_pending_invitation':
      return simulateInvitation ? {
        handle: 'preview-invitation-handle',
        roomOrAlias: '#canyon-crew:canyon.example',
        via: ['canyon.example'],
        service: 'https://matrix.canyon.example',
        admissionService: null,
        communityName: 'Canyon Collective',
        inviterDisplayName: 'Mothbyte',
        inviterUserId: null,
        joinRule: 'invite',
        communityServiceDisplayName: 'Canyon Accounts',
        storedAt: Date.now() - 800,
        expiresAt: Date.now() + 86_400_000,
      } : null
    case 'join_pending_invitation':
      if (!simulateInvitation || args.handle !== 'preview-invitation-handle') {
        throw new Error('The preview invitation is no longer available.')
      }
      simulateInvitation = false
      return {
        id: INVITED_COMMUNITY_ID,
        name: 'Canyon Collective',
        description: 'Controller runs, boss clips, and playtest notes.',
        memberCount: 24,
        role: 'member',
        joinedAt: new Date().toISOString(),
      }
    case 'clear_pending_invitation':
      if (args.handle === 'preview-invitation-handle') simulateInvitation = false
      return null
    case 'matrix_user_preferences':
    case 'matrix_room_upgrade':
      return null
    /*
      The preview throws on any command it does not handle, which is the right
      default: a surface that silently succeeds against a fixture teaches the
      wrong thing. Reactions are handled because two room shapes are built on
      them, and an RSVP that always reverted was previewing the failure path
      rather than the feature.
    */
    case 'matrix_toggle_reaction':
      return true
    case 'matrix_get_profile':
      return { userId: '@taylor:mesh.test', displayName: 'Taylor', avatarUrl: null }
    case 'matrix_list_communities':
      return { entities: [community, secondCommunity], blockedEntities: [] }
    case 'matrix_list_channels':
      return {
        entities: args.communityId === COMMUNITY_ID
          ? [
              ...channels,
              ...unjoinedChannels.map((channel) => (
                previewJoinedRoomIds.includes(channel.id)
                  ? { ...channel, joined: true }
                  : channel
              )),
              ...createdPreviewChannels,
            ]
          : args.communityId === INVITED_COMMUNITY_ID
            ? [{
                id: INVITED_ROOM_ID,
                communityId: INVITED_COMMUNITY_ID,
                name: 'controller lab',
                topic: '',
                channelType: 'text',
                unreadCount: 0,
                joined: true,
              }]
            : fieldNotesChannels,
        blockedEntities: [],
      }
    case 'matrix_list_members':
      return { members: people, nextCursor: null, stateComplete: true }
    case 'matrix_get_messages':
      if (simulateRoomState === 'loading') return new Promise<never>(() => {})
      if (simulateRoomState === 'error') throw new Error('Preview room history failed')
      if (simulateRoomState === 'empty') return []
      return timeline.filter((message) => message.channelId === args.roomId)
    case 'matrix_dm_conversations':
      if (simulateDmListState === 'loading') return new Promise<never>(() => {})
      if (simulateDmListState === 'error') throw new Error('Preview conversation list failed')
      if (simulateDmListState === 'empty') return { entities: [], blockedEntities: [] }
      return { entities: directConversations, blockedEntities: [] }
    case 'matrix_dm_requests':
      return []
    case 'matrix_blocked_accounts':
      return { accounts: [], nextCursor: null }
    case 'matrix_dm_messages':
      if (simulateDmMessageState === 'loading') return new Promise<never>(() => {})
      if (simulateDmMessageState === 'error') throw new Error('Preview conversation history failed')
      if (simulateDmMessageState === 'empty') return []
      if (simulateLargeTimeline && args.conversationId === '!dm-maya:mesh.test') {
        const limit = Math.max(1, Number(args.limit ?? 50))
        const beforeId = typeof args.beforeId === 'string' ? args.beforeId : null
        if (beforeId) {
          const beforeIndex = performanceDirectMessages.findIndex(
            (message) => message.id === beforeId,
          )
          if (beforeIndex <= 0) return []
          return performanceDirectMessages.slice(
            Math.max(0, beforeIndex - limit),
            beforeIndex,
          )
        }
        return performanceDirectMessages.slice(-limit)
      }
      return directMessages.filter((message) => message.conversationId === args.conversationId)
    case 'matrix_queued_messages':
      if (previewQueueRestoreFailuresRemaining > 0) {
        previewQueueRestoreFailuresRemaining -= 1
        throw new Error('Preview saved-message restore failed')
      }
      return simulateQueue ? queuedPreviewMessages : []
    case 'matrix_typing_users':
    case 'matrix_list_moderation_audit':
      return []
    case 'matrix_list_community_applications':
      return previewApplications.map((application) => ({ ...application }))
    case 'matrix_room_is_encrypted':
      return true
    case 'matrix_dm_blocked':
      return false
    case 'matrix_get_room_notification_mode':
      return 'all'
    case 'matrix_download_attachment':
      return 'C:\\Mesh Preview\\Downloads\\lighting-notes.pdf'
    case 'open_downloaded_file':
      return null
    case 'matrix_room_pins':
      return {
        roomId: String(args.roomId),
        eventIds: ['$maya-color-pass'],
        messages: timeline.slice(0, 1),
        unavailableEventIds: [],
        canManage: true,
      }
    case 'matrix_rtc_members':
      return simulateVoice && args.roomId === '!studio:mesh.test'
        ? [
            { roomId: '!studio:mesh.test', userId: '@maya:mesh.test', deviceId: 'MAYA', sessionId: 'maya-studio', displayName: 'Maya Chen', avatarUrl: null },
            { roomId: '!studio:mesh.test', userId: '@rohan:mesh.test', deviceId: 'ROHAN', sessionId: 'rohan-studio', displayName: 'Rohan', avatarUrl: null },
            { roomId: '!studio:mesh.test', userId: '@ari:mesh.test', deviceId: 'ARI', sessionId: 'ari-studio', displayName: 'Ari', avatarUrl: null },
          ]
        : []
    case 'matrix_recovery_health':
    case 'matrix_test_recovery':
    case 'matrix_test_stored_recovery':
      return recoveryHealth()
    case 'matrix_enable_recovery':
      return {
        recoveryKey: 'MESH-PREVIEW-ONLY-BACKUP-CODE',
        secureStorageState: 'saved',
        verificationState: 'verified',
      }
    case 'matrix_recover':
      return null
    case 'matrix_devices':
      return [{
        deviceId: 'TAYLOR-PREVIEW',
        displayName: 'Mesh Desktop',
        lastSeenIp: null,
        lastSeenAt: '2026-08-01T15:00:00.000Z',
        firstSeenAt: '2026-07-24T00:00:00.000Z',
        current: true,
        verified: true,
        crossSigned: true,
        newDevice: false,
        identityChanged: false,
      }]
    case 'matrix_community_access_settings':
      return { ...previewCommunityAccess }
    case 'matrix_update_community_access': {
      const alias = typeof args.alias === 'string' && args.alias.trim()
        ? args.alias.trim()
        : null
      const discoverable = args.discoverable === true
      // Mirror the native contract: the join rule is chosen, not derived from
      // whether the community is listed in the directory.
      const joinRule = args.joinRule === 'knock' ? 'knock' : 'invite'
      previewCommunityAccess = {
        alias: alias ?? '',
        discoverable,
        joinRule,
      }
      return { ...previewCommunityAccess, alias }
    }
    case 'matrix_respond_community_application':
      previewApplications = previewApplications.filter(
        (application) => application.userId !== args.userId,
      )
      return null
    case 'matrix_create_community_invite':
      return 'https://mesh.test/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
    case 'matrix_invite_to_community':
      return null
    case 'matrix_update_community':
      return null
    case 'matrix_update_channel': {
      const channelId = String(args.channelId ?? '')
      const existing = createdPreviewChannels.find((entry) => entry.id === channelId)
      const name = typeof args.name === 'string' && args.name.trim()
        ? args.name.trim()
        : existing?.name ?? 'unnamed'
      const updated: Channel = {
        id: channelId,
        communityId: String(args.communityId ?? COMMUNITY_ID),
        name,
        topic: typeof args.topic === 'string' ? args.topic.trim() : existing?.topic ?? '',
        channelType: existing?.channelType ?? 'text',
        unreadCount: existing?.unreadCount ?? 0,
        joined: true,
      }
      createdPreviewChannels = [
        ...createdPreviewChannels.filter((entry) => entry.id !== channelId),
        updated,
      ]
      return updated
    }

    case 'matrix_join_community_channel': {
      const channelId = String(args.channelId ?? '')
      const target = unjoinedChannels.find((entry) => entry.id === channelId)
      if (!target) throw new Error('Preview room join failed')
      previewJoinedRoomIds = [...previewJoinedRoomIds, channelId]
      return { ...target, joined: true }
    }

    case 'matrix_remove_channel': {
      const channelId = String(args.channelId ?? '')
      createdPreviewChannels = createdPreviewChannels.filter((entry) => entry.id !== channelId)
      return undefined
    }

    case 'matrix_create_channel': {
      const name = String(args.name ?? '').trim()
      const communityId = String(args.communityId ?? COMMUNITY_ID)
      const channelType: Channel['channelType'] = args.channelType === 'voice' ? 'voice' : 'text'
      const channel: Channel = {
        id: `!preview-${createdPreviewChannels.length + 1}:mesh.test`,
        communityId,
        name,
        topic: '',
        channelType,
        unreadCount: 0,
        joined: true,
      }
      createdPreviewChannels = [
        ...createdPreviewChannels.filter((entry) => entry.id !== channel.id),
        channel,
      ]
      return channel
    }
    case 'matrix_update_user_preferences':
      return { ...(args.preferences as PreviewIpcArgs), updatedAt: '2026-08-01T15:00:00.000Z' }
    case 'matrix_send_message': {
      const transactionId = String(
        args.transactionId ?? `preview-request-${timeline.length + 1}`,
      )
      const message: Message = {
        id: `$preview-${timeline.length + 1}`,
        channelId: String(args.roomId),
        authorPublicKey: '@taylor:mesh.test',
        authorDisplayName: 'Taylor',
        authorAvatarColor: '#4ecdc4',
        content: String(args.body),
        attachments: [],
        reactions: {},
        timestamp: new Date().toISOString(),
        signature: '',
        replyToId: typeof args.replyToId === 'string' ? args.replyToId : null,
        threadRootId: typeof args.threadRootId === 'string' ? args.threadRootId : null,
        transactionId,
        clientRequestId: transactionId,
        deliveryStatus: 'sent',
      }
      timeline.push(message)
      return message
    }
    case 'matrix_mark_read':
    case 'matrix_mark_thread_read':
    case 'matrix_mark_dm_read':
    case 'matrix_set_typing':
    case 'matrix_load_composer_draft':
    case 'matrix_save_composer_draft':
    case 'matrix_clear_composer_draft':
    case 'matrix_sync_once':
    case 'discard_attachment_grant': {
      return null
    }
    case 'get_notification_account_scope':
      return {
        accountGeneration: 0,
        userId: args.expectedUserId,
      }
    case 'set_notification_context':
    case 'send_test_notification':
    case 'plugin:event|unlisten':
      return null
    case 'plugin:deep-link|get_current':
      return null
    case 'matrix_wait_for_room_update': {
      const requestedTimeout = Number(args.timeoutMs)
      const waitMs = Number.isFinite(requestedTimeout)
        ? Math.min(Math.max(requestedTimeout, 1), 30_000)
        : 25_000
      return new Promise((resolve) => {
        window.setTimeout(() => resolve(false), waitMs)
      })
    }
    case 'plugin:event|listen':
      if (
        args.event === 'matrix:queued-message'
        && previewQueueListenerFailuresRemaining > 0
      ) {
        previewQueueListenerFailuresRemaining -= 1
        throw new Error('Preview saved-message listener failed')
      }
      return 1
    default:
      throw new Error(`Unhandled Mesh design preview IPC command: ${command}`)
  }
}

export function installWorkspacePreview(
  options: {
    simulateVoice?: boolean
    simulateInvitation?: boolean
    simulateSignedOut?: boolean
    simulateQueue?: boolean
    simulateOffline?: boolean
    simulateRoomState?: PreviewLoadState
    simulateDmListState?: PreviewLoadState
    simulateDmMessageState?: PreviewLoadState
    simulateQueueRestoreFailure?: boolean
    simulateQueueListenerFailure?: boolean
    simulateLargeTimeline?: boolean
  } = {},
): void {
  const previewWindow = window as typeof window & {
    __TAURI_INTERNALS__?: unknown
  }
  if (typeof window === 'undefined' || previewWindow.__TAURI_INTERNALS__) return

  simulateVoice = options.simulateVoice === true
  simulateInvitation = options.simulateInvitation === true
  simulateSignedOut = options.simulateSignedOut === true
  simulateQueue = options.simulateQueue === true
  simulateOffline = options.simulateOffline === true
  simulateRoomState = options.simulateRoomState ?? 'ready'
  simulateDmListState = options.simulateDmListState ?? 'ready'
  simulateDmMessageState = options.simulateDmMessageState ?? 'ready'
  simulateLargeTimeline = options.simulateLargeTimeline === true
  performanceDirectMessages = simulateLargeTimeline ? largeDirectMessageTimeline() : []
  previewJoinedRoomIds = []
  previewQueueRestoreFailuresRemaining = options.simulateQueueRestoreFailure === true ? 1 : 0
  // React StrictMode mounts preview effects twice. Reject both development
  // registrations so the user-visible second mount still exercises recovery;
  // the next explicit retry succeeds.
  previewQueueListenerFailuresRemaining = options.simulateQueueListenerFailure === true ? 2 : 0
  createdPreviewChannels = []
  previewApplications = initialPreviewApplications.map((application) => ({ ...application }))
  previewCommunityAccess = {
    alias: 'lantern-guild',
    discoverable: false,
    joinRule: 'invite',
  }
  previewLoginAttemptCounter = 0
  activePreviewLoginAttemptIds = new Set<string>()
  document.documentElement.dataset.meshSimulateVoice = simulateVoice ? 'true' : 'false'

  if (safeLocalStorageGet(ROOM_CONTEXT_OPEN_KEY) === null) {
    safeLocalStorageSet(ROOM_CONTEXT_OPEN_KEY, 'true')
  }

  const callbacks = new Map<number, PreviewCallback>()
  let nextCallbackId = 1

  Object.assign(window, {
    isTauri: true,
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: PreviewIpcArgs = {}) => {
        try {
          return Promise.resolve(responseFor(command, args))
        } catch (error) {
          return Promise.reject(error)
        }
      },
      transformCallback: (callback: PreviewCallback) => {
        const id = nextCallbackId
        nextCallbackId += 1
        callbacks.set(id, callback)
        return id
      },
      unregisterCallback: (id: number) => {
        callbacks.delete(id)
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener: () => {},
    },
  })
}
