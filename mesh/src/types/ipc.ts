// ─── Core Type Shapes ───────────────────────────────
// These mirror the Rust DTOs exactly. This is the single source of truth
// for the IPC contract between frontend and backend.

export interface Identity {
  publicKey: string           // base64-encoded Ed25519 public key
  displayName: string
  avatarColor: string         // hex color
  avatarUrl?: string | null   // read-only MXC URI for Matrix profiles
}

export interface Community {
  id: string                  // base64-encoded community public key (short)
  name: string
  description: string
  memberCount: number
  role: 'owner' | 'admin' | 'member'
  joinedAt: string | null     // ISO timestamp
}

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

export interface MatrixUserPreferences {
  schemaVersion: number
  notificationsEnabled: boolean
  notificationSound: boolean
  mutedChannels: string[]
  mutedCommunities: string[]
  updatedAt: string
}

export interface Channel {
  id: string
  communityId: string
  name: string
  channelType: 'text' | 'voice'
  unreadCount: number
}

export interface Message {
  id: string
  channelId: string
  authorPublicKey: string
  authorDisplayName: string
  authorAvatarColor: string
  content: string
  attachments: Attachment[]
  reactions: Record<string, string[]>   // emoji → [publicKey]
  timestamp: string
  signature: string
  editedAt?: string | null
  deletedAt?: string | null
  replyToId?: string | null
  deliveryStatus?: 'sent' | 'pending' | 'failed' | null
}

export interface Attachment {
  fileHash: string
  filename: string
  size: number
  chunks: number
  sourcePeerId: string
  mediaSource?: Record<string, unknown> | null
  contentType?: string | null
}

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

export type VoiceConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'degraded' | 'disconnected'
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

export interface Peer {
  publicKey: string
  displayName: string
  avatarColor: string
  peerId: string             // libp2p PeerId
  latency: number            // ms
  stream?: MediaStream       // Local frontend reference to active WebRTC stream
  role?: 'member' | 'relay'
  connectionState?: VoiceConnectionState
  joinedAt?: string
  lastSeenAt?: string
  isSelf?: boolean
  isLocal?: boolean
  isRelay?: boolean
  speaking?: boolean
}

export interface NetworkStatus {
  connected: boolean
  peerCount: number
  averageLatency: number
  usingRelay: boolean
}

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

export interface DmConversation {
  id: string
  peerPublicKey: string
  peerDisplayName: string
  peerAvatarColor: string
  lastMessageAt: string | null
  unreadCount: number
  createdAt: string
}

export interface DirectMessage {
  id: string
  conversationId: string
  authorPublicKey: string
  authorDisplayName: string
  authorAvatarColor: string
  content: string
  timestamp: string
  signature: string
  attachments?: Attachment[]
  reactions?: Record<string, string[]>
  editedAt?: string | null
  deletedAt?: string | null
  replyToId?: string | null
  deliveryStatus?: 'sent' | 'pending' | 'failed' | null
}

export type LegacyRecordKind =
  | 'community'
  | 'channel'
  | 'membership'
  | 'message'
  | 'control_event'
  | 'file'

export interface LegacyChannelSummary {
  id: string
  name: string
  channelType: string
}

export interface LegacyCommunitySummary {
  id: string
  name: string
  channels: LegacyChannelSummary[]
}

export interface LegacyArchiveSummary {
  archiveId: string
  archiveSha256: string
  sourcePeerId: string
  communities: LegacyCommunitySummary[]
  recordCount: number
  embeddedFileCount: number
  missingFileCount: number
}

export interface LegacyExportRequest {
  communityId?: string
  filePaths?: Record<string, string>
  fileCandidates?: string[]
}

export interface LegacyExportResult {
  archivePath: string
  summary: LegacyArchiveSummary
}

export interface LegacyTargetMapping {
  legacyCommunityId: string
  matrixSpaceId: string
  channelRooms: Record<string, string>
}

export interface LegacyConflictResolution {
  conflictKey: string
  selectedRecordSha256: string
}

export interface LegacyImportRequest {
  archivePaths: string[]
  includeCommunityIds: string[]
  mappings: LegacyTargetMapping[]
  resolutions: LegacyConflictResolution[]
}

export interface LegacyConflictVariant {
  recordSha256: string
  sourcePeerIds: string[]
  archiveIds: string[]
  preview: string
}

export interface LegacyConflict {
  conflictKey: string
  kind: LegacyRecordKind
  entityId: string
  variants: LegacyConflictVariant[]
  selectedRecordSha256?: string
  resolved: boolean
}

export interface LegacyDryRunReport {
  planSha256: string
  archives: LegacyArchiveSummary[]
  peerCount: number
  recordGroupCount: number
  variantCount: number
  conflicts: LegacyConflict[]
  unresolvedConflictCount: number
  unmappedRecordCount: number
  missingFileCount: number
  errors: string[]
  warnings: string[]
  approvalToken?: string
  approvalPhrase?: string
}

export interface LegacyImportResult {
  planSha256: string
  importedEvents: number
  previouslyImportedEvents: number
  matrixEventIds: string[]
}
