import lanternGuildEnvironment from '../assets/lantern-guild-environment.png'
import communityLattice from '../assets/pixel/community-lattice.png'
import meshHeart from '../assets/pixel/mesh-heart.png'
import profileSignal from '../assets/pixel/profile-signal.png'
import { safeLocalStorageSet } from '../lib/safe-storage'
import type { Channel, CommunityApplication, CustomEmoji, Message } from '../types/ipc'

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
let previewQueueRestoreFailuresRemaining = 0
let previewQueueListenerFailuresRemaining = 0
let simulateEmojiPickerCancel = false
let simulateEmojiUploadFailure = false

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

const initialPreviewEmoji: CustomEmoji[] = [
  {
    shortcode: 'mesh_heart',
    body: 'Mesh heart',
    mxcUri: 'mxc://mesh.test/mesh-heart',
    contentType: 'image/png',
    width: 96,
    height: 96,
    sizeBytes: 6291,
  },
  {
    shortcode: 'signal',
    body: 'Signal',
    mxcUri: 'mxc://mesh.test/profile-signal',
    contentType: 'image/png',
    width: 96,
    height: 96,
    sizeBytes: 3963,
  },
  {
    shortcode: 'community',
    body: 'Community',
    mxcUri: 'mxc://mesh.test/community-lattice',
    contentType: 'image/png',
    width: 96,
    height: 96,
    sizeBytes: 2329,
  },
]

const initialPreviewEmojiAssets: Record<string, string> = {
  mesh_heart: meshHeart,
  signal: profileSignal,
  community: communityLattice,
}

let previewEmoji: CustomEmoji[] = []
let previewEmojiBytes: Record<string, number[]> = {}
let previewEmojiGrantCounter = 0
let previewEmojiGrants: Record<string, {
  communityId: string
  name: string
  size: number
  contentType: string
  bytes: number[]
}> = {}

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

const channels: Channel[] = [
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

const timeline: Message[] = [
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
      mediaE2eeReady: simulateVoice,
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
          ? [...channels, ...createdPreviewChannels]
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
      return { members: people, nextCursor: null, stateComplete: true }
    case 'matrix_get_messages':
      return timeline.filter((message) => message.channelId === args.roomId)
    case 'matrix_dm_conversations':
      return { entities: directConversations, blockedEntities: [] }
    case 'matrix_dm_requests':
      return []
    case 'matrix_blocked_accounts':
      return { accounts: [], nextCursor: null }
    case 'matrix_dm_messages':
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
    case 'matrix_list_custom_emoji':
      return previewEmoji.map((emoji) => ({ ...emoji }))
    case 'pick_custom_emoji_grant': {
      if (simulateEmojiPickerCancel) return null
      const grant = `preview-custom-emoji-${++previewEmojiGrantCounter}`
      const selected = {
        communityId: String(args.communityId ?? ''),
        name: 'playtest-ready.png',
        size: 8,
        contentType: 'image/png',
        bytes: [137, 80, 78, 71, 13, 10, 26, 10],
      }
      previewEmojiGrants[grant] = selected
      return { grant, name: selected.name, size: selected.size, contentType: selected.contentType }
    }
    case 'matrix_load_custom_emoji_image': {
      const shortcode = String(args.shortcode ?? '')
      const stored = previewEmojiBytes[shortcode]
      if (stored) return new Uint8Array(stored)
      const asset = initialPreviewEmojiAssets[shortcode]
      if (!asset) throw new Error('Preview emoji image not found')
      return fetch(asset)
        .then((response) => response.arrayBuffer())
        .then((bytes) => new Uint8Array(bytes))
    }
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
      previewCommunityAccess = {
        alias: alias ?? '',
        discoverable,
        joinRule: discoverable ? 'knock' : 'invite',
      }
      return { ...previewCommunityAccess, alias }
    }
    case 'matrix_respond_community_application':
      previewApplications = previewApplications.filter(
        (application) => application.userId !== args.userId,
      )
      return null
    case 'matrix_upload_custom_emoji': {
      const shortcode = String(args.shortcode ?? '').trim().toLowerCase()
      const grant = String(args.grant ?? '')
      const selected = previewEmojiGrants[grant]
      if (!selected) throw new Error('Preview image selection expired; choose it again')
      if (selected.communityId !== String(args.communityId ?? '')) {
        throw new Error('Preview image selection belongs to a different community')
      }
      const nextGrants = { ...previewEmojiGrants }
      delete nextGrants[grant]
      previewEmojiGrants = nextGrants
      if (simulateEmojiUploadFailure) {
        throw new Error('Preview custom emoji upload failed')
      }
      const emoji: CustomEmoji = {
        shortcode,
        body: shortcode.replace(/_/g, ' '),
        mxcUri: `mxc://mesh.test/preview-${shortcode}`,
        contentType: selected.contentType,
        width: 96,
        height: 96,
        sizeBytes: selected.size,
      }
      previewEmoji = [
        ...previewEmoji.filter((entry) => entry.shortcode !== shortcode),
        emoji,
      ]
      previewEmojiBytes = { ...previewEmojiBytes, [shortcode]: selected.bytes }
      return emoji
    }
    case 'matrix_remove_custom_emoji': {
      const shortcode = String(args.shortcode ?? '')
      previewEmoji = previewEmoji.filter((emoji) => emoji.shortcode !== shortcode)
      const nextBytes = { ...previewEmojiBytes }
      delete nextBytes[shortcode]
      previewEmojiBytes = nextBytes
      return null
    }
    case 'matrix_create_community_invite':
      return 'https://mesh.test/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
    case 'matrix_invite_to_community':
      return null
    case 'matrix_update_community':
      return null
    case 'matrix_create_channel': {
      const name = String(args.name ?? '').trim()
      const communityId = String(args.communityId ?? COMMUNITY_ID)
      const channelType: Channel['channelType'] = args.channelType === 'voice' ? 'voice' : 'text'
      const channel: Channel = {
        id: `!preview-${createdPreviewChannels.length + 1}:mesh.test`,
        communityId,
        name,
        channelType,
        unreadCount: 0,
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
        transactionId,
        clientRequestId: transactionId,
        deliveryStatus: 'sent',
      }
      timeline.push(message)
      return message
    }
    case 'matrix_mark_read':
    case 'matrix_mark_dm_read':
    case 'matrix_set_typing':
    case 'matrix_load_composer_draft':
    case 'matrix_save_composer_draft':
    case 'matrix_clear_composer_draft':
    case 'matrix_sync_once':
    case 'discard_attachment_grant': {
      if (typeof args.grant === 'string') {
        const nextGrants = { ...previewEmojiGrants }
        delete nextGrants[args.grant]
        previewEmojiGrants = nextGrants
      }
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
    simulateQueueRestoreFailure?: boolean
    simulateQueueListenerFailure?: boolean
    simulateEmojiPickerCancel?: boolean
    simulateEmojiUploadFailure?: boolean
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
  previewQueueRestoreFailuresRemaining = options.simulateQueueRestoreFailure === true ? 1 : 0
  // React StrictMode mounts preview effects twice. Reject both development
  // registrations so the user-visible second mount still exercises recovery;
  // the next explicit retry succeeds.
  previewQueueListenerFailuresRemaining = options.simulateQueueListenerFailure === true ? 2 : 0
  simulateEmojiPickerCancel = options.simulateEmojiPickerCancel === true
  simulateEmojiUploadFailure = options.simulateEmojiUploadFailure === true
  createdPreviewChannels = []
  previewApplications = initialPreviewApplications.map((application) => ({ ...application }))
  previewCommunityAccess = {
    alias: 'lantern-guild',
    discoverable: false,
    joinRule: 'invite',
  }
  previewEmoji = initialPreviewEmoji.map((emoji) => ({ ...emoji }))
  previewEmojiBytes = {}
  previewEmojiGrantCounter = 0
  previewEmojiGrants = {}
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
