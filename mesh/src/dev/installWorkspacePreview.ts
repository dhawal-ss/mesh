import lanternGuildEnvironment from '../assets/lantern-guild-environment.png'
import { safeLocalStorageSet } from '../lib/safe-storage'

type PreviewIpcArgs = Record<string, unknown>

type PreviewCallback = (...args: unknown[]) => void

const COMMUNITY_ID = '!lantern-guild:mesh.test'
const ACTIVE_ROOM_ID = '!concept-art:mesh.test'
const INVITED_COMMUNITY_ID = '!canyon-crew:canyon.example'
const INVITED_ROOM_ID = '!controller-lab:canyon.example'
let simulateVoice = false
let simulateInvitation = false
let simulateSignedOut = false
let simulateQueue = false

const community = {
  id: COMMUNITY_ID,
  name: 'Lantern Guild',
  description: 'A late-night crew for playtests, clips, art, and co-op runs.',
  memberCount: 15,
  role: 'owner',
  joinedAt: '2026-07-24T00:00:00.000Z',
  iconUrl: lanternGuildEnvironment,
  bannerUrl: lanternGuildEnvironment,
}

const secondCommunity = {
  id: '!field-notes:mesh.test',
  name: 'Field Notes',
  description: 'A small crew for exploration games, screenshots, and field notes.',
  memberCount: 8,
  role: 'member',
  joinedAt: '2026-07-26T00:00:00.000Z',
}

const channels = [
  { id: ACTIVE_ROOM_ID, communityId: COMMUNITY_ID, name: 'concept-art', channelType: 'text', unreadCount: 0 },
  { id: '!welcome:mesh.test', communityId: COMMUNITY_ID, name: 'welcome', channelType: 'text', unreadCount: 2 },
  { id: '!announcements:mesh.test', communityId: COMMUNITY_ID, name: 'announcements', channelType: 'text', unreadCount: 1 },
  { id: '!lobby:mesh.test', communityId: COMMUNITY_ID, name: 'lobby', channelType: 'text', unreadCount: 0 },
  { id: '!screenshots:mesh.test', communityId: COMMUNITY_ID, name: 'screenshots', channelType: 'text', unreadCount: 0 },
  { id: '!game-night:mesh.test', communityId: COMMUNITY_ID, name: 'game-night', channelType: 'text', unreadCount: 0 },
  { id: '!dev-log:mesh.test', communityId: COMMUNITY_ID, name: 'dev-log', channelType: 'text', unreadCount: 0 },
  { id: '!feedback:mesh.test', communityId: COMMUNITY_ID, name: 'feedback', channelType: 'text', unreadCount: 0 },
  { id: '!project-ember:mesh.test', communityId: COMMUNITY_ID, name: 'project-ember', channelType: 'text', unreadCount: 0 },
  { id: '!project-abyss:mesh.test', communityId: COMMUNITY_ID, name: 'project-abyss', channelType: 'text', unreadCount: 0 },
  { id: '!lounge:mesh.test', communityId: COMMUNITY_ID, name: 'Lounge', channelType: 'voice', unreadCount: 0 },
  { id: '!studio:mesh.test', communityId: COMMUNITY_ID, name: 'Studio', channelType: 'voice', unreadCount: 0 },
  { id: '!quiet-cowork:mesh.test', communityId: COMMUNITY_ID, name: 'Quiet Co-work', channelType: 'voice', unreadCount: 0 },
]

const people = [
  ['@maya:mesh.test', 'Maya Chen', '#9b7cff', 'owner', true],
  ['@rohan:mesh.test', 'Rohan', '#f1a45b', 'admin', true],
  ['@devon:mesh.test', 'Devon', '#55a8df', 'member', true],
  ['@ari:mesh.test', 'Ari', '#d76aa8', 'member', true],
  ['@kira:mesh.test', 'Kira', '#e85d75', 'member', true],
  ['@pixelpanda:mesh.test', 'PixelPanda', '#6fcf97', 'member', true],
  ['@sam:mesh.test', 'Sam Lee', '#f2c14e', 'member', true],
  ['@zoe:mesh.test', 'Zoe', '#8e7dff', 'member', false],
  ['@taylor:mesh.test', 'Taylor', '#4ecdc4', 'member', true],
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

const timeline = [
  {
    id: '$maya-color-pass',
    channelId: ACTIVE_ROOM_ID,
    authorPublicKey: '@maya:mesh.test',
    authorDisplayName: 'Maya Chen',
    authorAvatarColor: '#9b7cff',
    content: 'Color pass: warmer lantern glow, with enough blue distance to keep the scene open.',
    attachments: [{
      fileHash: 'matrix-sha256:lighting-notes',
      filename: 'lighting-notes.pdf',
      size: 428_032,
      chunks: 1,
      sourcePeerId: 'matrix',
      contentType: 'application/pdf',
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
    attachments: [],
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
    attachments: [],
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
    peerPublicKey: '@maya:mesh.test',
    peerDisplayName: 'Maya Chen',
    peerAvatarColor: '#9b7cff',
    lastMessageAt: '2026-08-01T15:06:00.000Z',
    unreadCount: 1,
    createdAt: '2026-07-25T00:00:00.000Z',
  },
  {
    id: '!dm-rohan:mesh.test',
    peerPublicKey: '@rohan:mesh.test',
    peerDisplayName: 'Rohan',
    peerAvatarColor: '#f1a45b',
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
      mediaE2eeVerified: simulateVoice,
      reason: simulateVoice ? null : 'Voice is unavailable in this design preview.',
    },
    authenticated: !simulateSignedOut,
    userId: simulateSignedOut ? null : '@taylor:mesh.test',
    deviceId: simulateSignedOut ? null : 'TAYLOR-PREVIEW',
    homeserver: simulateSignedOut ? null : 'https://mesh.test',
    syncRunning: !simulateSignedOut,
    durableHistory: true,
    supportsE2ee: true,
    sessionE2eeReady: true,
    warnings: [],
  }
}

function responseFor(command: string, args: PreviewIpcArgs): unknown | Promise<unknown> {
  switch (command) {
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
    case 'matrix_login':
      simulateSignedOut = false
      return backendStatus()
    case 'peek_pending_invitation':
      return simulateInvitation ? {
        handle: 'preview-invitation-handle',
        roomOrAlias: '#canyon-crew:canyon.example',
        via: ['canyon.example'],
        service: 'https://matrix.canyon.example',
        admissionService: null,
        communityName: 'Canyon Crew',
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
        name: 'Canyon Crew',
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
    case 'matrix_get_profile':
      return { userId: '@taylor:mesh.test', displayName: 'Taylor', avatarUrl: null }
    case 'matrix_list_communities':
      return { entities: [community, secondCommunity], blockedEntities: [] }
    case 'matrix_list_channels':
      return {
        entities: args.communityId === COMMUNITY_ID
          ? channels
          : args.communityId === INVITED_COMMUNITY_ID
            ? [{
                id: INVITED_ROOM_ID,
                communityId: INVITED_COMMUNITY_ID,
                name: 'controller lab',
                channelType: 'text',
                unreadCount: 0,
              }]
            : [{ id: '!notes:mesh.test', communityId: secondCommunity.id, name: 'notes', channelType: 'text', unreadCount: 3 }],
        blockedEntities: [],
      }
    case 'matrix_list_members':
      return people
    case 'matrix_get_messages':
      return timeline.filter((message) => message.channelId === args.roomId)
    case 'matrix_dm_conversations':
      return { entities: directConversations, blockedEntities: [] }
    case 'matrix_dm_messages':
      return directMessages.filter((message) => message.conversationId === args.conversationId)
    case 'matrix_queued_messages':
      return simulateQueue ? queuedPreviewMessages : []
    case 'matrix_typing_users':
    case 'matrix_list_custom_emoji':
    case 'matrix_list_community_applications':
    case 'matrix_list_moderation_audit':
      return []
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
      return {
        recoveryState: 'enabled',
        backupState: 'enabled',
        backupExistsOnServer: true,
        backupEnabled: true,
        healthy: true,
        checkedAt: '2026-08-01T15:00:00.000Z',
        lastSuccessfulTestAt: '2026-08-01T15:00:00.000Z',
        warnings: [],
      }
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
      return { alias: 'lantern-guild', discoverable: false, joinRule: 'invite' }
    case 'matrix_update_user_preferences':
      return { ...(args.preferences as PreviewIpcArgs), updatedAt: '2026-08-01T15:00:00.000Z' }
    case 'matrix_send_message':
      return {
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
        replyToId: args.replyToId ?? null,
        deliveryStatus: 'sent',
      }
    case 'matrix_mark_read':
    case 'matrix_mark_dm_read':
    case 'matrix_set_typing':
    case 'matrix_load_composer_draft':
    case 'matrix_save_composer_draft':
    case 'matrix_clear_composer_draft':
    case 'set_notification_context':
    case 'send_test_notification':
    case 'plugin:event|unlisten':
      return null
    case 'plugin:deep-link|get_current':
      return null
    case 'matrix_wait_for_room_update':
      return new Promise(() => {})
    case 'plugin:event|listen':
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
  document.documentElement.dataset.meshSimulateVoice = simulateVoice ? 'true' : 'false'

  safeLocalStorageSet('mesh-layout-room-context-open', 'true')

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
