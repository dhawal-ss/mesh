// ─── Core Type Shapes ───────────────────────────────
// These mirror the Rust DTOs exactly. This is the single source of truth
// for the IPC contract between frontend and backend.

import type {
  AttachmentDto,
  AttachmentThumbnailDto,
  ChannelDto,
  CommunityDto,
  CustomEmoji,
  DirectMessageDto,
  DmConversationDto,
  IdentityDto,
  MessageDto,
  NetworkStatusDto,
  PeerDto,
  UserPreferences,
} from './ipc.generated'

export type {
  AttachmentDto,
  AttachmentThumbnailDto,
  BackendCapabilities,
  BackendKind,
  BackendStatus,
  ChannelDto,
  CommunityDto,
  CommunityPermissionAggregate,
  CommunityPermissionAggregateStatus,
  CommunityPermissionId,
  CommunityPermissionProjection,
  CommunityModerationResult,
  CustomEmoji,
  DirectMessageDto,
  DmConversationDto,
  IdentityDto,
  MessageDto,
  ModerationAuditEntry,
  ModerationRoomOutcome,
  MatrixNotification,
  MatrixPermissionRoomStatus,
  MatrixPermissionStateChanged,
  MatrixCommunityAdmission,
  MatrixPersonalDataExport,
  PendingInvitationMetadata,
  MatrixQueuedMessageState,
  MatrixQueuedMessageUpdate,
  MatrixRoomNotificationMode,
  MatrixRoomUpgrade,
  MatrixRoomPins,
  MatrixRoomPinsUpdate,
  MatrixRecoveryHealth,
  MatrixRecoverySecureStorageState,
  MatrixRecoverySetupResult,
  MatrixRecoveryVerificationState,
  MatrixRoomPermissionProjection,
  MatrixRoomPowerLevelProjection,
  MatrixUnreadUpdate,
  NetworkStatusDto,
  NotificationPresentationContext,
  PeerDto,
  UserPreferences,
  VoiceProvider,
  VoiceServiceAvailability,
  VoiceServiceStatus,
} from './ipc.generated'

// Core wire DTOs are generated from Rust. Renderer-only enrichment stays
// explicit here so it cannot be mistaken for data returned over Tauri IPC.
export interface Identity extends IdentityDto {
  avatarUrl?: string | null
}

export interface Community extends CommunityDto {
  /** Optional renderer enrichment for services that expose community artwork. */
  iconUrl?: string | null
  bannerUrl?: string | null
}

export type ServerEmoji = CustomEmoji

export interface CommunityAccessSettings {
  alias: string | null
  discoverable: boolean
  joinRule: string
}

export interface CommunityDirectoryEntry {
  id: string
  alias: string | null
  name: string
  description: string
  memberCount: number
  joinRule: string
}

export interface CommunityApplication {
  userId: string
  displayName: string
  reason: string | null
  requestedAt: string | null
}

export interface CommunityAccessResult {
  status: 'knocked' | 'joined'
  community: Community | null
}

export type MatrixUserPreferences = UserPreferences

export interface Channel extends ChannelDto {
  unreadMentions?: number
}

export interface Message extends MessageDto {
  /** Development-only artwork used by the authenticated design preview. */
  designPreviewImageUrl?: string | null
}
export type Attachment = AttachmentDto
export type AttachmentThumbnail = AttachmentThumbnailDto

export interface FileDownloadRequest {
  fileHash: string
  sourcePeerId: string
  filename: string
  size: number
  chunks: number
}

export interface FileDownloadProgress {
  fileHash: string
  receivedChunks: number
  totalChunks: number
  receivedBytes: number
  totalBytes: number
  state: 'queued' | 'downloading' | 'completed' | 'error'
}

export interface FileAvailable {
  fileHash: string
  localPath: string
}

export type FileTransferStatus = 'idle' | 'downloading' | 'completed' | 'error'

export type MatrixTransferDirection = 'upload' | 'download'
export type MatrixTransferState =
  | 'queued'
  | 'encrypting'
  | 'uploading'
  | 'publishing'
  | 'downloading'
  | 'validating'
  | 'writing'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface MatrixTransferResult {
  eventId?: string | null
  localPath?: string | null
}

export interface MatrixTransferProgress {
  transferId: string
  direction: MatrixTransferDirection
  transferredBytes: number
  totalBytes?: number | null
  state: MatrixTransferState
  retryable: boolean
  retryMode?: 'restart-from-zero' | null
  result?: MatrixTransferResult | null
  error?: string | null
}

export type VoiceConnectionState =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'degraded' | 'disconnected'
export type VoiceTopology = 'mesh' | 'relay-election'

export interface VoiceRelayElection {
  relayPublicKey: string
  participantCount: number
  reason: 'threshold' | 'lexicographic'
  electedAt: string
}

export interface VoiceRelayElectionSnapshot {
  relayRequired: boolean
  relayCandidatePublicKey: string | null
}

export interface VoiceMemberSnapshot {
  publicKey: string
  joinedAt: string
  lastSeenAt: string
  isLocal: boolean
  displayName?: string
  avatarColor?: string
  peerId?: string
  isRelay?: boolean
  speaking?: boolean
  connectionState?: VoiceConnectionState
  latency?: number
  stream?: MediaStream
}

export interface VoiceSessionSnapshot {
  communityId: string
  channelId: string
  sessionEpoch: number
  memberCount: number
  relay: VoiceRelayElectionSnapshot
  members: VoiceMemberSnapshot[]
  updatedAt: string
  relayElection?: VoiceRelayElection | null
  topology?: VoiceTopology
  localPublicKey?: string | null
}

export interface VoiceSession {
  communityId: string
  channelId: string
  sessionEpoch: number
  memberCount: number
  relay: VoiceRelayElectionSnapshot
  members: VoiceMemberSnapshot[]
  updatedAt: string
}

export interface VoiceSessionUpdate {
  communityId: string
  channelId: string
  sessionEpoch: number
  members?: VoiceMemberSnapshot[]
  joined?: VoiceMemberSnapshot[]
  left?: string[]
  relay?: VoiceRelayElectionSnapshot
  updatedAt?: string
}

export interface VoiceSessionEvent {
  communityId: string
  channelId: string
  event: 'join' | 'leave' | 'heartbeat' | 'sweep'
  sourcePublicKey: string
  snapshot: VoiceSessionSnapshot
}

export interface VoiceSignalEvent {
  communityId: string
  channelId: string
  sourcePublicKey: string
  targetPeer: string
  signal: unknown
}

export interface VoiceSignalPayload {
  communityId: string
  channelId: string
  peerId: string
  signal: unknown
  epoch?: number
}

export interface Peer extends PeerDto {
  stream?: MediaStream // Local frontend reference to active WebRTC stream
  cameraStream?: MediaStream
  screenShareStream?: MediaStream
  screenShareAudioStream?: MediaStream
  role?: 'member' | 'relay'
  connectionState?: VoiceConnectionState
  joinedAt?: string
  lastSeenAt?: string
  isSelf?: boolean
  isLocal?: boolean
  isRelay?: boolean
  speaking?: boolean
}

export type NetworkStatus = NetworkStatusDto

// ─── Network state for the frontend ─────────────────

export type ConnectionState = 'connected' | 'degraded' | 'disconnected' | 'connecting'

export interface NetworkState {
  state: ConnectionState
  peerCount: number
  averageLatency: number
}

// ─── Realtime event payloads ────────────────────────

export interface ReactionEvent {
  messageId: string
  channelId: string
  emoji: string
  author: string
  verb: 'add' | 'remove'
}

export interface BanEvent {
  communityId: string
  bannedPublicKey: string
}

export interface DmConversation extends DmConversationDto {
  unreadMentions?: number
}
export type DirectMessage = Omit<DirectMessageDto, 'attachments' | 'reactions'> & {
  // Rust defaults omitted collections when accepting optimistic/local records.
  attachments?: Attachment[]
  reactions?: Record<string, string[]>
}
