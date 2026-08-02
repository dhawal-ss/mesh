import lanternGuildEnvironment from '../assets/lantern-guild-environment.png'
import { safeLocalStorageSet } from '../lib/safe-storage'

type PreviewIpcArgs = Record<string, unknown>

type PreviewCallback = (...args: unknown[]) => void

const COMMUNITY_ID = '!lantern-guild:mesh.test'
const ACTIVE_ROOM_ID = '!concept-art:mesh.test'
let simulateVoice = false

const community = {
  id: COMMUNITY_ID,
  name: 'Lantern Guild',
  description: 'A private creative studio for games, art, and shared work.',
  memberCount: 15,
  role: 'owner',
  joinedAt: '2026-07-24T00:00:00.000Z',
  bannerUrl: lanternGuildEnvironment,
}

const secondCommunity = {
  id: '!field-notes:mesh.test',
  name: 'Field Notes',
  description: 'A small research and writing circle.',
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
    attachments: [],
    reactions: { '🔥': ['@rohan:mesh.test', '@ari:mesh.test'], '👀': ['@devon:mesh.test'] },
    timestamp: '2026-08-01T14:42:00.000Z',
    signature: '',
    replyToId: null,
    deliveryStatus: 'sent',
    designPreviewImageUrl: lanternGuildEnvironment,
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

function backendStatus() {
  return {
    kind: 'matrix',
    capabilities: {
      encryptedText: true,
      encryptedAttachments: true,
      directMessages: true,
      voice: false,
      durableTimeouts: false,
      deviceManagement: true,
      recovery: true,
      legacyMigration: false,
    },
    voiceService: {
      provider: 'matrix-rtc',
      availability: 'not-configured',
      discoveryKey: 'org.matrix.msc4143.rtc_foci',
      livekitServiceUrl: null,
      tokenEndpoint: null,
      livekitSfuUrl: null,
      cspReady: false,
      mediaE2eeVerified: false,
      reason: 'Voice is unavailable in this design preview.',
    },
    authenticated: true,
    userId: '@taylor:mesh.test',
    deviceId: 'TAYLOR-PREVIEW',
    homeserver: 'https://mesh.test',
    syncRunning: true,
    durableHistory: true,
    endToEndEncryption: true,
    warnings: [],
  }
}

function responseFor(command: string, args: PreviewIpcArgs): unknown | Promise<unknown> {
  switch (command) {
    case 'get_backend_status':
      return backendStatus()
    case 'peek_pending_invitation':
    case 'matrix_user_preferences':
    case 'matrix_room_upgrade':
      return null
    case 'matrix_get_profile':
      return { userId: '@taylor:mesh.test', displayName: 'Taylor', avatarUrl: null }
    case 'matrix_list_communities':
      return [community, secondCommunity]
    case 'matrix_list_channels':
      return args.communityId === COMMUNITY_ID
        ? channels
        : [{ id: '!notes:mesh.test', communityId: secondCommunity.id, name: 'notes', channelType: 'text', unreadCount: 3 }]
    case 'matrix_list_members':
      return people
    case 'matrix_get_messages':
      return timeline.filter((message) => message.channelId === args.roomId)
    case 'matrix_queued_messages':
    case 'matrix_typing_users':
    case 'matrix_list_custom_emoji':
    case 'matrix_list_community_applications':
    case 'matrix_list_moderation_audit':
      return []
    case 'matrix_room_is_encrypted':
      return true
    case 'matrix_get_room_notification_mode':
      return 'all'
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

export function installWorkspacePreview(options: { simulateVoice?: boolean } = {}): void {
  const previewWindow = window as typeof window & {
    __TAURI_INTERNALS__?: unknown
  }
  if (typeof window === 'undefined' || previewWindow.__TAURI_INTERNALS__) return

  simulateVoice = options.simulateVoice === true

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
