/**
 * Typed wrappers around Tauri's invoke() and listen() APIs.
 * This is the ONLY place the frontend talks to the Rust backend.
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { showToast } from '../components/ui/Toast'
import { AppError, describeError, normalizeError, errorLine } from './errors'
import type { SearchFilters } from './search-query'
import {
  isMeshJoinLink,
  parseCommunityInvite,
  parseAdmissionCommunityInvite,
  parseMatrixCommunityInvite,
} from './community-invites'
import { canStartLegacyVoice } from './voice-runtime'
import type {
  Identity,
  Community,
  BackendCapabilities,
  BackendKind,
  BackendStartupStatus,
  BackendStatus,
  CommunityAccessSettings,
  CommunityJoinRule,
  CommunityDirectoryEntry,
  DirectoryPeopleResult,
  CommunityApplication,
  CommunityAccessResult,
  CommunityModerationResult,
  CommunityPermissionProjection,
  CustomEmoji,
  ModerationAuditEntry,
  MatrixUserPreferences,
  MatrixNotification,
  MatrixNotificationActivation,
  MatrixIgnoredUsersChanged,
  MatrixPermissionStateChanged,
  MatrixPersonalDataExport,
  PendingInvitationMetadata,
  MatrixQueuedMessageUpdate,
  MatrixTypingChanged,
  MatrixUnreadUpdate,
  MatrixRoomNotificationMode,
  MatrixRoomUpgrade,
  MatrixRoomPins,
  MatrixRoomPinsUpdate,
  MatrixRoomUpdateKind,
  MatrixCrossCommunitySearchResultDto,
  MatrixThreadContextDto,
  MatrixThreadListDto,
  ComposerDraftDto,
  MatrixRecoveryHealth,
  MatrixRecoverySetupResult,
  NotificationPresentationContext,
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
  BlockedAccountDto,
  BlockedAccountPageDto,
  DmConversation,
  CommunityInviteDto,
  DmRequestDto,
  DirectMessage,
  VoiceServiceStatus,
} from '../types/ipc'

export interface BlockedEntityDiagnostic {
  entityId: string
  entityKind: 'community' | 'channel' | 'direct-message' | 'upgrade'
  reason: 'unencrypted' | 'inaccessible' | 'unsupported'
}

export interface EntityListResult<T> {
  entities: T[]
  blockedEntities: BlockedEntityDiagnostic[]
}

export interface NotificationAccountScope {
  accountGeneration: number
  userId: string
}

function reportBlockedEntities(operation: string, blocked: BlockedEntityDiagnostic[]) {
  if (blocked.length > 0) {
    console.warn(`${operation} quarantined ${blocked.length} protected-room entit${blocked.length === 1 ? 'y' : 'ies'}`, blocked)
  }
}

export type { MatrixRecoveryHealth, MatrixRecoverySetupResult }

const tauriUnavailable = () =>
  normalizeError('Tauri runtime unavailable. Use `npm run tauri dev` for real IPC.')

export interface TauriInvokeOptions {
  /** Show Mesh's user-facing error toast when the request fails. */
  toast?: boolean
  /**
   * Mark this request as a read-only operation. Read requests may be retried
   * and coalesced; writes are deliberately never retried by this helper.
   */
  idempotent?: boolean
  /**
   * Maximum wall-clock time to wait for one attempt. Reads spend this budget
   * per attempt and may retry; a write spends it once and is never retried.
   * `null` opts a write out of the cap entirely and is reserved for commands
   * that legitimately block: native pickers, native confirmations, browser
   * sign-in and unbounded file transfers, all of which carry their own
   * cancellation affordance. Reads treat `null` as the default read budget
   * because their retry loop needs a deadline to act on.
   */
  timeoutMs?: number | null
  /** Maximum number of attempts for an idempotent request, including the first. */
  maxAttempts?: number
  /** Base delay for jittered retry backoff. */
  retryBaseDelayMs?: number
  /** Upper bound for one retry delay. */
  retryMaxDelayMs?: number
}

const READ_REQUEST_TIMEOUT_MS = 15_000
const READ_MAX_ATTEMPTS = 3
const READ_RETRY_BASE_DELAY_MS = 150
const READ_RETRY_MAX_DELAY_MS = 2_000
// Writes are not idempotent, so this cap only stops the renderer from waiting
// forever: it never retries and never cancels the native work. It is set well
// above every native deadline an ordinary mutation can hit so a slow but
// healthy homeserver still lands instead of reporting a false failure.
const WRITE_REQUEST_TIMEOUT_MS = 60_000
// Account, session and federated-join mutations stack several native
// deadlines (login and registration are 45s per stage; a pending-invitation
// join is 90s), so they get a longer cap rather than an unbounded wait.
const SLOW_WRITE_REQUEST_TIMEOUT_MS = 180_000
// This protects the ordinary renderer from accidentally constructing an
// oversized command. It is defense-in-depth only: Tauri/Wry must provide the
// separate pre-allocation limit for a compromised renderer.
const MAX_RENDERER_IPC_ARGUMENT_BYTES = 1024 * 1024
const inflightReadRequests = new Map<string, Promise<unknown>>()
const activeNativeReadRequestIds = new Set<string>()
const blockedNativeReadCompletions = new Map<string, Promise<void>>()
const TYPED_TRANSIENT_CODES = new Set([
  'network_unavailable',
  'rate_limited',
  'registration_timed_out',
  'login_timed_out',
])
const READ_IPC_OPTIONS: TauriInvokeOptions = { idempotent: true }
/** A write that stacks several native deadlines. See SLOW_WRITE_REQUEST_TIMEOUT_MS. */
const SLOW_WRITE_IPC_OPTIONS: TauriInvokeOptions = {
  timeoutMs: SLOW_WRITE_REQUEST_TIMEOUT_MS,
}
/**
 * A write that is paced by a person or by an unbounded transfer: a native
 * confirmation, a native file picker, browser sign-in, or an attachment
 * upload/download. Each one already exposes a cancel path, so a renderer
 * deadline here would only invent failures.
 */
const BLOCKING_WRITE_IPC_OPTIONS: TauriInvokeOptions = { timeoutMs: null }
// Only commands that enter Rust's NativeRequestRegistry may receive its
// requestId/deadline contract. Other reads still coalesce and retry after a
// settled transient failure, but they must never claim a timeout was cancelled
// while unregistered native work is still running.
const NATIVE_GUARDED_READ_COMMANDS = new Set([
  'get_backend_status',
  'check_username_available',
  'matrix_accounts',
  'matrix_community_access_settings',
  'matrix_device_verification_status',
  'matrix_devices',
  'matrix_blocked_accounts',
  'matrix_dm_blocked',
  'matrix_dm_conversations',
  'matrix_community_invites',
  'matrix_dm_requests',
  'matrix_dm_messages',
  'matrix_get_community_permission_projection',
  'matrix_get_messages',
  'matrix_thread_context',
  'matrix_thread_list',
  'matrix_get_profile',
  'matrix_get_room_notification_mode',
  'matrix_list_channels',
  'matrix_list_communities',
  'matrix_list_community_applications',
  'matrix_list_members',
  'matrix_list_moderation_audit',
  'matrix_load_attachment_image',
  'matrix_load_composer_draft',
  'matrix_load_custom_emoji_image',
  'matrix_load_profile_avatar',
  'matrix_oidc_status',
  'matrix_queued_messages',
  'matrix_recovery_health',
  'matrix_rtc_members',
  'matrix_room_is_encrypted',
  'matrix_room_pins',
  'matrix_room_upgrade',
  'matrix_service_capabilities',
  'matrix_typing_users',
  'matrix_user_preferences',
  'matrix_wait_for_room_update',
])
const LIGHTBOX_IMAGE_IPC_OPTIONS: TauriInvokeOptions = {
  idempotent: true,
  timeoutMs: 60_000,
  maxAttempts: 1,
}
const MAX_LIGHTBOX_IMAGE_BYTES = 100 * 1024 * 1024
const CUSTOM_EMOJI_IMAGE_IPC_OPTIONS: TauriInvokeOptions = {
  idempotent: true,
  timeoutMs: 45_000,
  maxAttempts: 1,
}
const MAX_CUSTOM_EMOJI_BYTES = 512 * 1024
const NATIVE_SEARCH_DEADLINE_MS = 10_000
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const

export interface ProtectedImage {
  bytes: Uint8Array
  contentType: 'image/jpeg' | 'image/png' | 'image/webp'
}

function protectedImageContentType(bytes: Uint8Array): ProtectedImage['contentType'] | null {
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

function stableRequestKey(command: string, args?: Record<string, unknown>): string {
  if (!args) return command

  const serialize = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
    if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }

  try {
    return `${command}:${serialize(args)}`
  } catch {
    // An unserializable argument simply disables coalescing for this call.
    return `${command}:${Math.random()}`
  }
}

function validateRendererIpcArguments(args?: Record<string, unknown>): void {
  if (!args) return

  let serialized: string
  try {
    serialized = JSON.stringify(args)
  } catch {
    throw new AppError(
      'serialization_error',
      'Mesh could not prepare this request. Check the entered information and try again.',
      false,
    )
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_RENDERER_IPC_ARGUMENT_BYTES) {
    throw new AppError(
      'invalid_input',
      'Mesh blocked an unusually large app request. Choose a smaller input or file and try again.',
      false,
    )
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function ipcTimeoutDetail(command: string): string {
  return `IPC request "${command}" timed out`
}

/**
 * The renderer gave up waiting. It is never retryable: the native side may
 * still be running, and only a guarded read can ask Rust to cancel it.
 */
function ipcTimeoutError(command: string): AppError {
  return new AppError('network_unavailable', ipcTimeoutDetail(command), false)
}

class NativeReadTimeout extends AppError {
  readonly requestId: string
  readonly completion: Promise<void>

  constructor(command: string, requestId: string, completion: Promise<void>) {
    super('network_unavailable', ipcTimeoutDetail(command), false)
    this.name = 'NativeReadTimeout'
    this.requestId = requestId
    this.completion = completion
  }
}

function isTypedTransientFailure(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object' || cause instanceof Error) return false
  const payload = cause as { code?: unknown; retryable?: unknown }
  return (
    payload.retryable === true
    && typeof payload.code === 'string'
    && TYPED_TRANSIENT_CODES.has(payload.code)
  )
}

async function cancelNativeReadAndAwaitCompletion(requestId: string): Promise<boolean> {
  try {
    const status = await invoke<string>('cancel_native_request', { requestId })
    return status === 'completed'
  } catch {
    return false
  }
}

async function cancelAllActiveNativeReads(): Promise<void> {
  await Promise.allSettled(
    [...activeNativeReadRequestIds].map(cancelNativeReadAndAwaitCompletion),
  )
}

async function invokeWithTimeout<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<T> {
  const requestId = createMatrixTransactionId()
  // Rust owns the primary deadline. The renderer timer is a short fail-safe
  // used only if native execution or IPC delivery becomes unresponsive.
  const deadlineHeadroomMs = Math.min(1_000, Math.max(1, Math.floor(timeoutMs / 10)))
  const deadlineMs = Math.max(1, timeoutMs - deadlineHeadroomMs)
  let invocation: Promise<T>
  try {
    activeNativeReadRequestIds.add(requestId)
    invocation = Promise.resolve(invoke<T>(command, {
      ...(args ?? {}),
      requestId,
      deadlineMs,
    }))
  } catch (cause) {
    activeNativeReadRequestIds.delete(requestId)
    throw cause
  }

  void invocation
    .finally(() => activeNativeReadRequestIds.delete(requestId))
    .catch(() => {
      // The returned invocation carries the rejection to the caller.
    })
  const completion = invocation.then(
    () => undefined,
    () => undefined,
  )

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new NativeReadTimeout(command, requestId, completion))
    }, timeoutMs)

    invocation.then(
      (value) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        reject(cause)
      },
    )
  })
}

/**
 * A write is never retried and never cancelled from here, so this is only a
 * wall-clock cap: it stops an optimistic bubble from spinning "pending"
 * forever when native execution or IPC delivery stalls. The native work may
 * still land, which is exactly why the failure is reported as not retryable.
 */
async function invokeWrite<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  options: TauriInvokeOptions,
): Promise<T> {
  const invocation = Promise.resolve(invoke<T>(command, args))
  if (options.timeoutMs === null) return invocation
  const timeoutMs = Math.max(1, options.timeoutMs ?? WRITE_REQUEST_TIMEOUT_MS)

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(ipcTimeoutError(command))
    }, timeoutMs)

    invocation.then(
      (value) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        reject(cause)
      },
    )
  })
}

interface ResolvedReadPolicy {
  timeoutMs: number
  maxAttempts: number
  retryBaseDelayMs: number
  retryMaxDelayMs: number
}

function resolveReadPolicy(options: TauriInvokeOptions): ResolvedReadPolicy {
  const timeoutMs = Math.max(1, options.timeoutMs ?? READ_REQUEST_TIMEOUT_MS)
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? READ_MAX_ATTEMPTS))
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? READ_RETRY_BASE_DELAY_MS)
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    options.retryMaxDelayMs ?? READ_RETRY_MAX_DELAY_MS,
  )
  return { timeoutMs, maxAttempts, retryBaseDelayMs, retryMaxDelayMs }
}

/**
 * Two callers may only share one in-flight read when they asked for the same
 * deadline and the same attempt policy. Without this, a 60s single-attempt
 * lightbox read and an ordinary 15s three-attempt read of the same command and
 * arguments would silently inherit whichever fired first.
 */
function readPolicySignature(policy: ResolvedReadPolicy): string {
  return [
    policy.timeoutMs,
    policy.maxAttempts,
    policy.retryBaseDelayMs,
    policy.retryMaxDelayMs,
  ].join('/')
}

async function invokeRead<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  policy: ResolvedReadPolicy,
  requestKey: string,
): Promise<T> {
  const { timeoutMs, maxAttempts, retryBaseDelayMs, retryMaxDelayMs } = policy

  // If a previous renderer timeout could not be acknowledged by Rust, keep
  // this exact read key blocked until the original native invocation settles.
  // This preserves coalescing across timeout cleanup instead of multiplying
  // unknown work on a later user refresh.
  const blockedCompletion = blockedNativeReadCompletions.get(requestKey)
  if (blockedCompletion) await blockedCompletion

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return NATIVE_GUARDED_READ_COMMANDS.has(command)
        ? await invokeWithTimeout<T>(command, args, timeoutMs)
        : await Promise.resolve(invoke<T>(command, args))
    } catch (cause) {
      if (cause instanceof NativeReadTimeout) {
        // Cancellation returns only after Rust has dropped the guarded future
        // and released its account/operation permits. A missing acknowledgement
        // is treated as unknown active work and is never retried.
        const confirmed = await cancelNativeReadAndAwaitCompletion(cause.requestId)
        if (!confirmed) {
          const blocker = cause.completion.finally(() => {
            if (blockedNativeReadCompletions.get(requestKey) === blocker) {
              blockedNativeReadCompletions.delete(requestKey)
            }
          })
          blockedNativeReadCompletions.set(requestKey, blocker)
        }
        throw cause
      }
      const error = normalizeError(cause)
      const shouldRetry = attempt + 1 < maxAttempts && isTypedTransientFailure(cause)
      if (!shouldRetry) throw error

      const exponentialDelay = Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** attempt)
      const jitteredDelay = Math.round(exponentialDelay * (0.5 + Math.random()))
      await delay(jitteredDelay)
    }
  }

  // The loop always returns or throws; keep TypeScript's control-flow analysis explicit.
  throw normalizeError(`IPC request \"${command}\" failed`)
}

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
  options: TauriInvokeOptions = {},
): Promise<T> {
  if (!isTauri()) {
    throw tauriUnavailable()
  }
  validateRendererIpcArguments(args)

  let request: Promise<T>
  if (options.idempotent) {
    // The native-work key stays policy independent: a stalled invocation
    // blocks every later read of the same command and arguments, whatever
    // deadline that later caller asked for.
    const requestKey = stableRequestKey(command, args)
    const policy = resolveReadPolicy(options)
    const coalesceKey = `${requestKey}#${readPolicySignature(policy)}`
    const existing = inflightReadRequests.get(coalesceKey)
    if (existing) return existing as Promise<T>

    request = invokeRead<T>(command, args, policy, requestKey)
    inflightReadRequests.set(coalesceKey, request)
    void request
      .finally(() => {
        if (inflightReadRequests.get(coalesceKey) === request) {
          inflightReadRequests.delete(coalesceKey)
        }
      })
      .catch(() => {
        // The original request carries the rejection to its caller.
      })
  } else {
    request = invokeWrite<T>(command, args, options)
  }
  try {
    return await request
  } catch (cause) {
    const error = normalizeError(cause)
    if (options?.toast) {
      const description = describeError(error)
      showToast(errorLine(description), 'error')
    }
    throw error
  }
}

/**
 * The LAN-only command boundary. The compile-time constant keeps these calls
 * unreachable from a Matrix renderer even if a caller accidentally selects a
 * legacy provider at runtime; the Tauri capability is the independent native
 * enforcement layer.
 */
async function legacyTauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
  options: TauriInvokeOptions = {},
): Promise<T> {
  if (!__MESH_LEGACY_FRONTEND__) {
    throw normalizeError('This operation is available only in the explicit Mesh LAN build.')
  }
  return tauriInvoke<T>(command, args, options)
}

interface ActiveNativeSearch {
  requestId: string
}

const activeNativeSearches = new Map<string, ActiveNativeSearch>()

async function cancelActiveNativeSearch(scope: string): Promise<void> {
  const active = activeNativeSearches.get(scope)
  if (!active) return
  await Promise.resolve(invoke('matrix_cancel_search', { requestId: active.requestId }))
  if (activeNativeSearches.get(scope)?.requestId === active.requestId) {
    activeNativeSearches.delete(scope)
  }
}

async function cancelAllActiveNativeSearches(): Promise<void> {
  await Promise.allSettled([...activeNativeSearches.keys()].map(cancelActiveNativeSearch))
}

async function invokeNativeSearch<T>(
  scope: string,
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) throw tauriUnavailable()
  await cancelActiveNativeSearch(scope)
  const requestId = createMatrixTransactionId()
  const active = { requestId }
  activeNativeSearches.set(scope, active)
  const invocation = Promise.resolve(invoke<T>(command, {
    ...args,
    requestId,
    deadlineMs: NATIVE_SEARCH_DEADLINE_MS,
  }))
  let timeoutHandle: number | undefined
  const timeout = new Promise<T>((_, reject) => {
    timeoutHandle = window.setTimeout(() => {
      reject(normalizeError(`IPC request "${command}" exceeded its native deadline`))
      void Promise.resolve(invoke('matrix_cancel_search', { requestId })).catch(() => undefined)
    }, NATIVE_SEARCH_DEADLINE_MS + 2_000)
  })
  try {
    return await Promise.race([invocation, timeout])
  } catch (cause) {
    throw normalizeError(cause)
  } finally {
    if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle)
    if (activeNativeSearches.get(scope) === active) activeNativeSearches.delete(scope)
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
  BackendStartupStatus,
  BackendStatus,
  MatrixPersonalDataExport,
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
  mediaE2eeReady: false,
  reason: 'Voice calling is not available in preview mode',
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

export interface MatrixRegistrationRequest {
  homeserver: string
  username: string
  password: string
  pendingInvitationHandle?: string
  deviceName?: string
}

export interface MatrixOidcStatus {
  homeserver: string
  availability: 'supported' | 'not-supported' | 'invalid-configuration'
  issuer: string | null
  authorizationEndpoint: string | null
  clientIdConfigured: boolean
  redirectUri: string
  authorizationCodePkce: boolean
  nativeCallbackReady: boolean
  ready: boolean
  reason: string
}

export interface MatrixServiceCapabilities {
  homeserver: string
  serverVersions: string[]
  passwordLogin: boolean
  browserLogin: boolean
  registration: 'open' | 'closed' | 'invitation-only' | 'unknown'
  maxUploadBytes: number | null
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
      supportsE2ee: true,
      sessionE2eeReady: true,
      warnings: ['Tauri runtime unavailable'],
    }
    return cacheBackendStatus(status)
  }
  const status = await tauriInvoke<BackendStatus>('get_backend_status', undefined, READ_IPC_OPTIONS)
  return cacheBackendStatus(status)
}

export async function ensureBackendStarted(retry = false): Promise<BackendStartupStatus> {
  if (!isTauri()) {
    return { phase: 'ready', issue: null }
  }
  return tauriInvoke<BackendStartupStatus>(
    'ensure_backend_started',
    { retry },
    SLOW_WRITE_IPC_OPTIONS,
  )
}

export async function peekPendingInvitation(): Promise<PendingInvitationMetadata | null> {
  return tauriInvoke<PendingInvitationMetadata | null>(
    'peek_pending_invitation',
    undefined,
    READ_IPC_OPTIONS,
  )
}

export async function joinPendingInvitation(handle: string): Promise<Community> {
  return tauriInvoke<Community>(
    'join_pending_invitation',
    { handle },
    SLOW_WRITE_IPC_OPTIONS,
  )
}

export async function clearPendingInvitation(handle: string): Promise<void> {
  return tauriInvoke('clear_pending_invitation', { handle })
}

let activeLoginAttemptId: string | null = null

export async function matrixLogin(request: MatrixLoginRequest): Promise<BackendStatus> {
  const attemptId = await tauriInvoke<string>('matrix_reserve_login_attempt')
  activeLoginAttemptId = attemptId
  try {
    const status = await tauriInvoke<BackendStatus>(
      'matrix_login',
      { request, attemptId },
      SLOW_WRITE_IPC_OPTIONS,
    )
    return cacheBackendStatus(status)
  } finally {
    if (activeLoginAttemptId === attemptId) activeLoginAttemptId = null
  }
}

export async function matrixRegisterAccount(
  request: MatrixRegistrationRequest,
): Promise<BackendStatus> {
  const status = await tauriInvoke<BackendStatus>(
    'register_account',
    { request },
    SLOW_WRITE_IPC_OPTIONS,
  )
  return cacheBackendStatus(status)
}

export async function matrixCheckUsernameAvailable(
  homeserver: string,
  username: string,
): Promise<boolean> {
  return tauriInvoke<boolean>(
    'check_username_available',
    { homeserver, username },
    READ_IPC_OPTIONS,
  )
}

export const registerAccount = matrixRegisterAccount
export const checkUsernameAvailable = matrixCheckUsernameAvailable

export async function matrixServiceCapabilities(
  homeserver: string,
): Promise<MatrixServiceCapabilities> {
  return tauriInvoke<MatrixServiceCapabilities>(
    'matrix_service_capabilities',
    { homeserver },
    READ_IPC_OPTIONS,
  )
}

export async function matrixOidcStatus(homeserver: string): Promise<MatrixOidcStatus> {
  return tauriInvoke<MatrixOidcStatus>('matrix_oidc_status', { homeserver }, READ_IPC_OPTIONS)
}

export async function matrixStartOidcLogin(homeserver: string): Promise<BackendStatus> {
  const attemptId = await tauriInvoke<string>('matrix_reserve_login_attempt')
  activeLoginAttemptId = attemptId
  try {
    await tauriInvoke(
      'matrix_start_oidc_login',
      { homeserver, attemptId },
      BLOCKING_WRITE_IPC_OPTIONS,
    )
    return getBackendStatus()
  } finally {
    if (activeLoginAttemptId === attemptId) activeLoginAttemptId = null
  }
}

export async function matrixCancelLogin(): Promise<void> {
  const attemptId = activeLoginAttemptId
  if (!attemptId) return
  return tauriInvoke('matrix_cancel_login', { attemptId })
}

export async function matrixRestoreSession(): Promise<BackendStatus> {
  const status = await tauriInvoke<BackendStatus>(
    'matrix_restore_session',
    undefined,
    SLOW_WRITE_IPC_OPTIONS,
  )
  return cacheBackendStatus(status)
}

export async function matrixLogout(): Promise<void> {
  await Promise.all([cancelAllActiveNativeReads(), cancelAllActiveNativeSearches()])
  await tauriInvoke('matrix_logout', undefined, SLOW_WRITE_IPC_OPTIONS)
  cachedBackendKind = 'matrix'
  cachedBackendStatus = null
}

export async function matrixDevices(): Promise<MatrixDevice[]> {
  return tauriInvoke('matrix_devices', undefined, READ_IPC_OPTIONS)
}

export const MATRIX_TRUST_CHANGED_EVENT = 'mesh:matrix-trust-changed'

function emitMatrixTrustChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(MATRIX_TRUST_CHANGED_EVENT))
  }
}

export function onMatrixTrustChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(MATRIX_TRUST_CHANGED_EVENT, listener)
  return () => window.removeEventListener(MATRIX_TRUST_CHANGED_EVENT, listener)
}

type DestructiveAction = 'removeLocalAccount' | 'revokeDevice' | 'deactivateAccount'

async function requestDestructiveActionGrant(
  action: DestructiveAction,
  targetId?: string,
): Promise<string | null> {
  return tauriInvoke(
    'request_destructive_action_grant',
    { action, targetId: targetId ?? null },
    BLOCKING_WRITE_IPC_OPTIONS,
  )
}

export async function matrixRevokeDevice(deviceId: string, password: string): Promise<boolean> {
  const presenceGrant = await requestDestructiveActionGrant('revokeDevice', deviceId)
  if (!presenceGrant) return false
  await tauriInvoke(
    'matrix_revoke_device',
    { deviceId, password, presenceGrant },
    SLOW_WRITE_IPC_OPTIONS,
  )
  emitMatrixTrustChanged()
  return true
}

export async function matrixRemoveLocalAccount(): Promise<boolean> {
  const presenceGrant = await requestDestructiveActionGrant('removeLocalAccount')
  if (!presenceGrant) return false
  await Promise.all([cancelAllActiveNativeReads(), cancelAllActiveNativeSearches()])
  await tauriInvoke(
    'matrix_remove_local_account',
    { presenceGrant },
    SLOW_WRITE_IPC_OPTIONS,
  )
  cachedBackendKind = 'matrix'
  cachedBackendStatus = null
  return true
}

export async function matrixExportPersonalData(): Promise<MatrixPersonalDataExport | null> {
  return tauriInvoke('matrix_export_personal_data', undefined, BLOCKING_WRITE_IPC_OPTIONS)
}

export async function matrixCancelPersonalDataExport(): Promise<void> {
  return tauriInvoke('matrix_cancel_personal_data_export')
}

export async function matrixDeactivateAccount(password: string): Promise<boolean> {
  const presenceGrant = await requestDestructiveActionGrant('deactivateAccount')
  if (!presenceGrant) return false
  await tauriInvoke(
    'matrix_deactivate_account',
    { password, presenceGrant },
    SLOW_WRITE_IPC_OPTIONS,
  )
  cachedBackendKind = 'matrix'
  cachedBackendStatus = null
  return true
}

export async function matrixAccounts(): Promise<MatrixAccount[]> {
  return tauriInvoke('matrix_accounts', undefined, READ_IPC_OPTIONS)
}

export async function matrixGetProfile(): Promise<MatrixProfile> {
  return tauriInvoke('matrix_get_profile', undefined, READ_IPC_OPTIONS)
}

/**
 * Sets your profile picture.
 *
 * Rust decodes, bounds and re-encodes the image to PNG before uploading: an
 * avatar is fetched by everyone who can see you, so an unsanitised one would be
 * a broadcast primitive.
 */
export async function matrixUpdateProfileAvatar(
  filename: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<MatrixProfile> {
  return tauriInvoke(
    'matrix_update_profile_avatar',
    { filename, contentType, bytes: Array.from(bytes) },
    BLOCKING_WRITE_IPC_OPTIONS,
  )
}

export async function matrixClearProfileAvatar(): Promise<MatrixProfile> {
  return tauriInvoke('matrix_clear_profile_avatar')
}

/**
 * Sets a community's icon, returning the mxc address the community now carries.
 *
 * Sanitised exactly like a profile picture, and gated by power levels rather
 * than by the caller: Rust reads `m.room.avatar`'s threshold and refuses a
 * write the room does not permit, so hiding the control for a member is
 * presentation, not the check. Separately, the command is bound to the current
 * account for its duration, so an upload cannot outlive an account switch.
 *
 * `roomId` rather than `communityId` because the command is room-generic: a
 * Matrix space is a room, so the same writer will serve a per-room icon when a
 * surface exists to offer one.
 */
export async function matrixSetCommunityIcon(
  roomId: string,
  filename: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<string> {
  return tauriInvoke(
    'matrix_set_room_avatar',
    { roomId, filename, contentType, bytes: Array.from(bytes) },
    BLOCKING_WRITE_IPC_OPTIONS,
  )
}

export async function matrixClearCommunityIcon(roomId: string): Promise<void> {
  return tauriInvoke('matrix_clear_room_avatar', { roomId })
}

/**
 * Fetches avatar bytes for an mxc address.
 *
 * The renderer cannot fetch mxc itself: the content security policy permits no
 * outbound connection and the media endpoint needs the access token, so the
 * bytes come back over IPC the same way server emoji and attachment previews do.
 */
export async function matrixLoadProfileAvatar(avatarUrl: string): Promise<Uint8Array> {
  const bytes = await tauriInvoke<number[]>(
    'matrix_load_profile_avatar',
    { avatarUrl },
    READ_IPC_OPTIONS,
  )
  return new Uint8Array(bytes)
}

export async function matrixUpdateProfileDisplayName(displayName: string): Promise<MatrixProfile> {
  return tauriInvoke('matrix_update_profile_display_name', { displayName })
}

export async function matrixSwitchAccount(profileId: string): Promise<BackendStatus> {
  await Promise.all([cancelAllActiveNativeReads(), cancelAllActiveNativeSearches()])
  const status = await tauriInvoke<BackendStatus>(
    'matrix_switch_account',
    { profileId },
    SLOW_WRITE_IPC_OPTIONS,
  )
  return cacheBackendStatus(status)
}

export async function matrixRecoveryHealth(): Promise<MatrixRecoveryHealth> {
  return tauriInvoke('matrix_recovery_health', undefined, READ_IPC_OPTIONS)
}

export async function matrixTestRecovery(
  recoveryKeyOrPassphrase: string,
): Promise<MatrixRecoveryHealth> {
  const health = await tauriInvoke<MatrixRecoveryHealth>(
    'matrix_test_recovery',
    { recoveryKeyOrPassphrase },
    SLOW_WRITE_IPC_OPTIONS,
  )
  emitMatrixTrustChanged()
  return health
}

export async function matrixTestStoredRecovery(): Promise<MatrixRecoveryHealth> {
  const health = await tauriInvoke<MatrixRecoveryHealth>(
    'matrix_test_stored_recovery',
    undefined,
    SLOW_WRITE_IPC_OPTIONS,
  )
  emitMatrixTrustChanged()
  return health
}

export async function matrixStartDeviceVerification(
  deviceId: string,
): Promise<MatrixVerificationSession> {
  return tauriInvoke('matrix_start_device_verification', { deviceId })
}

export async function matrixDeviceVerificationStatus(
  verificationId: string,
): Promise<MatrixVerificationSession> {
  const session = await tauriInvoke<MatrixVerificationSession>(
    'matrix_device_verification_status',
    { verificationId },
    READ_IPC_OPTIONS,
  )
  if (session.phase === 'done') emitMatrixTrustChanged()
  return session
}

export async function matrixSelectDeviceVerificationMethod(
  verificationId: string,
  method: 'sas' | 'qr',
): Promise<MatrixVerificationSession> {
  return tauriInvoke('matrix_select_device_verification_method', {
    verificationId,
    method,
  })
}

export async function matrixConfirmDeviceVerification(
  verificationId: string,
  matches: boolean,
): Promise<MatrixVerificationSession> {
  const session = await tauriInvoke<MatrixVerificationSession>(
    'matrix_confirm_device_verification',
    { verificationId, matches },
  )
  emitMatrixTrustChanged()
  return session
}

export async function matrixCancelDeviceVerification(verificationId: string): Promise<void> {
  return tauriInvoke('matrix_cancel_device_verification', { verificationId })
}

export async function getMatrixUserPreferences(): Promise<MatrixUserPreferences | null> {
  return tauriInvoke('matrix_user_preferences', undefined, READ_IPC_OPTIONS)
}

export async function updateMatrixUserPreferences(
  preferences: Omit<MatrixUserPreferences, 'updatedAt'>,
): Promise<MatrixUserPreferences> {
  return tauriInvoke('matrix_update_user_preferences', {
    preferences: { ...preferences, updatedAt: new Date(0).toISOString() },
  })
}

export async function getNotificationAccountScope(
  expectedUserId: string,
): Promise<NotificationAccountScope> {
  return tauriInvoke('get_notification_account_scope', { expectedUserId })
}

export async function setNotificationContext(
  scope: NotificationAccountScope,
  context: NotificationPresentationContext,
): Promise<void> {
  return tauriInvoke('set_notification_context', { scope, context })
}

export async function sendTestNotification(): Promise<void> {
  return tauriInvoke('send_test_notification')
}

export type NotificationPermission = 'granted' | 'denied' | 'not-requested'

/**
 * What the operating system will do with a notification, as opposed to what
 * Mesh's own switch says. Read-only: it never prompts.
 */
export async function notificationPermissionState(): Promise<NotificationPermission> {
  return tauriInvoke('notification_permission_state', undefined, READ_IPC_OPTIONS)
}

export async function matrixRoomIsEncrypted(roomId: string): Promise<boolean> {
  return tauriInvoke('matrix_room_is_encrypted', { roomId }, READ_IPC_OPTIONS)
}

export async function matrixRoomUpgrade(roomId: string): Promise<MatrixRoomUpgrade | null> {
  return tauriInvoke('matrix_room_upgrade', { roomId }, READ_IPC_OPTIONS)
}

export async function getMatrixRoomNotificationMode(
  roomId: string,
): Promise<MatrixRoomNotificationMode> {
  return tauriInvoke('matrix_get_room_notification_mode', { roomId }, READ_IPC_OPTIONS)
}

export async function setMatrixRoomNotificationMode(
  roomId: string,
  mode: MatrixRoomNotificationMode,
): Promise<void> {
  return tauriInvoke('matrix_set_room_notification_mode', { roomId, mode })
}

export async function matrixCreateCommunity(name: string, description: string): Promise<Community> {
  const created = await tauriInvoke<{ community: Community; channel: Channel }>(
    'matrix_create_community',
    { name, description },
  )
  matrixCreatedChannels.set(created.community.id, [created.channel])
  return created.community
}

async function matrixListCommunities(): Promise<EntityListResult<Community>> {
  return tauriInvoke('matrix_list_communities', undefined, READ_IPC_OPTIONS)
}

export async function matrixListChannels(communityId: string): Promise<EntityListResult<Channel>> {
  const result = await tauriInvoke<EntityListResult<Channel>>(
    'matrix_list_channels',
    { communityId },
    READ_IPC_OPTIONS,
  )
  const merged = new Map<string, Channel>()
  for (const channel of result.entities) {
    merged.set(channel.id, channel)
  }
  const unresolvedCreated: Channel[] = []
  for (const created of matrixCreatedChannels.get(communityId) ?? []) {
    const synced = merged.get(created.id)
    if (!synced) {
      merged.set(created.id, created)
      unresolvedCreated.push(created)
      continue
    }
    if (synced.name.trim().toLocaleLowerCase() === 'unnamed') {
      merged.set(created.id, {
        ...synced,
        name: created.name,
        channelType: created.channelType,
      })
      unresolvedCreated.push(created)
    }
  }
  if (unresolvedCreated.length > 0) {
    matrixCreatedChannels.set(communityId, unresolvedCreated)
  } else {
    matrixCreatedChannels.delete(communityId)
  }
  return { entities: [...merged.values()], blockedEntities: result.blockedEntities }
}

async function matrixCreateChannel(
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
  clientRequestId = createMatrixTransactionId(),
  threadRootId?: string,
  mentionUserIds: readonly string[] = [],
  mentionsRoom = false,
): Promise<Message> {
  return tauriInvoke('matrix_send_message', {
    roomId,
    body,
    replyToId,
    threadRootId,
    mentions: [...mentionUserIds],
    mentionsRoom,
    transactionId: clientRequestId,
  })
}

export async function matrixQueuedMessages(): Promise<Message[]> {
  if (!isMatrixBackend()) return []
  return tauriInvoke('matrix_queued_messages', undefined, READ_IPC_OPTIONS)
}

export async function matrixRetryQueuedMessage(
  roomId: string,
  transactionId: string,
): Promise<void> {
  if (!isMatrixBackend()) return
  return tauriInvoke('matrix_retry_queued_message', { roomId, transactionId })
}

export async function matrixCancelQueuedMessage(
  roomId: string,
  transactionId: string,
): Promise<void> {
  if (!isMatrixBackend()) return
  return tauriInvoke('matrix_cancel_queued_message', { roomId, transactionId })
}

export async function loadComposerDraft(roomId: string): Promise<ComposerDraftDto | null> {
  if (!isMatrixBackend()) return null
  return tauriInvoke('matrix_load_composer_draft', { roomId }, READ_IPC_OPTIONS)
}

export async function saveComposerDraft(roomId: string, draft: ComposerDraftDto): Promise<void> {
  if (!isMatrixBackend()) return
  return tauriInvoke('matrix_save_composer_draft', {
    roomId,
    body: draft.body,
    formattedBody: draft.formattedBody,
  })
}

export async function clearComposerDraft(roomId: string): Promise<void> {
  if (!isMatrixBackend()) return
  return tauriInvoke('matrix_clear_composer_draft', { roomId })
}

export async function matrixSendAttachment(
  roomId: string,
  attachmentGrant: string,
  transferId: string,
  body: string,
  replyToId?: string,
  threadRootId?: string,
  mentionUserIds: readonly string[] = [],
): Promise<Message> {
  return tauriInvoke(
    'matrix_send_attachment',
    {
      roomId,
      attachmentGrant,
      transferId,
      body,
      replyToId,
      threadRootId,
      mentions: [...mentionUserIds],
    },
    BLOCKING_WRITE_IPC_OPTIONS,
  )
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

export function createMatrixTransactionId(): string {
  return createMatrixTransferId()
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
  roomId: string,
  eventId: string,
  attachmentIndex: number,
  transferId: string,
): Promise<string> {
  return tauriInvoke(
    'matrix_download_attachment',
    { roomId, eventId, attachmentIndex, transferId },
    BLOCKING_WRITE_IPC_OPTIONS,
  )
}

export async function matrixLoadAttachmentThumbnail(
  _roomId: string,
  _eventId: string,
  _attachmentIndex: number,
): Promise<null> {
  // Received encrypted thumbnails stay undecrypted, uncached, and outside
  // renderer IPC until Mesh has a reviewed sandboxed-preview boundary.
  return null
}

export async function matrixLoadAttachmentImage(
  roomId: string,
  eventId: string,
  attachmentIndex: number,
): Promise<ProtectedImage | null> {
  if (!isMatrixBackend()) return null
  const bytes = await tauriInvoke<ArrayBuffer | Uint8Array | number[]>(
    'matrix_load_attachment_image',
    { roomId, eventId, attachmentIndex },
    LIGHTBOX_IMAGE_IPC_OPTIONS,
  )
  const normalized = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const contentType = protectedImageContentType(normalized)
  if (
    normalized.byteLength === 0 ||
    normalized.byteLength > MAX_LIGHTBOX_IMAGE_BYTES ||
    !contentType
  ) {
    throw normalizeError('Protected image failed local validation')
  }
  return { bytes: normalized, contentType }
}

export async function listServerEmoji(communityId: string): Promise<CustomEmoji[]> {
  if (!isMatrixBackend()) return []
  return tauriInvoke('matrix_list_custom_emoji', { communityId }, READ_IPC_OPTIONS)
}

export async function loadServerEmojiImage(
  communityId: string,
  shortcode: string,
): Promise<Uint8Array> {
  if (!isMatrixBackend()) return new Uint8Array()
  const bytes = await tauriInvoke<ArrayBuffer | Uint8Array | number[]>(
    'matrix_load_custom_emoji_image',
    { communityId, shortcode },
    CUSTOM_EMOJI_IMAGE_IPC_OPTIONS,
  )
  const normalized = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (normalized.byteLength === 0 || normalized.byteLength > MAX_CUSTOM_EMOJI_BYTES) {
    throw normalizeError('Server emoji image failed local validation.')
  }
  return normalized
}

export async function pickCustomEmojiGrant(
  communityId: string,
): Promise<NativeAttachmentGrant | null> {
  if (!isMatrixBackend()) return null
  const grant = await tauriInvoke<NativeAttachmentGrant | null>(
    'pick_custom_emoji_grant',
    { communityId },
  )
  return grant ?? null
}

export async function uploadServerEmoji(
  communityId: string,
  shortcode: string,
  grant: string,
): Promise<CustomEmoji> {
  return tauriInvoke('matrix_upload_custom_emoji', { communityId, shortcode, grant })
}

export async function removeServerEmoji(
  communityId: string,
  shortcode: string,
): Promise<void> {
  if (!isMatrixBackend()) return
  return tauriInvoke('matrix_remove_custom_emoji', { communityId, shortcode })
}

export async function matrixCancelAttachmentDownload(fileHash: string): Promise<void> {
  return tauriInvoke('matrix_cancel_attachment_download', { fileHash })
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
  accountScope: NativeAttachmentAccountScope
}

export interface NativeAttachmentAccountScope {
  accountGeneration: number
  userId: string
}

export async function pickAttachmentGrants(): Promise<NativeAttachmentIntake> {
  return tauriInvoke('pick_attachment_grants', undefined, BLOCKING_WRITE_IPC_OPTIONS)
}

export async function acceptAttachmentDropGrants(grants: string[]): Promise<void> {
  return tauriInvoke('accept_attachment_drop_grants', { grants })
}

export async function openExternalUrl(url: string): Promise<void> {
  return tauriInvoke('open_external_url', { url })
}

export async function discardStagedAttachment(token: string): Promise<void> {
  return tauriInvoke('discard_staged_attachment', { token })
}

export async function discardAttachmentGrant(grant: string): Promise<void> {
  return tauriInvoke('discard_attachment_grant', { grant })
}

async function matrixGetMessages(
  roomId: string,
  limit: number,
  before?: { timestamp: string; id: string },
): Promise<Message[]> {
  return tauriInvoke<Message[]>(
    'matrix_get_messages',
    {
      roomId,
      limit,
      beforeTimestamp: before?.timestamp,
      beforeId: before?.id,
    },
    READ_IPC_OPTIONS,
  )
}

export async function matrixThreadContext(
  roomId: string,
  threadRootId: string,
): Promise<MatrixThreadContextDto> {
  return tauriInvoke<MatrixThreadContextDto>(
    'matrix_thread_context',
    { roomId, threadRootId },
    READ_IPC_OPTIONS,
  )
}

export async function matrixThreadList(roomId: string): Promise<MatrixThreadListDto> {
  return tauriInvoke<MatrixThreadListDto>(
    'matrix_thread_list',
    { roomId },
    READ_IPC_OPTIONS,
  )
}

export async function matrixRoomPins(roomId: string): Promise<MatrixRoomPins> {
  return tauriInvoke('matrix_room_pins', { roomId }, READ_IPC_OPTIONS)
}

export async function matrixToggleRoomPin(
  roomId: string,
  eventId: string,
): Promise<MatrixRoomPins> {
  return tauriInvoke('matrix_toggle_room_pin', { roomId, eventId }, { toast: true })
}

export async function matrixWaitForRoomUpdate(
  roomId: string,
  timeoutMs = 25_000,
): Promise<MatrixRoomUpdateKind> {
  return tauriInvoke(
    'matrix_wait_for_room_update',
    { roomId, timeoutMs },
    { idempotent: true, timeoutMs: timeoutMs + 5_000, maxAttempts: 1 },
  )
}

export interface MatrixTypingUser {
  userId: string
  displayName: string
}

export async function matrixTypingUsers(roomId: string): Promise<MatrixTypingUser[]> {
  return tauriInvoke('matrix_typing_users', { roomId }, READ_IPC_OPTIONS)
}

export async function matrixSyncOnce(): Promise<void> {
  return tauriInvoke('matrix_sync_once')
}

export async function matrixEnableRecovery(
  passphrase?: string,
): Promise<MatrixRecoverySetupResult> {
  const recovery = await tauriInvoke<MatrixRecoverySetupResult>(
    'matrix_enable_recovery',
    { passphrase },
    SLOW_WRITE_IPC_OPTIONS,
  )
  emitMatrixTrustChanged()
  return recovery
}

export async function matrixRecover(recoveryKeyOrPassphrase: string): Promise<void> {
  await tauriInvoke(
    'matrix_recover',
    { recoveryKeyOrPassphrase },
    SLOW_WRITE_IPC_OPTIONS,
  )
  emitMatrixTrustChanged()
}

// ─── Identity Commands ──────────────────────────────

export async function createIdentity(): Promise<Identity> {
  return legacyTauriInvoke('create_identity')
}

export async function getIdentity(): Promise<Identity | null> {
  if (!isTauri()) {
    return null
  }

  return legacyTauriInvoke('get_identity', undefined, READ_IPC_OPTIONS)
}

export async function updateProfile(displayName: string, avatarColor: string): Promise<Identity> {
  return legacyTauriInvoke('update_profile', { displayName, avatarColor })
}

export async function updateDisplayName(name: string): Promise<void> {
  return legacyTauriInvoke('update_display_name', { name })
}

// ─── Community Commands ─────────────────────────────

export async function createCommunity(name: string, description: string): Promise<Community> {
  if (isMatrixBackend()) {
    return matrixCreateCommunity(name, description)
  }
  return legacyTauriInvoke('create_community', { name, description })
}

export async function getCommunities(): Promise<Community[]> {
  return (await getCommunitiesResult()).entities
}

export async function getCommunitiesResult(): Promise<EntityListResult<Community>> {
  if (!isTauri()) {
    return { entities: [], blockedEntities: [] }
  }

  if (isMatrixBackend()) {
    const result = await matrixListCommunities()
    reportBlockedEntities('Community listing', result.blockedEntities)
    return result
  }
  return {
    entities: await legacyTauriInvoke('get_communities', undefined, READ_IPC_OPTIONS),
    blockedEntities: [],
  }
}

export async function joinCommunity(inviteLink: string): Promise<Community> {
  if (isMatrixBackend()) {
    if (parseAdmissionCommunityInvite(inviteLink)) {
      throw new AppError(
        'community_invite_requires_native_open',
        'Open this private invitation with Mesh rather than pasting it.',
        false,
      )
    }
    const parsed = parseMatrixCommunityInvite(inviteLink)
    if (isMeshJoinLink(inviteLink) && !parsed) {
      throw new AppError(
        'community_invite_invalid',
        'This community invite is incomplete, invalid, or from an unsupported Mesh version.',
        false,
      )
    }
    return tauriInvoke(
      'matrix_join_community',
      {
        roomOrAlias: parsed?.roomOrAlias ?? inviteLink,
        via: parsed?.via ?? [],
      },
      SLOW_WRITE_IPC_OPTIONS,
    )
  }
  return legacyTauriInvoke('join_community', { inviteLink })
}

export async function matrixJoinRoom(roomId: string): Promise<void> {
  if (!isMatrixBackend()) {
    throw new Error('Joining a Matrix room is available only for Matrix-compatible services')
  }
  return tauriInvoke('matrix_join_room', { roomId }, SLOW_WRITE_IPC_OPTIONS)
}

export async function joinOrRequestCommunity(inviteLink: string): Promise<CommunityAccessResult> {
  const parsed = isMatrixBackend() ? parseMatrixCommunityInvite(inviteLink) : null
  try {
    return {
      status: 'joined',
      community: await joinCommunity(inviteLink),
    }
  } catch (error) {
    if (!isMatrixBackend() || !parsed) {
      throw error
    }
    if (normalizeError(error).code !== 'permission_denied') {
      throw error
    }
    return requestCommunityAccess(
      parsed.roomOrAlias,
      'Requested through a private Mesh community link.',
      parsed.via,
    )
  }
}

export async function leaveCommunity(communityId: string): Promise<void> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_leave_community', { communityId })
  }
  return legacyTauriInvoke('leave_community', { communityId })
}

export async function deleteCommunity(communityId: string): Promise<void> {
  if (isMatrixBackend()) {
    return leaveCommunity(communityId)
  }
  return legacyTauriInvoke('delete_community', { communityId })
}

export async function inviteMatrixUser(communityId: string, username: string): Promise<void> {
  return tauriInvoke('matrix_invite_to_community', { communityId, username })
}

/** Reads the community's current join rule, alias and directory visibility. */
export async function communityAccessSettings(
  communityId: string,
): Promise<CommunityAccessSettings> {
  return tauriInvoke(
    'matrix_community_access_settings',
    { communityId },
    READ_IPC_OPTIONS,
  )
}

/**
 * `joinRule` and `discoverable` are independent. "knock" means an administrator
 * approves each request; `discoverable` only controls whether the community is
 * published to the account service's directory, which needs an alias to publish.
 */
export async function updateCommunityAccess(
  communityId: string,
  alias: string,
  discoverable: boolean,
  joinRule: CommunityJoinRule,
): Promise<CommunityAccessSettings> {
  return tauriInvoke('matrix_update_community_access', {
    communityId,
    alias: alias.trim() || null,
    discoverable,
    joinRule,
  })
}

export async function searchCommunityDirectory(
  query: string,
  server?: string,
  limit = 20,
): Promise<CommunityDirectoryEntry[]> {
  return invokeNativeSearch(
    `directory:${server?.trim() || 'account-service'}`,
    'matrix_search_community_directory',
    {
      query,
      server: server?.trim() || null,
      limit,
    },
  )
}

/**
 * Ask the account service who it knows by that name.
 *
 * Sends what was typed to the homeserver, so callers gate it: the palette only
 * searches when somebody is explicitly looking for a person, never on every
 * command-palette keystroke.
 *
 * The answer is the *local* service's, and most homeservers publish only people
 * who share a room with the searcher or are in public rooms. An empty result is
 * that service's answer, not proof the person does not exist.
 */
export async function searchPersonDirectory(
  query: string,
  limit = 20,
): Promise<DirectoryPeopleResult> {
  return invokeNativeSearch('people-directory', 'matrix_search_person_directory', {
    query,
    limit,
  })
}

export async function requestCommunityAccess(
  roomOrAlias: string,
  reason?: string,
  via: string[] = [],
): Promise<CommunityAccessResult> {
  return tauriInvoke('matrix_knock_community', {
    roomOrAlias,
    reason: reason?.trim() || null,
    via,
  })
}

export async function getCommunityApplications(
  communityId: string,
): Promise<CommunityApplication[]> {
  return tauriInvoke('matrix_list_community_applications', { communityId }, READ_IPC_OPTIONS)
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
  if (!isMatrixBackend()) {
    return legacyTauriInvoke('generate_invite_link', { communityId })
  }
  const invite = await tauriInvoke<string>('matrix_create_community_invite', {
    communityId,
  })
  if (!parseCommunityInvite(invite)) {
    throw new AppError(
      'community_invite_invalid',
      'The service returned an invalid community invitation.',
      false,
    )
  }
  return invite
}

// ─── Channel Commands ───────────────────────────────

/**
 * Ordered rooms only. Kept for callers that cannot surface a partial result.
 * Prefer `getChannelsResult` so a room Mesh refuses to open can be explained
 * instead of silently vanishing from the sidebar.
 */
export async function getChannels(communityId: string): Promise<Channel[]> {
  return (await getChannelsResult(communityId)).entities
}

export async function getChannelsResult(
  communityId: string,
): Promise<EntityListResult<Channel>> {
  if (!isTauri()) {
    return { entities: [], blockedEntities: [] }
  }

  if (isMatrixBackend()) {
    const result = await matrixListChannels(communityId)
    reportBlockedEntities('Channel listing', result.blockedEntities)
    return result
  }
  return {
    entities: await legacyTauriInvoke('get_channels', { communityId }, READ_IPC_OPTIONS),
    blockedEntities: [],
  }
}

/**
 * Joins a room this community already admits you to, returning it as a joined
 * room.
 *
 * A room created after you arrived in a community is one you are allowed to
 * join and are not in, so it arrives from `getChannelsResult` with
 * `joined: false` and no timeline. This is the only way that room becomes
 * readable, and it is a write: never retried, and it fails loudly rather than
 * leaving a room half-open.
 */
export async function joinCommunityChannel(
  communityId: string,
  channelId: string,
): Promise<Channel> {
  if (!isMatrixBackend()) {
    throw new Error('Joining a room is available only for Matrix-compatible services')
  }
  return tauriInvoke(
    'matrix_join_community_channel',
    { communityId, channelId },
    SLOW_WRITE_IPC_OPTIONS,
  )
}

/**
 * Renames or re-topics a room. Both fields are optional so changing one cannot
 * clobber the other.
 */
export async function updateChannel(
  communityId: string,
  channelId: string,
  changes: { name?: string; topic?: string },
): Promise<Channel> {
  return tauriInvoke('matrix_update_channel', {
    communityId,
    channelId,
    name: changes.name ?? null,
    topic: changes.topic ?? null,
  })
}

/**
 * Detaches a room from its community and leaves it.
 *
 * Matrix has no delete: members already in the room keep their copy. The
 * confirmation copy says so rather than promising a deletion Mesh cannot do.
 */
export async function removeChannel(communityId: string, channelId: string): Promise<void> {
  return tauriInvoke('matrix_remove_channel', { communityId, channelId })
}

export async function createChannel(
  communityId: string,
  name: string,
  type: 'text' | 'voice',
): Promise<Channel> {
  if (isMatrixBackend()) {
    return matrixCreateChannel(communityId, name, type)
  }
  return legacyTauriInvoke('create_channel', {
    communityId,
    name,
    channelType: type,
  })
}

export async function updateCommunityMetadata(
  communityId: string,
  name: string,
  description: string,
): Promise<void> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_update_community', {
      communityId,
      name,
      description,
    })
  }
  return legacyTauriInvoke('update_community_metadata', {
    communityId,
    name,
    description,
  })
}

// ─── Message Commands ───────────────────────────────

export async function sendMessage(
  channelId: string,
  content: string,
  attachments: Attachment[] = [],
  replyToId?: string,
  transactionId = createMatrixTransactionId(),
  threadRootId?: string,
  mentionUserIds: readonly string[] = [],
  mentionsRoom = false,
): Promise<Message> {
  if (isMatrixBackend()) {
    if (attachments.length > 0) {
      throw new Error('Use matrixSendAttachment for encrypted Matrix media')
    }
    return matrixSendMessage(
      channelId,
      content,
      replyToId,
      transactionId,
      threadRootId,
      mentionUserIds,
      mentionsRoom,
    )
  }
  return legacyTauriInvoke('send_message', {
    channelId,
    content,
    attachments,
    replyToId,
  })
}

export async function getMessages(
  channelId: string,
  limit: number = 50,
  before?: { timestamp: string; id: string },
): Promise<Message[]> {
  if (isMatrixBackend()) {
    return matrixGetMessages(channelId, limit, before)
  }
  return legacyTauriInvoke(
    'get_messages',
    {
      channelId,
      limit,
      beforeTimestamp: before?.timestamp,
      beforeId: before?.id,
    },
    READ_IPC_OPTIONS,
  )
}

export async function markChannelRead(channelId: string): Promise<void> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_mark_read', { roomId: channelId })
  }
  return legacyTauriInvoke('mark_channel_read', { channelId })
}

/**
 * Sets or clears the person's own explicit "mark as unread" marker on a room
 * (channel or DM alike: the marker is a room-level Matrix concept). Reading
 * the room through the normal receipt flow clears it automatically.
 */
export async function setRoomUnreadFlag(roomId: string, unread: boolean): Promise<void> {
  if (!isMatrixBackend()) return
  return tauriInvoke('matrix_set_unread_flag', { roomId, unread })
}

export async function markThreadRead(
  roomId: string,
  threadRootId: string,
  eventId: string,
): Promise<void> {
  if (!isMatrixBackend()) return
  return tauriInvoke('matrix_mark_thread_read', { roomId, threadRootId, eventId })
}

export async function markChannelsRead(channelIds: string[]): Promise<string[]> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_mark_rooms_read', { roomIds: channelIds })
  }
  const results = await Promise.allSettled(channelIds.map((channelId) => markChannelRead(channelId)))
  return channelIds.filter((_, index) => results[index]?.status === 'rejected')
}

export async function requestMessageHistory(
  channelId: string,
  options: { peerId?: string; limit?: number } = {},
): Promise<void> {
  if (isMatrixBackend()) {
    await matrixSyncOnce()
    return
  }
  return legacyTauriInvoke('request_message_history', {
    channelId,
    peerId: options.peerId,
    limit: options.limit,
  })
}

export async function editMessage(
  messageId: string,
  content: string,
  channelId?: string,
  mentionUserIds: readonly string[] = [],
): Promise<Message | void> {
  if (isMatrixBackend()) {
    if (!channelId) throw new Error('Matrix room ID is required to edit a message')
    return tauriInvoke('matrix_edit_message', {
      roomId: channelId,
      eventId: messageId,
      body: content,
      mentions: [...mentionUserIds],
    })
  }
  return legacyTauriInvoke('edit_message', { messageId, content })
}

export async function deleteMessage(messageId: string, channelId?: string): Promise<void> {
  if (isMatrixBackend()) {
    if (!channelId) throw new Error('Matrix room ID is required to redact a message')
    return tauriInvoke('matrix_redact_message', {
      roomId: channelId,
      eventId: messageId,
    })
  }
  return legacyTauriInvoke('delete_message', { messageId })
}

export async function reportMessage(
  messageId: string,
  channelId: string,
  reason: string,
): Promise<void> {
  if (!isMatrixBackend()) {
    throw new Error('Message reporting is available only for Matrix-compatible services')
  }
  return tauriInvoke('matrix_report_message', {
    roomId: channelId,
    eventId: messageId,
    reason,
  })
}

export async function addReaction(
  messageId: string,
  emoji: string,
  channelId?: string,
): Promise<string | boolean> {
  if (isMatrixBackend()) {
    if (!channelId) throw new Error('Matrix room ID is required to react to a message')
    return tauriInvoke('matrix_toggle_reaction', {
      roomId: channelId,
      eventId: messageId,
      key: emoji,
    })
  }
  return legacyTauriInvoke('add_reaction', { messageId, emoji })
}

export async function searchMessages(
  terms: string[],
  communityId: string,
  limit: number = 50,
  filters?: SearchFilters,
): Promise<Message[]> {
  if (isMatrixBackend()) {
    return invokeNativeSearch(
      `messages:${communityId}`,
      'matrix_search_messages',
      { terms, communityId, limit, filters: filters ?? {} },
    )
  }
  // The legacy FTS path does not yet apply structured filters or terms, only
  // a single query string, so the terms are rejoined for it.
  return legacyTauriInvoke(
    'search_messages',
    { query: terms.join(' '), communityId, limit },
    READ_IPC_OPTIONS,
  )
}

/**
 * Searches every community the account has joined in one native call, sharing
 * a single deadline and result budget across all of them. Returns the scope
 * the search actually covered alongside the results, since a large account
 * can have some communities fully searched and others not reached at all.
 */
export async function searchMessagesEverywhere(
  terms: string[],
  communityIds: string[],
  limit: number = 50,
  filters?: SearchFilters,
): Promise<MatrixCrossCommunitySearchResultDto> {
  if (!isMatrixBackend()) {
    throw new Error('Cross-community search is available only for Matrix-compatible services')
  }
  return invokeNativeSearch(
    'messages:everywhere',
    'matrix_search_messages_everywhere',
    { terms, communityIds, limit, filters: filters ?? {} },
  )
}

export async function cancelMessageSearch(communityId: string): Promise<void> {
  if (!isTauri() || !isMatrixBackend()) return
  await cancelActiveNativeSearch(`messages:${communityId}`)
}

/** Cancels an in-flight `searchMessagesEverywhere` call, if one is running. */
export async function cancelMessageSearchEverywhere(): Promise<void> {
  if (!isTauri() || !isMatrixBackend()) return
  await cancelActiveNativeSearch('messages:everywhere')
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

// ─── KV Store Commands ─────────────────────────────

export async function setKv(key: string, value: string): Promise<void> {
  return legacyTauriInvoke('set_kv', { key, value })
}

// ─── Typing Commands ───────────────────────────────

export async function broadcastTyping(channelId: string): Promise<void> {
  if (isMatrixBackend()) {
    return setTyping(channelId, true)
  }
  return legacyTauriInvoke('broadcast_typing', { channelId })
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

const BROWSER_PREVIEW_ICE_SERVERS: IceServerConfig[] = [
  { urls: ['stun:stun.l.google.com:19302'] },
]

export async function getIceServers(): Promise<IceServerConfig[]> {
  // Browser preview has no native backend. Keep its deterministic STUN-only
  // fixture, but never hide a configured Tauri backend failure from callers.
  if (!isTauri()) return BROWSER_PREVIEW_ICE_SERVERS
  return legacyTauriInvoke<IceServerConfig[]>('get_ice_servers', undefined, READ_IPC_OPTIONS)
}

export interface IceServerStatus {
  stunConfigured: boolean
  turnConfigured: boolean
  customServers: boolean
  serverCount: number
  warnings: string[]
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
  return legacyTauriInvoke<IceServerProbeResult[]>(
    'probe_ice_servers',
    undefined,
    READ_IPC_OPTIONS,
  )
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
  return legacyTauriInvoke<SystemDiagnostics>('get_diagnostics', undefined, READ_IPC_OPTIONS)
}

// ─── Voice Commands ─────────────────────────────────

/*
    Every MatrixRTC payload below is aliased from the generated contract rather
    than restated. Restating one is how a wire field goes missing in the
    renderer without anything failing: `participantIdentity` reached this file
    over IPC while `MatrixRtcMember` was a hand-written copy, so it did not
    exist as far as TypeScript was concerned. The copies these aliases replaced
    happened to agree with the Rust structs, which is the part worth
    distrusting. Nothing checked that they did.

    `MatrixRtcMediaKey` carries an ephemeral publisher key, delivered only over
    the Tauri event boundary after an Olm-authenticated to-device event has been
    bound to a current room membership. Apply it straight to the media engine
    keyring. It must never be persisted or logged. See the Rust DTO for the
    guarantees behind it.
*/
import type {
  MatrixRtcJoinResult,
  MatrixRtcMediaKey,
  MatrixRtcMediaKeyFailure,
  MatrixRtcMediaKeyLease,
  MatrixRtcMediaKeyPause,
  MatrixRtcMember,
  MatrixRtcMembershipUpdate,
} from '../types/ipc.generated'

export type {
  MatrixRtcJoinResult,
  MatrixRtcMediaKey,
  MatrixRtcMediaKeyFailure,
  MatrixRtcMediaKeyLease,
  MatrixRtcMediaKeyPause,
  MatrixRtcMember,
  MatrixRtcMembershipUpdate,
}

export async function matrixRtcJoin(roomId: string): Promise<MatrixRtcJoinResult> {
  return tauriInvoke('matrix_rtc_join', { roomId })
}

export async function matrixRtcLeave(roomId: string, sessionId: string): Promise<void> {
  return tauriInvoke('matrix_rtc_leave', { roomId, sessionId })
}

export async function matrixRtcMembers(roomId: string): Promise<MatrixRtcMember[]> {
  return tauriInvoke('matrix_rtc_members', { roomId }, READ_IPC_OPTIONS)
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

export async function joinVoice(
  communityId: string,
  channelId: string,
): Promise<VoiceSessionSnapshot> {
  requireLegacyVoice('join a voice room')
  return legacyTauriInvoke('join_voice', { communityId, channelId })
}

export async function leaveVoice(communityId: string, channelId: string): Promise<void> {
  requireLegacyVoice('leave a voice room')
  return legacyTauriInvoke('leave_voice', { communityId, channelId })
}

export async function setMuted(muted: boolean): Promise<void> {
  requireLegacyVoice('change voice mute state')
  return legacyTauriInvoke('set_muted', { muted })
}

export async function setDeafened(deafened: boolean): Promise<void> {
  requireLegacyVoice('change voice deafen state')
  return legacyTauriInvoke('set_deafened', { deafened })
}

export async function sendVoiceSignal(
  peerId: string,
  signal: unknown,
  communityId: string,
  channelId: string,
): Promise<void> {
  requireLegacyVoice('send legacy WebRTC signaling')
  // Validate that the signal payload is serializable before sending to Tauri
  try {
    if (JSON.stringify(signal) === undefined) {
      throw new TypeError('Signal payload serialized to undefined')
    }
  } catch {
    throw new AppError(
      'serialization_error',
      'Voice signaling data could not be sent because the payload is not serializable.',
      false,
    )
  }

  const payload: VoiceSignalPayload = {
    peerId,
    signal,
    communityId,
    channelId,
  }
  return legacyTauriInvoke('send_voice_signal', {
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
    {
      frequency: 523.25,
      offset: 0,
      duration: 0.12,
      volume: 0.12,
      type: 'sine',
    },
    {
      frequency: 783.99,
      offset: 0.1,
      duration: 0.18,
      volume: 0.1,
      type: 'sine',
    },
  ],
  chime: [
    { frequency: 659.25, offset: 0, duration: 0.16, volume: 0.1, type: 'sine' },
    {
      frequency: 987.77,
      offset: 0.13,
      duration: 0.24,
      volume: 0.08,
      type: 'sine',
    },
  ],
  pulse: [
    {
      frequency: 440,
      offset: 0,
      duration: 0.08,
      volume: 0.08,
      type: 'triangle',
    },
    {
      frequency: 440,
      offset: 0.13,
      duration: 0.08,
      volume: 0.08,
      type: 'triangle',
    },
  ],
  soft: [{ frequency: 392, offset: 0, duration: 0.24, volume: 0.06, type: 'sine' }],
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
      void context
        .resume()
        .then(play)
        .catch(() => {})
    } else {
      play()
    }
  } catch {
    // The native desktop notification remains useful if a locked-down webview
    // refuses background audio.
  }
}

// ─── Event Listeners ────────────────────────────────

/**
 * Puts the renderer's computed title on the operating system's window.
 *
 * `document.title` is precise already, but in a Tauri app it addresses a
 * browser tab that does not exist: Alt-Tab, the taskbar and the window list all
 * read the title set natively, which never changed from "Mesh".
 */
export function setWindowTitle(title: string): Promise<void> {
  return tauriInvoke('set_window_title', { title })
}

export function onMessageReceived(handler: (message: Message) => void): Promise<UnlistenFn> {
  return tauriListen('message:received', handler)
}

export function onMatrixNotification(
  handler: (notification: MatrixNotification) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:notification', handler)
}

/**
 * Somebody clicked a Mesh notification. The payload names the room it was
 * about, so the click can land in that conversation rather than only raising
 * the window.
 */
export function onMatrixNotificationActivated(
  handler: (activation: MatrixNotificationActivation) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:notification-activated', handler)
}

export function onMatrixUnreadUpdate(
  handler: (update: MatrixUnreadUpdate) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:unread-update', handler)
}

export function onMatrixTypingChanged(
  handler: (change: MatrixTypingChanged) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:typing-changed', handler)
}

export function onMatrixIgnoredUsersChanged(
  handler: (change: MatrixIgnoredUsersChanged) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:ignored-users-changed', handler)
}

/**
 * The set of communities this account belongs to changed. Carries no payload:
 * the listing is refetched, because the event says only that what the renderer
 * holds is stale.
 */
export function onMatrixCommunitiesChanged(handler: () => void): Promise<UnlistenFn> {
  return tauriListen('matrix:communities-changed', () => handler())
}

export function onMatrixRoomPinsUpdate(
  handler: (update: MatrixRoomPinsUpdate) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:room-pins', handler)
}

export function onMatrixPermissionStateChanged(
  handler: (change: MatrixPermissionStateChanged) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:permission-state-changed', handler)
}

export function onMatrixQueuedMessage(
  handler: (update: MatrixQueuedMessageUpdate) => void,
): Promise<UnlistenFn> {
  return tauriListen('matrix:queued-message', handler)
}

export function onReactionReceived(handler: (data: ReactionEvent) => void): Promise<UnlistenFn> {
  return tauriListen('reaction:received', handler)
}

export function onMessageEdited(
  handler: (data: {
    messageId: string
    channelId: string
    content: string
    editedAt: string
  }) => void,
): Promise<UnlistenFn> {
  return tauriListen('message:edited', handler)
}

export function onMessageDeleted(
  handler: (data: { messageId: string; channelId: string }) => void,
): Promise<UnlistenFn> {
  return tauriListen('message:deleted', handler)
}

export function onPeerJoined(handler: (data: { peerId: string }) => void): Promise<UnlistenFn> {
  return tauriListen('peer:joined', handler)
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

export function onVoiceJoin(
  handler: (data: { author: string; communityId: string; channelId: string }) => void,
): Promise<UnlistenFn> {
  if (isMatrixBackend()) return Promise.resolve(() => {})
  return tauriListen('voice:join', handler)
}

export function onVoiceLeave(
  handler: (data: { author: string; communityId: string; channelId: string }) => void,
): Promise<UnlistenFn> {
  if (isMatrixBackend()) return Promise.resolve(() => {})
  return tauriListen('voice:leave', handler)
}

export function onVoiceSession(handler: (data: VoiceSessionSnapshot) => void): Promise<UnlistenFn> {
  if (isMatrixBackend()) return Promise.resolve(() => {})
  return tauriListen('voice:session:snapshot', handler)
}

export function onVoiceSessionEvent(
  handler: (data: VoiceSessionEvent) => void,
): Promise<UnlistenFn> {
  if (isMatrixBackend()) return Promise.resolve(() => {})
  return tauriListen('voice:session:event', handler)
}

export function onMatrixRtcMembership(
  handler: (data: MatrixRtcMembershipUpdate) => void,
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

export async function sendDm(
  recipientPublicKey: string,
  content: string,
  replyToId?: string,
  transactionId = createMatrixTransactionId(),
  threadRootId?: string,
): Promise<DirectMessage> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_send_dm', {
      recipientUserId: recipientPublicKey,
      body: content,
      replyToId,
      threadRootId,
      transactionId,
    })
  }
  return legacyTauriInvoke('send_dm', { recipientPublicKey, content })
}

export async function getDmConversations(): Promise<DmConversation[]> {
  if (!isTauri()) return []
  if (isMatrixBackend()) {
    const result = await tauriInvoke<EntityListResult<DmConversation>>(
      'matrix_dm_conversations',
      undefined,
      READ_IPC_OPTIONS,
    )
    reportBlockedEntities('Direct-message listing', result.blockedEntities)
    return result.entities
  }
  return legacyTauriInvoke('get_dm_conversations', undefined, READ_IPC_OPTIONS)
}

export async function getDmRequests(): Promise<DmRequestDto[]> {
  if (!isTauri() || !isMatrixBackend()) return []
  return tauriInvoke('matrix_dm_requests', undefined, READ_IPC_OPTIONS)
}

/**
 * Invitations for this account to join a community. Space invitations are
 * deliberately excluded from the DM request surface, so without this listing
 * they appeared nowhere, including the invite Mesh itself sends when an
 * administrator approves a join request.
 */
export async function getCommunityInvites(): Promise<CommunityInviteDto[]> {
  if (!isTauri() || !isMatrixBackend()) return []
  return tauriInvoke('matrix_community_invites', undefined, READ_IPC_OPTIONS)
}

/** Accepting is joining: the account was already invited, so no via is needed. */
export async function acceptCommunityInvite(roomId: string): Promise<Community> {
  if (!isMatrixBackend()) {
    throw new Error('Community invitations are unavailable in the legacy bridge')
  }
  return tauriInvoke('matrix_join_community', { roomOrAlias: roomId, via: [] }, SLOW_WRITE_IPC_OPTIONS)
}

export async function declineCommunityInvite(roomId: string): Promise<void> {
  if (!isMatrixBackend()) {
    throw new Error('Community invitations are unavailable in the legacy bridge')
  }
  return tauriInvoke('matrix_decline_community_invite', { roomId })
}

export async function getBlockedAccounts(
  after?: string,
  limit: number = 50,
): Promise<BlockedAccountPageDto> {
  if (!isTauri() || !isMatrixBackend()) return { accounts: [], nextCursor: null }
  return tauriInvoke(
    'matrix_blocked_accounts',
    { after, limit },
    READ_IPC_OPTIONS,
  )
}

export async function acceptDmRequest(roomId: string): Promise<DmConversation> {
  if (!isMatrixBackend()) {
    throw new Error('Message requests are unavailable in the legacy bridge')
  }
  return tauriInvoke('matrix_accept_dm_request', { roomId })
}

export async function declineDmRequest(roomId: string): Promise<void> {
  if (!isMatrixBackend()) {
    throw new Error('Message requests are unavailable in the legacy bridge')
  }
  return tauriInvoke('matrix_decline_dm_request', { roomId })
}

export async function blockDmRequest(roomId: string): Promise<BlockedAccountDto> {
  if (!isMatrixBackend()) {
    throw new Error('Message-request blocking is unavailable in the legacy bridge')
  }
  return tauriInvoke('matrix_block_dm_request', { roomId })
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
    return tauriInvoke(
      'matrix_dm_messages',
      {
        conversationId,
        limit,
        beforeTimestamp: before?.timestamp,
        beforeId: before?.id,
      },
      READ_IPC_OPTIONS,
    )
  }
  return legacyTauriInvoke(
    'get_dm_messages',
    {
      conversationId,
      limit,
      beforeTimestamp: before?.timestamp,
      beforeId: before?.id,
    },
    READ_IPC_OPTIONS,
  )
}

export async function markDmRead(conversationId: string): Promise<void> {
  if (isMatrixBackend()) return tauriInvoke('matrix_mark_dm_read', { conversationId })
  return legacyTauriInvoke('mark_dm_read', { conversationId })
}

export async function matrixSetDmBlocked(
  recipientUserId: string,
  blocked: boolean,
): Promise<boolean> {
  return tauriInvoke('matrix_set_dm_blocked', { recipientUserId, blocked })
}

export async function matrixDmBlocked(recipientUserId: string): Promise<boolean> {
  return tauriInvoke('matrix_dm_blocked', { recipientUserId }, READ_IPC_OPTIONS)
}

export async function matrixSendDmAttachment(
  recipientUserId: string,
  attachmentGrant: string,
  transferId: string,
  body: string,
  replyToId?: string,
  threadRootId?: string,
): Promise<DirectMessage> {
  return tauriInvoke(
    'matrix_send_dm_attachment',
    { recipientUserId, attachmentGrant, transferId, body, replyToId, threadRootId },
    BLOCKING_WRITE_IPC_OPTIONS,
  )
}

export function onDmReceived(handler: (data: DirectMessage) => void): Promise<UnlistenFn> {
  return tauriListen('dm:received', handler)
}

// ─── File Commands ──────────────────────────────────

export async function uploadFile(channelId: string, filePath: string): Promise<string> {
  return legacyTauriInvoke(
    'upload_file',
    { channelId, filePath },
    BLOCKING_WRITE_IPC_OPTIONS,
  )
}

export async function uploadDmFile(conversationId: string, filePath: string): Promise<string> {
  return legacyTauriInvoke(
    'upload_dm_file',
    { conversationId, filePath },
    BLOCKING_WRITE_IPC_OPTIONS,
  )
}

export async function requestFile(request: FileDownloadRequest): Promise<void> {
  return legacyTauriInvoke('request_file', { ...request }, BLOCKING_WRITE_IPC_OPTIONS)
}

// ─── Moderation Commands ────────────────────────────

export async function banUser(
  communityId: string,
  bannedPublicKey: string,
  reason?: string,
): Promise<CommunityModerationResult | null> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_ban_member', {
      communityId,
      userId: bannedPublicKey,
      reason,
    })
  }
  await legacyTauriInvoke('ban_user', { communityId, bannedPublicKey })
  return null
}

// Lifting a ban is Matrix only. The legacy peer transport has no ban record to
// clear, so the banned roster that offers this action never renders there.
export async function unbanUser(
  communityId: string,
  bannedPublicKey: string,
  reason?: string,
): Promise<CommunityModerationResult | null> {
  if (!isMatrixBackend()) return null
  return tauriInvoke('matrix_unban_member', {
    communityId,
    userId: bannedPublicKey,
    reason,
  })
}

export async function kickUser(
  communityId: string,
  targetPublicKey: string,
  reason?: string,
): Promise<CommunityModerationResult | null> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_kick_member', {
      communityId,
      userId: targetPublicKey,
      reason,
    })
  }
  await legacyTauriInvoke('kick_user', { communityId, targetPublicKey, reason })
  return null
}

export async function timeoutUser(
  communityId: string,
  targetPublicKey: string,
  durationMinutes: number,
  reason?: string,
): Promise<void> {
  if (isMatrixBackend()) {
    throw new Error(
      'Temporary Matrix moderation requires a durable policy/role restoration service',
    )
  }
  return legacyTauriInvoke('timeout_user', {
    communityId,
    targetPublicKey,
    durationMinutes,
    reason,
  })
}

export async function updateMemberRole(
  communityId: string,
  publicKey: string,
  role: string,
): Promise<CommunityModerationResult | null> {
  if (isMatrixBackend()) {
    return tauriInvoke('matrix_update_member_role', {
      communityId,
      userId: publicKey,
      role,
    })
  }
  await legacyTauriInvoke('update_member_role', { communityId, publicKey, role })
  return null
}

export async function getModerationAudit(
  communityId: string,
  limit = 50,
): Promise<ModerationAuditEntry[]> {
  if (!isMatrixBackend()) return []
  return tauriInvoke('matrix_list_moderation_audit', { communityId, limit }, READ_IPC_OPTIONS)
}

export async function getCommunityPermissionProjection(
  communityId: string,
  subjectUserId: string,
): Promise<CommunityPermissionProjection> {
  if (!isMatrixBackend()) {
    throw new Error('Community permission projection requires the Matrix backend')
  }
  return tauriInvoke(
    'matrix_get_community_permission_projection',
    { communityId, subjectUserId },
    READ_IPC_OPTIONS,
  )
}

export interface CommunityMemberDto {
  publicKey: string
  displayName: string
  avatarColor: string
  avatarUrl?: string | null
  role: string
  joinStatus: string
  banStatus: string
  lastSeen: string | null
  online?: boolean
}

export interface CommunityMemberPage {
  members: CommunityMemberDto[]
  nextCursor: string | null
  stateComplete: boolean
}

const MATRIX_MEMBER_PAGE_LIMIT = 100

export async function getMemberPage(
  communityId: string,
  cursor: string | null = null,
  limit = MATRIX_MEMBER_PAGE_LIMIT,
): Promise<CommunityMemberPage> {
  if (!isTauri()) {
    return { members: [], nextCursor: null, stateComplete: true }
  }
  if (!isMatrixBackend()) {
    const members = await legacyTauriInvoke<CommunityMemberDto[]>(
      'get_members',
      { communityId },
      READ_IPC_OPTIONS,
    )
    return { members, nextCursor: null, stateComplete: true }
  }
  return tauriInvoke<CommunityMemberPage>(
    'matrix_list_members',
    { communityId, cursor, limit },
    READ_IPC_OPTIONS,
  )
}

export async function getMembers(communityId: string): Promise<CommunityMemberDto[]> {
  if (!isTauri()) {
    return []
  }
  if (isMatrixBackend()) {
    return (await getMemberPage(communityId)).members
  }
  return legacyTauriInvoke('get_members', { communityId }, READ_IPC_OPTIONS)
}

export async function requestControlLogSync(communityId: string): Promise<void> {
  return legacyTauriInvoke('request_control_log_sync', { communityId })
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

export function onPresenceUpdate(
  handler: (data: { author: string; communityId: string; status: string }) => void,
): Promise<UnlistenFn> {
  return tauriListen('presence:update', handler)
}

// ─── File Events ────────────────────────────────────

export function onFileDownloadProgress(
  handler: (data: FileDownloadProgress) => void,
): Promise<UnlistenFn> {
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
