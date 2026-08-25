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
  DmPeerDto,
  IdentityDto,
  MatrixQueuedMessageFailure,
  MessageDto,
  NetworkStatusDto,
  PeerDto,
  UserPreferences,
} from './ipc.generated'

export type {
  AttachmentDto,
  AttachmentThumbnailDto,
  ComposerDraftDto,
  BackendCapabilities,
  BackendKind,
  BackendStartupIssue,
  BackendStartupPhase,
  BackendStartupStatus,
  BackendStatus,
  BlockedAccountDto,
  BlockedAccountPageDto,
  ChannelDto,
  CommunityDto,
  CommunityInviteDto,
  CommunityPermissionAggregate,
  CommunityPermissionAggregateStatus,
  CommunityPermissionId,
  CommunityPermissionProjection,
  CommunityModerationResult,
  CustomEmoji,
  DirectMessageDto,
  DmConversationDto,
  DmPeerDto,
  DmRequestDto,
  IdentityDto,
  MessageDto,
  ModerationAuditEntry,
  ModerationRoomOutcome,
  MatrixNotification,
  MatrixNotificationActivation,
  MatrixIgnoredUsersChanged,
  MatrixPermissionRoomStatus,
  MatrixPermissionStateChanged,
  MatrixCommunityAdmission,
  MatrixPersonalDataExport,
  PendingInvitationMetadata,
  MatrixQueuedMessageFailure,
  MatrixQueuedMessageState,
  MatrixQueuedMessageUpdate,
  MatrixRoomNotificationMode,
  MatrixRoomUpgrade,
  MatrixRoomPins,
  MatrixRoomPinsUpdate,
  MatrixRoomUpdateKind,
  MatrixRecoveryHealth,
  MatrixRecoverySecureStorageState,
  MatrixRecoverySetupResult,
  MatrixRecoveryVerificationState,
  MatrixRoomPermissionProjection,
  MatrixRoomPowerLevelProjection,
  MatrixCrossCommunitySearchResultDto,
  MatrixSearchScopeDto,
  MatrixThreadContextDto,
  MatrixThreadListDto,
  MatrixTransferDirection,
  MatrixTransferProgress,
  MatrixTransferResult,
  MatrixTransferRetryMode,
  MatrixTransferState,
  MatrixTypingChanged,
  MatrixUnreadUpdate,
  NetworkStatusDto,
  NotificationPresentationContext,
  PeerDto,
  ThreadListItemDto,
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

/*
    Two renderer-only artwork fields used to live here, `iconUrl` and
    `bannerUrl`, described as enrichment for services that expose community
    artwork. Nothing in production set either one, only a dev preview fixture,
    so a community icon could not appear however it was uploaded and a banner
    had no reader at all. The icon is now `avatarUrl` on `CommunityDto`,
    projected from `m.room.avatar` like any other room state. A banner would
    need a place in the design language to appear, which it does not have, so
    there is no field standing in for one.
*/
export type Community = CommunityDto

export type ServerEmoji = CustomEmoji

/**
 * How people reach a community. The two fields are independent: `joinRule`
 * decides whether joining needs an invitation or an administrator's approval,
 * and `discoverable` decides only whether the community is published to the
 * account service's directory.
 */
export type CommunityJoinRule = 'invite' | 'knock'

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

/**
 * Somebody an account service returned for a directory search.
 *
 * Not a `MemberRecord`: this person shares no room with the searcher and has
 * no role, membership or ban state to report.
 */
export interface DirectoryPerson {
  userId: string
  displayName: string
  avatarUrl: string | null
  avatarColor: string
}

export interface DirectoryPeopleResult {
  people: DirectoryPerson[]
  /** The service had more matches than it returned. Not the same as none. */
  truncated: boolean
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
  /*
    `topic` is inherited as a required `string`, because the Rust DTO always
    sends one. Read it as `channel.topic ?? ''` anyway: a record that predates
    the field, or any faked IPC layer, makes a bare `.trim()` throw inside
    render, and an end-to-end run showed that taking down the whole content
    area through its error boundary. A missing description is worth a fallback
    sentence, never a blank conversation.
  */
  unreadMentions?: number
  /** The person's own explicit "mark as unread" marker, independent of unreadCount. */
  unreadMarked?: boolean
}

export type Message = Omit<MessageDto, 'mentions'> & {
  /** Older cached and local optimistic records may predate structured mentions. */
  mentions?: string[]
  /** Development-only artwork used by the authenticated design preview. */
  designPreviewImageUrl?: string | null
  /**
   * Why a failed send will never succeed. Present only alongside a `failed`
   * delivery status, and only when the send queue gave up for a reason worth
   * naming, so its absence means "we do not know" and a retry is still fair to
   * offer.
   */
  sendFailure?: MatrixQueuedMessageFailure | null
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

/*
    Attachment transfer progress is generated, not restated. The hand-written
    version spelled `MatrixTransferState` as a ten-member string union and
    `retryMode` as `'restart-from-zero'`, both of which had to match a
    kebab-case serde rename in Rust exactly, with nothing checking that they
    did. Adding a Rust variant would have left the renderer's switch silently
    short a case.

    It also marked every optional field with `?`, which the wire does not do:
    the backend sends `null` rather than omitting them. Payloads built in tests
    now spell those fields out, so a fixture cannot be shaped in a way the
    backend never produces.
*/

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
  /**
   * The participant's profile picture, joined on by `useCallPeers`.
   *
   * Not something the voice adapter can fill in: a LiveKit participant is
   * identified to the SFU by a digest of user, device and membership, never by a
   * Matrix user ID, so the call itself carries no way to tell whose face
   * belongs to a tile. MatrixRTC membership does, and that is where this comes
   * from. Absent for legacy peer-to-peer calls, which have no profile pictures.
   */
  avatarUrl?: string | null
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
  muted?: boolean
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
  /** The person's own explicit "mark as unread" marker, independent of unreadCount. */
  unreadMarked?: boolean
}

/**
 * The primary counterparty of a direct conversation: the sole peer of a
 * one-to-one DM, or the first of a group. Call sites that are inherently
 * per-peer today (block, report, the 1:1 trust summary, the sidebar/header
 * name and avatar) read through this so there is a single place to revisit
 * when group DMs land end to end.
 *
 * A valid conversation always carries at least one peer; the fallback keeps the
 * return non-optional so call sites stay drop-in replacements for the former
 * scalar fields, and the fallback colour matches the persistence default.
 */
export function dmPrimaryPeer(
  conversation: Pick<DmConversationDto, 'peers'>,
): DmPeerDto {
  return conversation.peers[0] ?? { userId: '', displayName: '', avatarColor: '#7a7570' }
}

/** The primary peer's display name, or undefined when the conversation is absent. */
export function dmPrimaryPeerName(
  conversation: Pick<DmConversationDto, 'peers'> | null | undefined,
): string | undefined {
  return conversation ? dmPrimaryPeer(conversation).displayName : undefined
}
export type DirectMessage = Omit<DirectMessageDto, 'attachments' | 'reactions'> & {
  // Rust defaults omitted collections when accepting optimistic/local records.
  attachments?: Attachment[]
  reactions?: Record<string, string[]>
  mentions?: string[]
}
