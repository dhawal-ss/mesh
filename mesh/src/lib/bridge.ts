/**
 * Typed wrappers around Tauri's invoke() and listen() APIs.
 * This is the ONLY place the frontend talks to the Rust backend.
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { showToast } from '../components/ui/Toast'
import { describeError, normalizeError } from './errors'
import { canStartLegacyVoice } from './voice-runtime'
import type {
  Identity,
  Community,
  BackendCapabilities,
  BackendKind,
  BackendStatus,
  CommunityAccessSettings,
  CommunityDirectoryEntry,
  CommunityApplication,
  CommunityAccessResult,
  MatrixUserPreferences,
  MatrixNotification,
  MatrixUnreadUpdate,
  MatrixRoomNotificationMode,
  NotificationPresentationContext,
  LegacyArchiveSummary,
  LegacyDryRunReport,
  LegacyExportRequest,
  LegacyExportResult,
  LegacyImportRequest,
  LegacyImportResult,
  Channel,
  Message,
  Attachment,
  NetworkStatus,
  FileDownloadRequest,
  FileDownloadProgress,
  FileAvailable,
  MatrixTransferProgress,
  VoiceSessionSnapshot,
  VoiceSessionEvent,
  VoiceSignalEvent,
  VoiceSignalPayload,
  ReactionEvent,
  BanEvent,
  DmConversation,
  DirectMessage,
  VoiceServiceStatus,
} from '../types/ipc'

const tauriUnavailable = () =>
  normalizeError('Tauri runtime unavailable. Use `npm run tauri dev` for real IPC.')

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
  options?: { toast?: boolean },
): Promise<T> {
  if (!isTauri()) {
    throw tauriUnavailable()
  }

  try {
    return await invoke<T>(command, args)
  } catch (cause) {
    const error = normalizeError(cause)
    if (options?.toast) {
      const description = describeError(error)
      showToast(`${description.title}. ${description.body}`, 'error')
    }
    throw error
  }
}

async function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri()) {
    return () => {}
  }

  return listen<T>(event, (message) => handler(message.payload))
}

export function isTauriRuntime() {
  return isTauri()
}

export type {
  BackendCapabilities,
  BackendKind,
  BackendStatus,
  VoiceProvider,
  VoiceServiceAvailability,
  VoiceServiceStatus,
} from '../types/ipc'

let cachedBackendKind: BackendKind | null = null
const matrixCreatedChannels = new Map<string, Channel[]>()

export function isMatrixBackend(): boolean {
  return cachedBackendKind === 'matrix'
}

export function getMatrixUserId(): string | null {
  return cachedBackendStatus?.userId ?? null
}

const PREVIEW_MATRIX_CAPABILITIES: BackendCapabilities = {
  encryptedText: true,
  encryptedAttachments: true,
  directMessages: true,
  voice: false,
  durableTimeouts: false,
  deviceManagement: true,
  recovery: true,
  legacyMigration: false,
}

const PREVIEW_MATRIX_VOICE_SERVICE: VoiceServiceStatus = {
  provider: 'matrix-rtc',
  availability: 'not-configured',
  discoveryKey: 'org.matrix.msc4143.rtc_foci',
  livekitServiceUrl: null,
  tokenEndpoint: null,
  livekitSfuUrl: null,
  cspReady: false,
  mediaE2eeVerified: false,
  reason: 'MatrixRTC authorization and LiveKit are not configured in preview mode',
}

export function getBackendCapabilities(): BackendCapabilities {
  return cachedBackendStatus?.capabilities ?? PREVIEW_MATRIX_CAPABILITIES
}

export function getVoiceServiceStatus(): VoiceServiceStatus {
  return cachedBackendStatus?.voiceService ?? PREVIEW_MATRIX_VOICE_SERVICE
}

export function getBackendStatusSnapshot(): BackendStatus | null {
  return cachedBackendStatus
}

let cachedBackendStatus: BackendStatus | null = null

function cacheBackendStatus(status: BackendStatus): BackendStatus {
  cachedBackendKind = status.kind
  cachedBackendStatus = status
  return status
}

export interface MatrixLoginRequest {
  homeserver: string
  username: string
  password: string
  deviceName?: string
}

export interface MatrixOidcStatus {
  homeserver: string
  availability: 'supported' | 'not-supported' | 'invalid-configuration'
  issuer: string | null
  authorizationEndpoint: string | null
  registrationMode: 'static' | 'dynamic' | null
  clientIdConfigured: boolean
  redirectUri: string
  authorizationCodePkce: boolean
  nativeCallbackReady: boolean
  ready: boolean
  reason: string
}

export interface MatrixDevice {
  deviceId: string
  displayName: string | null
  lastSeenIp: string | null
  lastSeenAt: string | null
  firstSeenAt: string | null
  current: boolean
  verified: boolean
  crossSigned: boolean
  newDevice: boolean
  identityChanged: boolean
}

export interface MatrixAccount {
  profileId: string
  userId: string
  homeserver: string
  deviceId: string
  lastUsedAt: string
  current: boolean
}

export interface MatrixProfile {
  userId: string
  displayName: string | null
  avatarUrl: string | null
}

export interface MatrixRecoveryHealth {
  recoveryState: 'unknown' | 'enabled' | 'disabled' | 'incomplete'
  backupState: 'unknown' | 'creating' | 'enabling' | 'resuming' | 'enabled' | 'downloading' | 'disabling'
  backupExistsOnServer: boolean
  backupEnabled: boolean
  healthy: boolean
  checkedAt: string
  lastSuccessfulTestAt: string | null
  warnings: string[]
}

export interface MatrixVerificationSession {
  verificationId: string
  deviceId: string
  phase:
    | 'waiting-for-device'
    | 'choose-method'
    | 'started'
    | 'accepted'
    | 'compare'
    | 'qr-show'
    | 'qr-scanned'
    | 'confirmed'
    | 'done'
    | 'cancelled'
  method: 'sas' | 'qr' | null
  emojis: Array<{ symbol: string; description: string }>
  decimals: [number, number, number] | null
  qrSvg: string | null
  cancellationReason: string | null
}

export async function getBackendStatus(): Promise<BackendStatus> {
  if (!isTauri()) {
    const status: BackendStatus = {
      kind: 'matrix',
      capabilities: PREVIEW_MATRIX_CAPABILITIES,
      voiceService: PREVIEW_MATRIX_VOICE_SERVICE,
      authenticated: false,
      userId: null,
      deviceId: null,
      homeserver: null,
      syncRunning: false,
      durableHistory: true,
      endToEndEncryption: true,
      warnings: ['Tauri runtime unavailable'],
    }
    return cacheBackendStatus(status)
  }
  const status = await tauriInvoke<BackendStatus>('get_backend_status')
  return cacheBackendStatus(status)
}

export async function matrixLogin(request: MatrixLoginRequest): Promise<BackendStatus> {
  const status = await tauriInvoke<BackendStatus>('matrix_login', { request })
  return cacheBackendStatus(status)
}

export async function matrixRegisterAccount(
  username: string,
  password: string,
): Promise<BackendStatus> {
  const status = await tauriInvoke<BackendStatus>('register_account', { username, password })
  return cacheBackendStatus(status)
}

export async function matrixCheckUsernameAvailable(username: string): Promise<boolean> {
  return tauriInvoke<boolean>('check_username_available', { username })
}

export const registerAccount = matrixRegisterAccount
export const checkUsernameAvailable = matrixCheckUsernameAvailable

export async function matrixOidcStatus(homeserver: string): Promise<MatrixOidcStatus> {
  return tauriInvoke<MatrixOidcStatus>('matrix_oidc_status', { homeserver })
}

export async function matrixStartOidcLogin(homeserver: string): Promise<BackendStatus> {
  await tauriInvoke('matrix_start_oidc_login', { homeserver })
  return getBackendStatus()
}

export async function matrixCancelLogin(): Promise<void> {
  return tauriInvoke('matrix_cancel_login')
}

export async function matrixRestoreSession(): Promise<BackendStatus> {
  const status = await tauriInvoke<BackendStatus>('matrix_restore_session')
  return cacheBackendStatus(status)
}

export async function matrixLogout(): Promise<void> {
  await tauriInvoke('matrix_logout')
  cachedBackendKind = 'matrix'
  cachedBackendStatus = null
}

export async function matrixDevices(): Promise<MatrixDevice[]> {
  return tauriInvoke('matrix_devices')
}

export async function matrixRevokeDevice(deviceId: string, password: string): Promise<void> {
  return tauriInvoke('matrix_revoke_device', { deviceId, password })
}

export async function matrixRemoveLocalAccount(): Promise<void> {
  await tauriInvoke('matrix_remove_local_account')
  cachedBackendKind = 'matrix'
  cachedBackendStatus = null
}

export async function matrixAccounts(): Promise<MatrixAccount[]> {
  return tauriInvoke('matrix_accounts')
}

export async function matrixGetProfile(): Promise<MatrixProfile> {
  return tauriInvoke('matrix_get_profile')
}

export async function matrixUpdateProfileDisplayName(displayName: string): Promise<MatrixProfile> {
  return tauriInvoke('matrix_update_profile_display_name', { displayName })
}

export async function matrixSwitchAccount(profileId: string): Promise<BackendStatus> {
  const status = await tauriInvoke<BackendStatus>('matrix_switch_account', { profileId })
  return cacheBackendStatus(status)
}

export async function matrixRecoveryHealth(): Promise<MatrixRecoveryHealth> {
  return tauriInvoke('matrix_recovery_health')
}

export async function matrixTestRecovery(recoveryKeyOrPassphrase: string): Promise<MatrixRecoveryHealth> {
  return tauriInvoke('matrix_test_recovery', { recoveryKeyOrPassphrase })
}

export async function matrixStartDeviceVerification(deviceId: string): Promise<MatrixVerificationSession> {
  return tauriInvoke('matrix_start_device_verification', { deviceId })
}

export async function matrixDeviceVerificationStatus(verificationId: string): Promise<MatrixVerificationSession> {
  return tauriInvoke('matrix_device_verification_status', { verificationId })
}

export async function matrixSelectDeviceVerificationMethod(
  verificationId: string,
  method: 'sas' | 'qr',
): Promise<MatrixVerificationSession> {
  return tauriInvoke('matrix_select_device_verification_method', { verificationId, method })
}

export async function matrixConfirmDeviceVerification(
  verificationId: string,
  matches: boolean,
): Promise<MatrixVerificationSession> {
  return tauriInvoke('matrix_confirm_device_verification', { verificationId, matches })
}

export async function matrixCancelDeviceVerification(verificationId: string): Promise<void> {
  return tauriInvoke('matrix_cancel_device_verification', { verificationId })
}

export async function getMatrixUserPreferences(): Promise<MatrixUserPreferences | null> {
  return tauriInvoke('matrix_user_preferences')
}

export async function updateMatrixUserPreferences(
  preferences: Omit<MatrixUserPreferences, 'updatedAt'>,
): Promise<MatrixUserPreferences> {
  return tauriInvoke('matrix_update_user_preferences', {
    preferences: { ...preferences, updatedAt: new Date(0).toISOString() },
  })
}

export async function setNotificationContext(
  context: NotificationPresentationContext,
): Promise<void> {
  return tauriInvoke('set_notification_context', { context })
}

export async function sendTestNotification(): Promise<void> {
  return tauriInvoke('send_test_notification')
}

export async function getMatrixRoomNotificationMode(
  roomId: string,
): Promise<MatrixRoomNotificationMode> {
  return tauriInvoke('matrix_get_room_notification_mode', { roomId })
}

export async function setMatrixRoomNotificationMode(
  roomId: string,
  mode: MatrixRoomNotificationMode,
): Promise<void> {
  return tauriInvoke('matrix_set_room_notification_mode', { roomId, mode })
}

export async function matrixCreateCommunity(
  name: string,
  description: string,
): Promise<Community> {
  const created = await tauriInvoke<{ community: Community; channel: Channel }>(
    'matrix_create_community',
    { name, description },
  )
  matrixCreatedChannels.set(created.community.id, [created.channel])
  return created.community
}

export async function matrixListCommunities(): Promise<Community[]> {
  return tauriInvoke('matrix_list_communities')
}

export async function matrixListChannels(communityId: string): Promise<Channel[]> {
  const channels = await tauriInvoke<Channel[]>('matrix_list_channels', { communityId })
  const merged = new Map<string, Channel>()
  for (const channel of matrixCreatedChannels.get(communityId) ?? []) {
    merged.set(channel.id, channel)
  }
  for (const channel of channels) {
    merged.set(channel.id, channel)
  }
  return [...merged.values()]
}

export async function matrixCreateChannel(
  communityId: string,
  name: string,
  channelType: 'text' | 'voice',
): Promise<Channel> {
  const channel = await tauriInvoke<Channel>('matrix_create_channel', {
    communityId,
    name,
    channelType,
  })
  matrixCreatedChannels.set(communityId, [
    ...(matrixCreatedChannels.get(communityId) ?? []).filter((entry) => entry.id !== channel.id),
    channel,
  ])
  return channel
}

export async function matrixSendMessage(
  roomId: string,
  body: string,
  replyToId?: string,
): Promise<Message> {
  return tauriInvoke('matrix_send_message', { roomId, body, replyToId })
}

export async function matrixSendAttachment(
  roomId: string,
  attachmentGrant: string,
  transferId: string,
  body: string,
  replyToId?: string,
): Promise<Message> {
  return tauriInvoke('matrix_send_attachment', {
    roomId,
    attachmentGrant,
    transferId,
    body,
    replyToId,
  })
}

export function createMatrixTransferId(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function onMatrixTransferProgress(
  handler: (data: MatrixTransferProgress) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:transfer-progress', handler)
}

export async function matrixCancelAttachmentUpload(transferId: string): Promise<void> {
  return tauriInvoke('matrix_cancel_attachment_upload', { transferId })
}

export async function matrixDownloadAttachment(
  attachment: Attachment,
  transferId: string,
): Promise<string> {
  return tauriInvoke('matrix_download_attachment', { attachment, transferId })
}

export async function matrixCancelAttachmentDownload(fileHash: string): Promise<void> {
  return tauriInvoke('matrix_cancel_attachment_download', { fileHash })
}

export interface StagedAttachmentBytes {
  token: string
  grant: string
  name: string
  size: number
  contentType: string
}

export interface NativeAttachmentGrant {
  grant: string
  name: string
  size: number
  contentType: string
  legacyPath?: string
}

export interface NativeAttachmentIntake {
  files: NativeAttachmentGrant[]
  errors: string[]
}

export async function pickAttachmentGrants(): Promise<NativeAttachmentIntake> {
  return tauriInvoke('pick_attachment_grants')
}

export async function acceptAttachmentDropGrants(grants: string[]): Promise<void> {
  return tauriInvoke('accept_attachment_drop_grants', { grants })
}

export async function stageAttachmentBytes(
  filename: string,
  bytes: number[],
): Promise<StagedAttachmentBytes> {
  return tauriInvoke('stage_attachment_bytes', { filename, bytes })
}

export async function discardStagedAttachment(token: string): Promise<void> {
  return tauriInvoke('discard_staged_attachment', { token })
}

export async function discardAttachmentGrant(grant: string): Promise<void> {
  return tauriInvoke('discard_attachment_grant', { grant })
}

export async function matrixGetMessages(
  roomId: string,
  limit: number,
  before?: { timestamp: string; id: string },
): Promise<Message[]> {
  return tauriInvoke('matrix_get_messages', {
    roomId,
    limit,
    beforeTimestamp: before?.timestamp,
    beforeId: before?.id,
  })
}

export async function matrixWaitForRoomUpdate(roomId: string, timeoutMs = 25_000): Promise<boolean> {
  return tauriInvoke('matrix_wait_for_room_update', { roomId, timeoutMs })
}

export interface MatrixTypingUser {
  userId: string
  displayName: string
}

export async function matrixTypingUsers(roomId: string): Promise<MatrixTypingUser[]> {
  return tauriInvoke('matrix_typing_users', { roomId })
}

export async function matrixSyncOnce(): Promise<void> {
  return tauriInvoke('matrix_sync_once')
}

export async function matrixEnableRecovery(passphrase?: string): Promise<string> {
  return tauriInvoke('matrix_enable_recovery', { passphrase })
}

export async function matrixRecover(recoveryKeyOrPassphrase: string): Promise<void> {
  return tauriInvoke('matrix_recover', { recoveryKeyOrPassphrase })
}

export async function exportLegacyArchive(
  request: LegacyExportRequest = {},
): Promise<LegacyExportResult> {
  return tauriInvoke('export_legacy_archive', { request })
}

export async function inspectLegacyArchives(
  archivePaths: string[],
): Promise<LegacyArchiveSummary[]> {
  return tauriInvoke('inspect_legacy_archives', { archivePaths })
}

export async function dryRunLegacyImport(
  request: LegacyImportRequest,
): Promise<LegacyDryRunReport> {
  return tauriInvoke('dry_run_legacy_import', { request })
}

export async function approveLegacyImport(
  request: LegacyImportRequest,
  approvalToken: string,
  approvalPhrase: string,
): Promise<LegacyImportResult> {
  return tauriInvoke('approve_legacy_import', { request, approvalToken, approvalPhrase })
}

// ─── Identity Commands ──────────────────────────────

export async function generateIdentity(displayName: string, avatarColor: string): Promise<Identity> {
  return tauriInvoke('generate_identity', { displayName, avatarColor })
}

export async function createIdentity(): Promise<Identity> {
  return tauriInvoke('create_identity')
}

export async function getIdentity(): Promise<Identity | null> {
  if (!isTauri()) {
    return null
  }

  return tauriInvoke('get_identity')
}

export async function updateProfile(displayName: string, avatarColor: string): Promise<Identity> {
  return tauriInvoke('update_profile', { displayName, avatarColor })
}

export async function updateDisplayName(name: string): Promise<void> {
  return tauriInvoke('update_display_name', { name })
}

export async function exportIdentity(passphrase: string): Promise<string> {
  return tauriInvoke('export_identity', { passphrase })
}

export async function importIdentity(bundleB64: string, passphrase: string): Promise<Identity> {
  return tauriInvoke('import_identity', { bundleB64, passphrase })
}

// ─── Community Commands ─────────────────────────────

export async function createCommunity(name: string, description: string): Promise<Community> {
  if (isMatrixBackend()) {
    return matrixCreateCommunity(name, description)
  }
  return tauriInvoke('create_community', { name, description })
}

export async function getCommunities(): Promise<Community[]> {
  if (!isTauri()) {
    return []
  }

  return isMatrixBackend() ? matrixListCommunities() : tauriInvoke('get_communities')
}

export async function joinCommunity(inviteLink: string): Promise<Community> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_join_community', { roomOrAlias: inviteLink })
  }
  return tauriInvoke('join_community', { inviteLink })
}

export async function leaveCommunity(communityId: string): Promise<void> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_leave_community', { communityId })
  }
  return tauriInvoke('leave_community', { communityId })
}

export async function deleteCommunity(communityId: string): Promise<void> {
  if (isMatrixBackend()) {
    return leaveCommunity(communityId)
  }
  return tauriInvoke('delete_community', { communityId })
}

export async function inviteMatrixUser(communityId: string, username: string): Promise<void> {
  return tauriInvoke('matrix_invite_to_community', { communityId, username })
}

export async function getCommunityAccessSettings(
  communityId: string,
): Promise<CommunityAccessSettings> {
  return tauriInvoke('matrix_community_access_settings', { communityId })
}

export async function updateCommunityAccess(
  communityId: string,
  alias: string,
  discoverable: boolean,
): Promise<CommunityAccessSettings> {
  return tauriInvoke('matrix_update_community_access', {
    communityId,
    alias: alias.trim() || null,
    discoverable,
  })
}

export async function searchCommunityDirectory(
  query: string,
  server?: string,
  limit = 20,
): Promise<CommunityDirectoryEntry[]> {
  return tauriInvoke('matrix_search_community_directory', {
    query,
    server: server?.trim() || null,
    limit,
  })
}

export async function requestCommunityAccess(
  roomOrAlias: string,
  reason?: string,
): Promise<CommunityAccessResult> {
  return tauriInvoke('matrix_knock_community', {
    roomOrAlias,
    reason: reason?.trim() || null,
  })
}

export async function getCommunityApplications(
  communityId: string,
): Promise<CommunityApplication[]> {
  return tauriInvoke('matrix_list_community_applications', { communityId })
}

export async function respondToCommunityApplication(
  communityId: string,
  userId: string,
  accept: boolean,
  reason?: string,
): Promise<void> {
  return tauriInvoke('matrix_respond_community_application', {
    communityId,
    userId,
    accept,
    reason: reason?.trim() || null,
  })
}

export async function generateInviteLink(communityId: string): Promise<string> {
  return tauriInvoke('generate_invite_link', { communityId })
}

// ─── Channel Commands ───────────────────────────────

export async function getChannels(communityId: string): Promise<Channel[]> {
  if (!isTauri()) {
    return []
  }

  return isMatrixBackend()
    ? matrixListChannels(communityId)
    : tauriInvoke('get_channels', { communityId })
}

export async function createChannel(communityId: string, name: string, type: 'text' | 'voice'): Promise<Channel> {
  if (isMatrixBackend()) {
    return matrixCreateChannel(communityId, name, type)
  }
  return tauriInvoke('create_channel', { communityId, name, channelType: type })
}

export async function updateCommunityMetadata(
  communityId: string,
  name: string,
  description: string,
): Promise<void> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_update_community', { communityId, name, description })
  }
  return tauriInvoke('update_community_metadata', { communityId, name, description })
}

export async function syncLocalChannel(
  communityId: string,
  channelId: string,
  name: string,
  type: 'text' | 'voice',
): Promise<void> {
  return tauriInvoke('sync_local_channel', { communityId, channelId, name, channelType: type })
}

// ─── Message Commands ───────────────────────────────

export async function sendMessage(channelId: string, content: string, attachments: Attachment[] = [], replyToId?: string): Promise<Message> {
  if (isMatrixBackend()) {
    if (attachments.length > 0) {
      throw new Error('Use matrixSendAttachment for encrypted Matrix media')
    }
    return matrixSendMessage(channelId, content, replyToId)
  }
  return tauriInvoke('send_message', { channelId, content, attachments, replyToId })
}

export async function getMessages(
  channelId: string,
  limit: number = 50,
  before?: { timestamp: string; id: string },
): Promise<Message[]> {
  if (isMatrixBackend()) {
    return matrixGetMessages(channelId, limit, before)
  }
  return tauriInvoke('get_messages', {
    channelId,
    limit,
    beforeTimestamp: before?.timestamp,
    beforeId: before?.id,
  })
}

export async function markChannelRead(channelId: string): Promise<void> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_mark_read', { roomId: channelId })
  }
  return tauriInvoke('mark_channel_read', { channelId })
}

export async function requestMessageHistory(
  channelId: string,
  options: { peerId?: string; limit?: number } = {},
): Promise<void> {
  if (isMatrixBackend()) {
    await matrixSyncOnce()
    return
  }
  return tauriInvoke('request_message_history', {
    channelId,
    peerId: options.peerId,
    limit: options.limit,
  })
}

export async function editMessage(messageId: string, content: string, channelId?: string): Promise<Message | void> {
  if (isMatrixBackend()) {
    if (!channelId) throw new Error('Matrix room ID is required to edit a message')
    return tauriInvoke('matrix_edit_message', { roomId: channelId, eventId: messageId, body: content })
  }
  return tauriInvoke('edit_message', { messageId, content })
}

export async function deleteMessage(messageId: string, channelId?: string): Promise<void> {
  if (isMatrixBackend()) {
    if (!channelId) throw new Error('Matrix room ID is required to redact a message')
    return tauriInvoke('matrix_redact_message', { roomId: channelId, eventId: messageId })
  }
  return tauriInvoke('delete_message', { messageId })
}

export async function addReaction(messageId: string, emoji: string, channelId?: string): Promise<string | boolean> {
  if (isMatrixBackend()) {
    if (!channelId) throw new Error('Matrix room ID is required to react to a message')
    return tauriInvoke('matrix_toggle_reaction', { roomId: channelId, eventId: messageId, key: emoji })
  }
  return tauriInvoke('add_reaction', { messageId, emoji })
}

export async function searchMessages(
  query: string,
  communityId: string,
  limit: number = 50,
): Promise<Message[]> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_search_messages', { query, communityId, limit })
  }
  return tauriInvoke('search_messages', { query, communityId, limit })
}

// ─── Channel Event Log ────────────────────────────

export interface ChannelEvent {
  sequence: number
  eventType: 'message' | 'edit' | 'delete' | 'reaction_add' | 'reaction_remove'
  eventId: string
  targetId: string | null
  authorPublicKey: string
  payload: string
  signature: string
  timestamp: string
}

export async function getChannelEventLog(channelId: string, sinceSequence: number, limit?: number): Promise<{
  channelId: string
  events: ChannelEvent[]
  latestSequence: number
}> {
  return tauriInvoke('get_channel_event_log', { channelId, sinceSequence, limit })
}

// ─── KV Store Commands ─────────────────────────────

export async function setKv(key: string, value: string): Promise<void> {
  return tauriInvoke('set_kv', { key, value })
}

// ─── Typing Commands ───────────────────────────────

export async function broadcastTyping(channelId: string): Promise<void> {
  if (isMatrixBackend()) {
    return setTyping(channelId, true)
  }
  return tauriInvoke('broadcast_typing', { channelId })
}

export async function setTyping(channelId: string, typing: boolean): Promise<void> {
  if (!isMatrixBackend()) return
  return tauriInvoke('matrix_set_typing', { roomId: channelId, typing })
}

export interface TypingEvent {
  channelId: string
  author: string
  displayName: string
  timestamp: string
}

export function onTypingUpdate(handler: (data: TypingEvent) => void): Promise<UnlistenFn> {
  return tauriListen('typing:update', handler)
}

// ─── ICE Server Configuration ──────────────────────

export interface IceServerConfig {
  urls: string[]
  username?: string
  credential?: string
}

export async function getIceServers(): Promise<IceServerConfig[]> {
  try {
    return await tauriInvoke<IceServerConfig[]>('get_ice_servers')
  } catch {
    // Fallback if backend doesn't support this yet
    return [
      { urls: ['stun:stun.l.google.com:19302'] },
    ]
  }
}

export interface IceServerStatus {
  stunConfigured: boolean
  turnConfigured: boolean
  customServers: boolean
  serverCount: number
  warnings: string[]
}

export async function getIceServerStatus(): Promise<IceServerStatus> {
  try {
    return await tauriInvoke<IceServerStatus>('get_ice_server_status')
  } catch {
    return {
      stunConfigured: false,
      turnConfigured: false,
      customServers: false,
      serverCount: 0,
      warnings: ['Failed to load ICE server status'],
    }
  }
}

/// Validate ICE server config without persisting it. Returns the status with
/// any warnings. Fatal errors (malformed URLs, invalid ports) appear as warnings.
export async function validateIceServers(
  servers: IceServerConfig[],
): Promise<IceServerStatus> {
  return tauriInvoke<IceServerStatus>('validate_ice_servers', { servers })
}

/// Persist a custom ICE server configuration. Rejects configs with fatal
/// errors (malformed URLs, missing credentials on TURN, invalid ports).
export async function setIceServers(
  servers: IceServerConfig[],
): Promise<IceServerStatus> {
  return tauriInvoke<IceServerStatus>('set_ice_servers', { servers })
}

export interface IceServerProbeResult {
  url: string
  scheme: string
  host: string
  port: number
  /** One of: ok, malformed, dns_failed, unreachable, no_credentials, timeout, tls_error */
  outcome: string
  detail: string
  resolvedAddrs: string[]
  latencyMs: number | null
}

/// Probe all configured ICE servers for reachability. Returns per-URL results
/// that distinguish malformed, unreachable, no_credentials, ok.
export async function probeIceServers(): Promise<IceServerProbeResult[]> {
  try {
    return await tauriInvoke<IceServerProbeResult[]>('probe_ice_servers')
  } catch (e) {
    console.warn('Failed to probe ICE servers:', e)
    return []
  }
}

// ─── System Diagnostics ────────────────────────────

export interface SchedulerStats {
  fileHash: string
  totalChunks: number
  receivedChunks: number
  pendingChunks: number
  inFlightChunks: number
  retryQueueLength: number
  seederCount: number
  activeSeeders: number
  totalSuccessfulRequests: number
  totalFailedRequests: number
  avgSeederRttMs: number
  isComplete: boolean
  isStalled: boolean
  isFailed: boolean
}

export interface IceServerHealth {
  stunConfigured: boolean
  turnConfigured: boolean
  customServers: boolean
}

export interface SystemDiagnostics {
  networkConnected: boolean
  networkPeerCount: number
  identityLoaded: boolean
  communityCount: number
  memberCount: number
  activeDownloadCount: number
  downloadStats: SchedulerStats[]
  activeVoiceSessions: number
  iceServerStatus: IceServerHealth
  pendingMessageCount: number
  version: string
  warnings: string[]
}

export async function getDiagnostics(): Promise<SystemDiagnostics> {
  return tauriInvoke<SystemDiagnostics>('get_diagnostics')
}

// ─── Voice Commands ─────────────────────────────────

export interface MatrixRtcJoinResult {
  roomId: string
  sessionId: string
  memberId: string
  url: string
  token: string
  roomName: string
  participantIdentity: string
  mediaE2eeVerified: boolean
  mediaKey: MatrixRtcMediaKey
}

export interface MatrixRtcMember {
  roomId: string
  userId: string
  deviceId: string
  sessionId: string
  displayName: string
  avatarUrl: string | null
}

export interface MatrixRtcMembershipEvent {
  roomId: string
  members: MatrixRtcMember[]
}

/**
 * Ephemeral per-participant MatrixRTC media key material.
 *
 * This payload is delivered only through the Tauri event boundary. Callers
 * must apply it directly to the media engine and must not persist it.
 */
export interface MatrixRtcMediaKey {
  roomId: string
  userId: string
  deviceId: string
  memberId: string
  participantIdentity: string
  keyIndex: number
  key: string
  sentTs: number
  sessionId: string | null
  activationId: string | null
}

export interface MatrixRtcMediaKeyFailure {
  roomId: string
  code: string
}

export interface MatrixRtcMediaKeyPause {
  roomId: string
  sessionId: string
  memberId: string
  activationId: string
  keyIndex: number
}

export interface MatrixRtcMediaKeyLease {
  roomId: string
  sessionId: string
  memberId: string
  keyIndex: number
  expiresAt: number
}

export async function matrixRtcJoin(roomId: string): Promise<MatrixRtcJoinResult> {
  return tauriInvoke('matrix_rtc_join', { roomId })
}

export async function matrixRtcLeave(roomId: string, sessionId: string): Promise<void> {
  return tauriInvoke('matrix_rtc_leave', { roomId, sessionId })
}

export async function matrixRtcMembers(roomId: string): Promise<MatrixRtcMember[]> {
  return tauriInvoke('matrix_rtc_members', { roomId })
}

export async function matrixRtcRefreshMembership(
  roomId: string,
  sessionId: string,
): Promise<MatrixRtcMember[]> {
  return tauriInvoke('matrix_rtc_refresh_membership', { roomId, sessionId })
}

export async function matrixRtcAckMediaKeyPause(
  roomId: string,
  sessionId: string,
  memberId: string,
  activationId: string,
): Promise<MatrixRtcMediaKey> {
  return tauriInvoke('matrix_rtc_ack_media_key_pause', {
    roomId,
    sessionId,
    memberId,
    activationId,
  })
}

export async function matrixRtcAckMediaKey(
  roomId: string,
  sessionId: string,
  memberId: string,
  activationId: string,
  keyIndex: number,
  sentTs: number,
): Promise<void> {
  return tauriInvoke('matrix_rtc_ack_media_key', {
    roomId,
    sessionId,
    memberId,
    activationId,
    keyIndex,
    sentTs,
  })
}

export async function matrixRtcRenewMediaKeyLease(
  roomId: string,
  sessionId: string,
  memberId: string,
): Promise<MatrixRtcMediaKeyLease> {
  return tauriInvoke('matrix_rtc_renew_media_key_lease', {
    roomId,
    sessionId,
    memberId,
  })
}

export async function joinVoice(communityId: string, channelId: string): Promise<VoiceSessionSnapshot> {
  requireLegacyVoice('join a voice channel')
  return tauriInvoke('join_voice', { communityId, channelId })
}

export async function leaveVoice(communityId: string, channelId: string): Promise<void> {
  requireLegacyVoice('leave a voice channel')
  return tauriInvoke('leave_voice', { communityId, channelId })
}

export async function setMuted(muted: boolean): Promise<void> {
  requireLegacyVoice('change voice mute state')
  return tauriInvoke('set_muted', { muted })
}

export async function setDeafened(deafened: boolean): Promise<void> {
  requireLegacyVoice('change voice deafen state')
  return tauriInvoke('set_deafened', { deafened })
}

export async function sendVoiceSignal(peerId: string, signal: unknown, communityId: string, channelId: string): Promise<void> {
  requireLegacyVoice('send legacy WebRTC signaling')
  // Validate that the signal payload is serializable before sending to Tauri
  try {
    JSON.stringify(signal)
  } catch (err) {
    console.error('[bridge] sendVoiceSignal: signal is not serializable, dropping', err)
    return
  }

  const payload: VoiceSignalPayload = { peerId, signal, communityId, channelId }
  return tauriInvoke('send_voice_signal', {
    peerId: payload.peerId,
    signal: payload.signal,
    communityId: payload.communityId,
    channelId: payload.channelId,
  } as Record<string, unknown>)
}

function requireLegacyVoice(operation: string): void {
  if (!canStartLegacyVoice(cachedBackendStatus)) {
    throw new Error(
      `Cannot ${operation}: Matrix production requires MatrixRTC and never falls back to legacy SimplePeer`,
    )
  }
}

// ─── Notification Sound ────────────────────────────

export type NotificationSoundId = 'mesh' | 'chime' | 'pulse' | 'soft'

interface NotificationTone {
  frequency: number
  offset: number
  duration: number
  volume: number
  type: OscillatorType
}

const NOTIFICATION_TONES: Record<NotificationSoundId, NotificationTone[]> = {
  mesh: [
    { frequency: 523.25, offset: 0, duration: 0.12, volume: 0.12, type: 'sine' },
    { frequency: 783.99, offset: 0.1, duration: 0.18, volume: 0.1, type: 'sine' },
  ],
  chime: [
    { frequency: 659.25, offset: 0, duration: 0.16, volume: 0.1, type: 'sine' },
    { frequency: 987.77, offset: 0.13, duration: 0.24, volume: 0.08, type: 'sine' },
  ],
  pulse: [
    { frequency: 440, offset: 0, duration: 0.08, volume: 0.08, type: 'triangle' },
    { frequency: 440, offset: 0.13, duration: 0.08, volume: 0.08, type: 'triangle' },
  ],
  soft: [
    { frequency: 392, offset: 0, duration: 0.24, volume: 0.06, type: 'sine' },
  ],
}

let notificationAudioContext: AudioContext | null = null

function playNotificationTones(context: AudioContext, tones: NotificationTone[]) {
  const start = context.currentTime
  for (const tone of tones) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const toneStart = start + tone.offset
    const toneEnd = toneStart + tone.duration

    oscillator.type = tone.type
    oscillator.frequency.setValueAtTime(tone.frequency, toneStart)
    gain.gain.setValueAtTime(0.0001, toneStart)
    gain.gain.exponentialRampToValueAtTime(tone.volume, toneStart + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(toneStart)
    oscillator.stop(toneEnd + 0.02)
  }
}

export function playNotificationSound(soundId: NotificationSoundId = 'mesh') {
  if (typeof AudioContext === 'undefined') return

  try {
    notificationAudioContext ??= new AudioContext()
    const context = notificationAudioContext
    const play = () => playNotificationTones(context, NOTIFICATION_TONES[soundId])
    if (context.state === 'suspended') {
      void context.resume().then(play).catch(() => {})
    } else {
      play()
    }
  } catch {
    // The native desktop notification remains useful if a locked-down webview
    // refuses background audio.
  }
}

// ─── Event Listeners ────────────────────────────────

export function onMessageReceived(handler: (message: Message) => void): Promise<UnlistenFn> {
  return tauriListen('message:received', handler)
}

export function onMatrixNotification(
  handler: (notification: MatrixNotification) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:notification', handler)
}

export function onMatrixUnreadUpdate(
  handler: (update: MatrixUnreadUpdate) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:unread-update', handler)
}

export function onReactionReceived(handler: (data: ReactionEvent) => void): Promise<UnlistenFn> {
  return tauriListen('reaction:received', handler)
}

export function onMessageEdited(handler: (data: { messageId: string; channelId: string; content: string; editedAt: string }) => void): Promise<UnlistenFn> {
  return tauriListen('message:edited', handler)
}

export function onMessageDeleted(handler: (data: { messageId: string; channelId: string }) => void): Promise<UnlistenFn> {
  return tauriListen('message:deleted', handler)
}

export function onPeerJoined(handler: (data: { peerId: string }) => void): Promise<UnlistenFn> {
  return tauriListen('peer:joined', handler)
}

export function onPeerLeft(handler: (data: { peerId: string }) => void): Promise<UnlistenFn> {
  return tauriListen('peer:left', handler)
}

export function onNetworkStatus(handler: (status: NetworkStatus) => void): Promise<UnlistenFn> {
  return tauriListen('network:status', handler)
}

export function onCommunityUpdated(handler: (community: Community) => void): Promise<UnlistenFn> {
  return tauriListen('community:updated', handler)
}

export function onVoiceSignal(handler: (data: VoiceSignalEvent) => void): Promise<UnlistenFn> {
  if (isMatrixBackend()) return Promise.resolve(() => {})
  return tauriListen('voice:signal', handler)
}

export function onVoiceJoin(handler: (data: { author: string; communityId: string; channelId: string }) => void): Promise<UnlistenFn> {
  if (isMatrixBackend()) return Promise.resolve(() => {})
  return tauriListen('voice:join', handler)
}

export function onVoiceLeave(handler: (data: { author: string; communityId: string; channelId: string }) => void): Promise<UnlistenFn> {
  if (isMatrixBackend()) return Promise.resolve(() => {})
  return tauriListen('voice:leave', handler)
}

export function onVoiceSession(handler: (data: VoiceSessionSnapshot) => void): Promise<UnlistenFn> {
  if (isMatrixBackend()) return Promise.resolve(() => {})
  return tauriListen('voice:session:snapshot', handler)
}

export function onVoiceSessionEvent(handler: (data: VoiceSessionEvent) => void): Promise<UnlistenFn> {
  if (isMatrixBackend()) return Promise.resolve(() => {})
  return tauriListen('voice:session:event', handler)
}

export function onMatrixRtcMembership(
  handler: (data: MatrixRtcMembershipEvent) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:rtc-membership', handler)
}

export function onMatrixRtcMediaKey(
  handler: (data: MatrixRtcMediaKey) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:rtc-media-key', handler)
}

export function onMatrixRtcMediaKeyFailure(
  handler: (data: MatrixRtcMediaKeyFailure) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:rtc-media-key-failure', handler)
}

export function onMatrixRtcMediaKeyPause(
  handler: (data: MatrixRtcMediaKeyPause) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:rtc-media-key-pause', handler)
}

export function onBanReceived(handler: (data: BanEvent) => void): Promise<UnlistenFn> {
  return tauriListen('ban_received', handler)
}

// ─── DM Commands ────────────────────────────────────

export async function sendDm(recipientPublicKey: string, content: string, replyToId?: string): Promise<DirectMessage> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_send_dm', {
      recipientUserId: recipientPublicKey,
      body: content,
      replyToId,
    })
  }
  return tauriInvoke('send_dm', { recipientPublicKey, content })
}

export async function getDmConversations(): Promise<DmConversation[]> {
  if (!isTauri()) return []
  if (isMatrixBackend()) return tauriInvoke('matrix_dm_conversations')
  return tauriInvoke('get_dm_conversations')
}

export async function ensureDm(recipientUserId: string): Promise<DmConversation> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_ensure_dm', { recipientUserId })
  }
  throw new Error('Starting a new DM is unavailable in the legacy bridge')
}

export async function getDmMessages(
  conversationId: string,
  limit: number = 50,
  before?: { timestamp: string; id: string },
): Promise<DirectMessage[]> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_dm_messages', {
      conversationId,
      limit,
      beforeTimestamp: before?.timestamp,
      beforeId: before?.id,
    })
  }
  return tauriInvoke('get_dm_messages', {
    conversationId,
    limit,
    beforeTimestamp: before?.timestamp,
    beforeId: before?.id,
  })
}

export async function markDmRead(conversationId: string): Promise<void> {
  if (isMatrixBackend()) return tauriInvoke('matrix_mark_dm_read', { conversationId })
  return tauriInvoke('mark_dm_read', { conversationId })
}

export async function matrixSetDmBlocked(recipientUserId: string, blocked: boolean): Promise<boolean> {
  return tauriInvoke('matrix_set_dm_blocked', { recipientUserId, blocked })
}

export async function matrixDmBlocked(recipientUserId: string): Promise<boolean> {
  return tauriInvoke('matrix_dm_blocked', { recipientUserId })
}

export async function matrixSendDmAttachment(
  recipientUserId: string,
  attachmentGrant: string,
  transferId: string,
  body: string,
  replyToId?: string,
): Promise<DirectMessage> {
  return tauriInvoke('matrix_send_dm_attachment', {
    recipientUserId,
    attachmentGrant,
    transferId,
    body,
    replyToId,
  })
}

export function onDmReceived(handler: (data: DirectMessage) => void): Promise<UnlistenFn> {
  return tauriListen('dm:received', handler)
}

// ─── File Commands ──────────────────────────────────

export async function uploadFile(channelId: string, filePath: string): Promise<string> {
  return tauriInvoke('upload_file', { channelId, filePath })
}

export async function uploadDmFile(conversationId: string, filePath: string): Promise<string> {
  return tauriInvoke('upload_dm_file', { conversationId, filePath })
}

export async function requestFile(request: FileDownloadRequest): Promise<void> {
  return tauriInvoke('request_file', { ...request })
}

// ─── Moderation Commands ────────────────────────────

export async function banUser(communityId: string, bannedPublicKey: string): Promise<void> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_ban_member', { communityId, userId: bannedPublicKey })
  }
  return tauriInvoke('ban_user', { communityId, bannedPublicKey })
}

export async function kickUser(communityId: string, targetPublicKey: string, reason?: string): Promise<void> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_kick_member', { communityId, userId: targetPublicKey, reason })
  }
  return tauriInvoke('kick_user', { communityId, targetPublicKey, reason })
}

export async function timeoutUser(communityId: string, targetPublicKey: string, durationMinutes: number, reason?: string): Promise<void> {
  if (isMatrixBackend()) {
    throw new Error('Temporary Matrix moderation requires a durable policy/role restoration service')
  }
  return tauriInvoke('timeout_user', { communityId, targetPublicKey, durationMinutes, reason })
}

export async function updateMemberRole(communityId: string, publicKey: string, role: string): Promise<void> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_update_member_role', { communityId, userId: publicKey, role })
  }
  return tauriInvoke('update_member_role', { communityId, publicKey, role })
}

export async function getMembers(
  communityId: string,
): Promise<{
  publicKey: string
  displayName: string
  avatarColor: string
  role: string
  joinStatus: string
  banStatus: string
  lastSeen: string | null
  online?: boolean
}[]> {
  if (!isTauri()) {
    return []
  }
  return isMatrixBackend()
    ? tauriInvoke('matrix_list_members', { communityId })
    : tauriInvoke('get_members', { communityId })
}

export async function requestControlLogSync(communityId: string): Promise<void> {
  return tauriInvoke('request_control_log_sync', { communityId })
}

// ─── Control Events ───────────────────────────────────────

export interface ControlEventData {
  communityId: string
  eventType: string
  payload: Record<string, unknown>
  applied: boolean
}

export function onControlEvent(handler: (data: ControlEventData) => void): Promise<UnlistenFn> {
  return tauriListen('control:event', handler)
}

// ─── Presence Events ────────────────────────────────

export function onPresenceUpdate(handler: (data: { author: string; communityId: string; status: string }) => void): Promise<UnlistenFn> {
  return tauriListen('presence:update', handler)
}

// ─── File Events ────────────────────────────────────

export function onFileDownloadProgress(handler: (data: FileDownloadProgress) => void): Promise<UnlistenFn> {
  return tauriListen('file:download-progress', handler)
}

export function onFileAvailable(handler: (data: FileAvailable) => void): Promise<UnlistenFn> {
  return tauriListen('file:available', handler)
}

export async function openDownloadedFile(localPath: string): Promise<void> {
  if (!isTauri()) {
    return
  }

  await tauriInvoke('open_downloaded_file', { localPath })
}

// ─── Discovery Commands ────────────────────────────
