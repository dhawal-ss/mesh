import e2eeWorkerUrl from 'livekit-client/e2ee-worker?url'
import {
  BaseKeyProvider,
  ConnectionQuality,
  ConnectionState,
  createKeyMaterialFromBuffer,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client'
import type { Peer, VoiceConnectionState } from '../types/ipc'
import type {
  MatrixRtcMediaKey,
  MatrixRtcMediaKeyLease,
  MatrixRtcMediaKeyPause,
} from './bridge'

export interface MatrixVoiceCredentials {
  roomId: string
  roomName: string
  memberId: string
  participantIdentity: string
  sessionId: string
  url: string
  token: string
  mediaE2eeVerified: boolean
}

export interface VoiceDevice {
  deviceId: string
  kind: 'audioinput' | 'audiooutput'
  label: string
}

export interface LiveKitVoiceStats {
  latencyMs: number | null
  quality: 'excellent' | 'good' | 'poor' | 'unknown'
}

export interface LiveKitVoiceHandlers {
  onConnectionState?: (state: VoiceConnectionState, reason?: string | null) => void
  onPeers?: (peers: Peer[]) => void
  onLocalAudioLevel?: (level: number) => void
  onLocalMediaState?: (state: {
    cameraEnabled: boolean
    screenShareEnabled: boolean
  }) => void
  onDevicesChanged?: () => void
  onWarning?: (message: string | null) => void
  onError?: (error: unknown) => void
  onEncryptionFailure?: (reason: string, sessionId: string | null) => void
}

export type PublisherActivationPauseResult =
  | 'paused'
  | 'duplicate'
  | 'replayed'
  | 'ignored'

type RoomFactory = (options: ConstructorParameters<typeof Room>[0]) => Room
type EncryptionFactory = () => Promise<{ keyProvider: MatrixRtcKeyProvider; worker: Worker }>
type VoiceCuePlayer = (cue: 'join' | 'leave') => void | Promise<void>

const AUDIO_CAPTURE_OPTIONS = {
  autoGainControl: true,
  echoCancellation: true,
  noiseSuppression: true,
} as const

const MATRIX_RTC_MEDIA_KEY_BYTES = 16
const MATRIX_RTC_PUBLICATION_LEASE_MAX_MS = 3_000
const MAX_MEDIA_KEY_INDEX = 255

function decodeMediaKey(value: string): Uint8Array {
  if (
    !value ||
    value.includes('=') ||
    !/^[A-Za-z0-9+/]+$/.test(value) ||
    value.length % 4 === 1
  ) {
    throw new Error('MatrixRTC media key is not valid unpadded base64')
  }

  let binary: string
  try {
    binary = atob(`${value}${'='.repeat((4 - (value.length % 4)) % 4)}`)
  } catch {
    throw new Error('MatrixRTC media key is not valid unpadded base64')
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (
    bytes.byteLength !== MATRIX_RTC_MEDIA_KEY_BYTES ||
    btoa(binary).replace(/=+$/u, '') !== value
  ) {
    bytes.fill(0)
    throw new Error('MatrixRTC media key has an invalid length or encoding')
  }
  return bytes
}

export class MatrixRtcKeyProvider extends BaseKeyProvider {
  private updateQueue: Promise<void> = Promise.resolve()
  private readonly latestSentTsByKey = new Map<string, number>()

  constructor() {
    super({
      sharedKey: false,
      // Matrix distributes independently random key rotations. LiveKit's
      // derived ratchet chain cannot reproduce those keys, so do not guess
      // ahead; the Room encryption-error listener handles failures closed.
      ratchetWindowSize: 0,
      keyringSize: 256,
    })
  }

  setParticipantKey(mediaKey: MatrixRtcMediaKey): Promise<void> {
    const update = this.updateQueue.then(() => this.applyParticipantKey(mediaKey))
    this.updateQueue = update.catch(() => {})
    return update
  }

  private async applyParticipantKey(mediaKey: MatrixRtcMediaKey): Promise<void> {
    if (
      !mediaKey.roomId ||
      !mediaKey.userId ||
      !mediaKey.deviceId ||
      !mediaKey.memberId ||
      !mediaKey.participantIdentity ||
      !Number.isSafeInteger(mediaKey.sentTs) ||
      mediaKey.sentTs < 0 ||
      !Number.isInteger(mediaKey.keyIndex) ||
      mediaKey.keyIndex < 0 ||
      mediaKey.keyIndex > MAX_MEDIA_KEY_INDEX
    ) {
      throw new Error('MatrixRTC media key metadata is invalid')
    }

    const keyId = `${mediaKey.participantIdentity}:${mediaKey.keyIndex}`
    const latestSentTs = this.latestSentTsByKey.get(keyId)
    if (latestSentTs !== undefined && latestSentTs >= mediaKey.sentTs) return

    const bytes = decodeMediaKey(mediaKey.key)
    try {
      const material = await createKeyMaterialFromBuffer(bytes.buffer)
      this.onSetEncryptionKey(
        material,
        mediaKey.participantIdentity,
        mediaKey.keyIndex,
      )
      this.latestSentTsByKey.set(keyId, mediaKey.sentTs)
    } finally {
      bytes.fill(0)
    }
  }
}

let voiceCueAudioContext: AudioContext | null = null

export async function playMatrixVoiceCue(cue: 'join' | 'leave'): Promise<void> {
  if (typeof AudioContext === 'undefined') return

  try {
    const context = voiceCueAudioContext ?? new AudioContext()
    voiceCueAudioContext = context
    if (context.state === 'suspended') {
      await context.resume()
    }

    const start = context.currentTime
    const frequencies = cue === 'join' ? [440, 587.33] : [587.33, 392]
    frequencies.forEach((frequency, index) => {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const toneStart = start + index * 0.08
      const toneEnd = toneStart + 0.11

      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, toneStart)
      gain.gain.setValueAtTime(0.0001, toneStart)
      gain.gain.exponentialRampToValueAtTime(0.035, toneStart + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(toneStart)
      oscillator.stop(toneEnd + 0.01)
    })
  } catch {
    // A blocked audio context must never interrupt call membership updates.
  }
}

function connectionState(state: ConnectionState): VoiceConnectionState {
  switch (state) {
    case ConnectionState.Connecting:
      return 'connecting'
    case ConnectionState.Connected:
      return 'connected'
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return 'reconnecting'
    default:
      return 'disconnected'
  }
}

function participantColor(identity: string): string {
  const palette = [
    'var(--avatar-coral)',
    'var(--avatar-gold)',
    'var(--avatar-mint)',
    'var(--avatar-sky)',
    'var(--avatar-lilac)',
    'var(--avatar-sand)',
  ]
  let hash = 0
  for (let index = 0; index < identity.length; index += 1) {
    hash = (hash * 31 + identity.charCodeAt(index)) >>> 0
  }
  return palette[hash % palette.length]
}

function displayName(participant: Participant): string {
  if (participant.name?.trim()) return participant.name.trim()

  try {
    const metadata = participant.metadata ? JSON.parse(participant.metadata) as unknown : null
    if (
      metadata &&
      typeof metadata === 'object' &&
      'displayName' in metadata &&
      typeof metadata.displayName === 'string' &&
      metadata.displayName.trim()
    ) {
      return metadata.displayName.trim()
    }
  } catch {
    // Participant metadata is untrusted and optional; identity is the safe fallback.
  }

  return participant.identity
}

function participantStream(
  participant: Participant,
  source: Track.Source,
): MediaStream | undefined {
  const publication = participant.getTrackPublication(source)
  const mediaTrack = publication?.audioTrack?.mediaStreamTrack
    ?? publication?.videoTrack?.mediaStreamTrack
  return mediaTrack ? new MediaStream([mediaTrack]) : undefined
}

function peerFromParticipant(participant: Participant, local: Participant): Peer {
  const quality =
    participant.connectionQuality === ConnectionQuality.Lost
      ? 'reconnecting'
      : participant.connectionQuality === ConnectionQuality.Unknown
        ? 'connecting'
        : 'connected'

  return {
    publicKey: participant.identity,
    peerId: participant.sid || participant.identity,
    displayName: displayName(participant),
    avatarColor: participant.attributes['mesh.avatar_color'] || participantColor(participant.identity),
    latency: 0,
    stream: participantStream(participant, Track.Source.Microphone),
    cameraStream: participantStream(participant, Track.Source.Camera),
    screenShareStream: participantStream(participant, Track.Source.ScreenShare),
    screenShareAudioStream: participantStream(participant, Track.Source.ScreenShareAudio),
    connectionState: quality,
    joinedAt: participant.joinedAt?.toISOString(),
    lastSeenAt: new Date().toISOString(),
    isSelf: participant === local,
    isLocal: participant === local,
    speaking: participant.isSpeaking,
  }
}

export function isEditablePushToTalkTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.closest('[role="textbox"]') !== null
  )
}

export class LiveKitVoiceEngine {
  private room: Room | null = null
  private credentials: MatrixVoiceCredentials | null = null
  private keyProvider: MatrixRtcKeyProvider | null = null
  private readonly keyedParticipantIdentities = new Set<string>()
  private readonly participantVolumes = new Map<string, number>()
  private readonly roomFactory: RoomFactory
  private readonly encryptionFactory: EncryptionFactory
  private readonly cuePlayer: VoiceCuePlayer
  private mediaOperationQueue: Promise<void> = Promise.resolve()
  private levelTimer: ReturnType<typeof setInterval> | null = null
  private publicationLeaseTimer: ReturnType<typeof setTimeout> | null = null
  private publicationLeaseDeadline = 0
  private publicationLeaseSequence = 0
  private currentLocalKeyIndex: number | null = null
  private disconnecting = false
  private encryptionFailureInProgress = false
  private mediaKeysReady = false
  private publicationPaused = false
  private publicationEpoch = 0
  private mediaIntentVersion = 0
  private desiredCameraEnabled = false
  private desiredScreenShareEnabled = false
  private activeActivationId: string | null = null
  private readonly completedActivationIds = new Set<string>()
  private readonly completedActivationOrder: string[] = []
  private microphoneMuted = false

  constructor(
    private readonly handlers: LiveKitVoiceHandlers = {},
    roomFactory: RoomFactory = (options) => new Room(options),
    encryptionFactory: EncryptionFactory = async () => {
      const keyProvider = new MatrixRtcKeyProvider()
      return {
        keyProvider,
        worker: new Worker(e2eeWorkerUrl, { type: 'module', name: 'mesh-livekit-e2ee' }),
      }
    },
    cuePlayer: VoiceCuePlayer = playMatrixVoiceCue,
  ) {
    this.roomFactory = roomFactory
    this.encryptionFactory = encryptionFactory
    this.cuePlayer = cuePlayer
  }

  async connect(
    credentials: MatrixVoiceCredentials,
    inputDeviceId?: string | null,
    microphoneEnabled = true,
    localMediaKey?: MatrixRtcMediaKey,
    remoteMediaKeys: MatrixRtcMediaKey[] = [],
    initialLease?: MatrixRtcMediaKeyLease,
  ): Promise<void> {
    await this.disconnect(false)
    if (this.encryptionFailureInProgress) {
      throw new Error('Private media encryption failed before the call connected')
    }

    if (!credentials.url.startsWith('wss://')) {
      throw new Error('Calling service returned an insecure media endpoint')
    }
    if (
      !credentials.token ||
      !credentials.mediaE2eeVerified ||
      !credentials.sessionId
    ) {
      throw new Error('Calling service did not return complete encrypted session credentials')
    }
    if (
      !localMediaKey ||
      localMediaKey.roomId !== credentials.roomId ||
      localMediaKey.memberId !== credentials.memberId ||
      localMediaKey.participantIdentity !== credentials.participantIdentity ||
      localMediaKey.sessionId !== null ||
      localMediaKey.activationId !== null
    ) {
      throw new Error('Calling service did not deliver the local participant media key')
    }

    this.credentials = {
      roomId: credentials.roomId,
      roomName: credentials.roomName,
      memberId: credentials.memberId,
      participantIdentity: credentials.participantIdentity,
      sessionId: credentials.sessionId,
      url: credentials.url,
      token: credentials.token,
      mediaE2eeVerified: credentials.mediaE2eeVerified,
    }
    this.microphoneMuted = !microphoneEnabled
    this.desiredCameraEnabled = false
    this.desiredScreenShareEnabled = false
    this.mediaIntentVersion = 0
    this.publicationPaused = false
    this.publicationEpoch = 0
    this.activeActivationId = null
    this.completedActivationIds.clear()
    this.completedActivationOrder.length = 0
    this.mediaKeysReady = false
    this.handlers.onConnectionState?.('connecting', null)

    const encryption = await this.encryptionFactory()
    await encryption.keyProvider.setParticipantKey(localMediaKey)
    this.currentLocalKeyIndex = localMediaKey.keyIndex
    this.keyedParticipantIdentities.add(localMediaKey.participantIdentity)
    this.keyProvider = encryption.keyProvider
    if (
      !initialLease ||
      !this.updatePublicationLease(initialLease, this.publicationEpoch)
    ) {
      throw new Error('Calling service did not provide a valid publication lease')
    }
    const room = this.roomFactory({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      audioCaptureDefaults: {
        ...AUDIO_CAPTURE_OPTIONS,
        deviceId: inputDeviceId || undefined,
      },
      encryption,
    })
    this.room = room
    this.bindRoom(room)

    try {
      if (!this.hasValidPublicationLease()) {
        throw new Error('MatrixRTC publication lease expired before connecting')
      }
      await room.connect(credentials.url, credentials.token, {
        autoSubscribe: false,
      })
      if (this.encryptionFailureInProgress) {
        throw new Error('Private media encryption failed while the call connected')
      }
      if (!room.isE2EEEnabled) {
        throw new Error('Media encryption did not activate')
      }
      if (!this.hasValidPublicationLease()) {
        throw new Error('MatrixRTC publication lease expired while connecting')
      }
      this.mediaKeysReady = true
      for (const mediaKey of remoteMediaKeys) {
        await this.applyMediaKey(mediaKey)
      }
      if (this.encryptionFailureInProgress) {
        throw new Error('Private media encryption failed while keys were applied')
      }
      if (!this.microphoneMuted) {
        if (!this.hasValidPublicationLease()) {
          throw new Error('MatrixRTC publication lease expired before publishing')
        }
        await room.localParticipant.setMicrophoneEnabled(true, {
          ...AUDIO_CAPTURE_OPTIONS,
          deviceId: inputDeviceId || undefined,
        })
      }
      if (this.encryptionFailureInProgress) {
        throw new Error('Private media encryption failed while publishing')
      }
      this.handlers.onConnectionState?.('connected', null)
      this.startLevelMeter(room)
      this.emitPeers(room)
    } catch (error) {
      const failedCredentials = this.credentials
      await this.disconnect(false)
      this.credentials = failedCredentials
      throw error
    }
  }

  async disconnect(notify = true): Promise<void> {
    this.publicationPaused = true
    this.publicationEpoch += 1
    this.clearPublicationLease()
    const room = this.room
    if (this.disconnecting) return
    if (!room) {
      this.credentials = null
      this.keyProvider = null
      this.mediaKeysReady = false
      this.keyedParticipantIdentities.clear()
      this.publicationPaused = false
      this.activeActivationId = null
      this.currentLocalKeyIndex = null
      return
    }

    this.disconnecting = true
    this.stopLevelMeter()
    this.room = null
    try {
      room.removeAllListeners()
      await room.disconnect()
    } finally {
      this.credentials = null
      this.keyProvider = null
      this.mediaKeysReady = false
      this.keyedParticipantIdentities.clear()
      this.publicationPaused = false
      this.activeActivationId = null
      this.currentLocalKeyIndex = null
      this.disconnecting = false
      this.handlers.onPeers?.([])
      this.handlers.onLocalAudioLevel?.(0)
      if (notify) this.handlers.onConnectionState?.('idle', null)
    }
  }

  get canApplyMediaKeys(): boolean {
    return this.mediaKeysReady && this.room !== null && this.keyProvider !== null
  }

  get publicationGeneration(): number {
    return this.publicationEpoch
  }

  get activePublisherActivationId(): string | null {
    return this.activeActivationId
  }

  updatePublicationLease(
    lease: MatrixRtcMediaKeyLease,
    expectedPublicationGeneration: number,
    activationId: string | null = null,
  ): boolean {
    const credentials = this.credentials
    if (
      !credentials ||
      expectedPublicationGeneration !== this.publicationEpoch ||
      lease.roomId !== credentials.roomId ||
      lease.sessionId !== credentials.sessionId ||
      lease.memberId !== credentials.memberId ||
      lease.keyIndex !== this.currentLocalKeyIndex ||
      !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt <= Date.now() ||
      (this.publicationPaused && this.activeActivationId !== activationId)
    ) {
      return false
    }

    const remainingMs = Math.min(
      lease.expiresAt - Date.now(),
      MATRIX_RTC_PUBLICATION_LEASE_MAX_MS,
    )
    const leaseSequence = ++this.publicationLeaseSequence
    this.publicationLeaseDeadline = performance.now() + remainingMs
    if (this.publicationLeaseTimer !== null) {
      clearTimeout(this.publicationLeaseTimer)
    }
    this.publicationLeaseTimer = setTimeout(() => {
      if (
        leaseSequence !== this.publicationLeaseSequence ||
        performance.now() < this.publicationLeaseDeadline
      ) {
        return
      }
      this.publicationPaused = true
      this.publicationEpoch += 1
      void this.failClosedMediaEncryption('Private media publication lease expired')
    }, remainingMs)
    return true
  }

  async applyMediaKey(mediaKey: MatrixRtcMediaKey): Promise<void> {
    const credentials = this.credentials
    const keyProvider = this.keyProvider
    if (!credentials || !this.room || !keyProvider || !this.mediaKeysReady) {
      throw new Error('MatrixRTC media encryption is not initialized')
    }
    if (mediaKey.roomId !== credentials.roomId) {
      throw new Error('MatrixRTC media key belongs to another room')
    }
    if (mediaKey.sessionId !== null || mediaKey.activationId !== null) {
      throw new Error('MatrixRTC activation key cannot be applied as a remote key')
    }
    if (mediaKey.participantIdentity === credentials.participantIdentity) {
      throw new Error('MatrixRTC local media rotations require publisher activation')
    }
    await keyProvider.setParticipantKey(mediaKey)
    this.keyedParticipantIdentities.add(mediaKey.participantIdentity)
    this.subscribeKeyedParticipant(mediaKey.participantIdentity)
  }

  async pausePublisherForActivation(
    pause: MatrixRtcMediaKeyPause,
  ): Promise<PublisherActivationPauseResult> {
    const credentials = this.credentials
    if (
      !credentials ||
      pause.roomId !== credentials.roomId ||
      pause.sessionId !== credentials.sessionId ||
      pause.memberId !== credentials.memberId
    ) {
      return 'ignored'
    }
    if (
      !pause.activationId ||
      !Number.isSafeInteger(pause.keyIndex) ||
      pause.keyIndex < 0 ||
      pause.keyIndex > MAX_MEDIA_KEY_INDEX
    ) {
      throw new Error('MatrixRTC publisher activation metadata is invalid')
    }
    if (this.completedActivationIds.has(pause.activationId)) {
      return 'replayed'
    }
    if (this.activeActivationId === pause.activationId) {
      return 'duplicate'
    }
    if (this.activeActivationId !== null) {
      throw new Error('MatrixRTC publisher activation overlapped another activation')
    }

    this.publicationPaused = true
    this.activeActivationId = pause.activationId
    const pauseEpoch = ++this.publicationEpoch
    this.clearPublicationLease()
    this.handlers.onLocalAudioLevel?.(0)

    await this.enqueueMediaOperation(async () => {
      if (
        pauseEpoch !== this.publicationEpoch ||
        this.activeActivationId !== pause.activationId
      ) {
        throw new Error('MatrixRTC publisher activation became stale')
      }
      const room = this.room
      if (!room) throw new Error('MatrixRTC media room is unavailable')
      const results = await Promise.allSettled([
        room.localParticipant.setMicrophoneEnabled(false),
        room.localParticipant.setCameraEnabled(false),
        room.localParticipant.setScreenShareEnabled(false),
      ])
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('MatrixRTC could not suspend all local media')
      }
      if (
        room.localParticipant.isMicrophoneEnabled ||
        room.localParticipant.isCameraEnabled ||
        room.localParticipant.isScreenShareEnabled
      ) {
        throw new Error('MatrixRTC local media remained published while paused')
      }
      this.emitPeers(room)
    })

    return 'paused'
  }

  async installLocalActivationKey(
    pause: MatrixRtcMediaKeyPause,
    mediaKey: MatrixRtcMediaKey,
  ): Promise<void> {
    const credentials = this.credentials
    const keyProvider = this.keyProvider
    if (
      !credentials ||
      !keyProvider ||
      !this.mediaKeysReady ||
      !this.publicationPaused ||
      this.activeActivationId !== pause.activationId
    ) {
      throw new Error('MatrixRTC publisher activation is not current')
    }
    if (
      mediaKey.roomId !== credentials.roomId ||
      mediaKey.memberId !== credentials.memberId ||
      mediaKey.participantIdentity !== credentials.participantIdentity ||
      mediaKey.sessionId !== credentials.sessionId ||
      mediaKey.activationId !== pause.activationId ||
      mediaKey.keyIndex !== pause.keyIndex
    ) {
      throw new Error('MatrixRTC publisher activation key metadata did not match')
    }
    await keyProvider.setParticipantKey(mediaKey)
    this.currentLocalKeyIndex = mediaKey.keyIndex
  }

  async resumePublisherAfterActivation(activationId: string): Promise<boolean> {
    if (
      !this.publicationPaused ||
      this.activeActivationId !== activationId ||
      this.completedActivationIds.has(activationId)
    ) {
      return false
    }

    const resumeEpoch = this.publicationEpoch
    if (!this.hasValidPublicationLease()) {
      throw new Error('MatrixRTC publication lease is not valid for resume')
    }
    await this.enqueueMediaOperation(async () => {
      const room = this.room
      if (!room) throw new Error('MatrixRTC media room is unavailable')

      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (
          resumeEpoch !== this.publicationEpoch ||
          this.activeActivationId !== activationId
        ) {
          throw new Error('MatrixRTC publisher activation became stale')
        }
        const intentVersion = this.mediaIntentVersion
        if (!this.hasValidPublicationLease()) {
          throw new Error('MatrixRTC publication lease expired during resume')
        }
        await room.localParticipant.setMicrophoneEnabled(
          !this.microphoneMuted,
          AUDIO_CAPTURE_OPTIONS,
        )
        if (
          resumeEpoch !== this.publicationEpoch ||
          !this.hasValidPublicationLease()
        ) {
          throw new Error('MatrixRTC publisher activation became stale')
        }
        await room.localParticipant.setCameraEnabled(
          this.desiredCameraEnabled,
          {
            resolution: {
              width: 1920,
              height: 1080,
              frameRate: 30,
            },
          },
        )
        if (
          resumeEpoch !== this.publicationEpoch ||
          !this.hasValidPublicationLease()
        ) {
          throw new Error('MatrixRTC publisher activation became stale')
        }
        await room.localParticipant.setScreenShareEnabled(
          this.desiredScreenShareEnabled,
          this.screenShareCaptureOptions(),
          this.screenSharePublishOptions(),
        )
        if (
          resumeEpoch !== this.publicationEpoch ||
          !this.hasValidPublicationLease()
        ) {
          throw new Error('MatrixRTC publisher activation became stale')
        }
        if (intentVersion === this.mediaIntentVersion) break
        if (attempt === 7) {
          throw new Error('MatrixRTC media intent did not stabilize')
        }
      }

      if (
        resumeEpoch !== this.publicationEpoch ||
        this.activeActivationId !== activationId
      ) {
        throw new Error('MatrixRTC publisher activation became stale')
      }
      this.publicationPaused = false
      this.activeActivationId = null
      this.rememberCompletedActivation(activationId)
      this.emitPeers(room)
    })
    return true
  }

  async failClosedMediaEncryption(
    reason = 'Private media encryption failed',
  ): Promise<void> {
    if (this.encryptionFailureInProgress) return
    this.encryptionFailureInProgress = true
    this.mediaKeysReady = false
    this.publicationPaused = true
    this.publicationEpoch += 1
    this.clearPublicationLease()

    const retainedCredentials = this.credentials
    const room = this.room
    this.handlers.onConnectionState?.('disconnected', reason)
    this.handlers.onLocalMediaState?.({
      cameraEnabled: false,
      screenShareEnabled: false,
    })
    this.handlers.onLocalAudioLevel?.(0)

    if (room) {
      void room.localParticipant.setMicrophoneEnabled(false).catch(() => {})
      void room.localParticipant.setCameraEnabled(false).catch(() => {})
      void room.localParticipant.setScreenShareEnabled(false).catch(() => {})
    }

    await this.disconnect(false).catch(() => {})
    this.credentials = retainedCredentials
    this.handlers.onEncryptionFailure?.(
      reason,
      retainedCredentials?.sessionId ?? null,
    )
  }

  async setMuted(muted: boolean): Promise<void> {
    this.microphoneMuted = muted
    this.mediaIntentVersion += 1
    if (this.publicationPaused) return
    const operationEpoch = this.publicationEpoch
    await this.enqueueMediaOperation(async () => {
      if (this.publicationPaused || operationEpoch !== this.publicationEpoch) return
      const participant = this.room?.localParticipant
      if (!participant) return
      if (!this.microphoneMuted && !this.hasValidPublicationLease()) return

      const publication = participant.getTrackPublication(Track.Source.Microphone)
      if (!publication) {
        if (!this.microphoneMuted) {
          await participant.setMicrophoneEnabled(true, AUDIO_CAPTURE_OPTIONS)
        }
        return
      }
      if (this.microphoneMuted) {
        await publication.mute()
      } else {
        await publication.unmute()
      }
      this.emitPeers(this.room)
    })
  }

  setDeafened(deafened: boolean): void {
    const room = this.room
    if (!room) return
    for (const participant of room.remoteParticipants.values()) {
      participant.setVolume(deafened ? 0 : (this.participantVolumes.get(participant.identity) ?? 1))
    }
  }

  setParticipantVolume(identity: string, volume: number): void {
    const normalized = Math.max(0, Math.min(2, volume))
    this.participantVolumes.set(identity, normalized)
    this.room?.remoteParticipants.get(identity)?.setVolume(normalized)
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    this.desiredCameraEnabled = enabled
    this.mediaIntentVersion += 1
    if (this.publicationPaused) return
    const operationEpoch = this.publicationEpoch
    await this.enqueueMediaOperation(async () => {
      if (this.publicationPaused || operationEpoch !== this.publicationEpoch) return
      const room = this.room
      if (!room) return
      if (this.desiredCameraEnabled && !this.hasValidPublicationLease()) return
      await room.localParticipant.setCameraEnabled(this.desiredCameraEnabled, {
        resolution: {
          width: 1920,
          height: 1080,
          frameRate: 30,
        },
      })
      this.emitPeers(room)
    })
  }

  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    this.desiredScreenShareEnabled = enabled
    this.mediaIntentVersion += 1
    if (this.publicationPaused) return
    const operationEpoch = this.publicationEpoch
    await this.enqueueMediaOperation(async () => {
      if (this.publicationPaused || operationEpoch !== this.publicationEpoch) return
      const room = this.room
      if (!room) return
      if (this.desiredScreenShareEnabled && !this.hasValidPublicationLease()) return
      await room.localParticipant.setScreenShareEnabled(
        this.desiredScreenShareEnabled,
        this.screenShareCaptureOptions(),
        this.screenSharePublishOptions(),
      )
      this.emitPeers(room)
    })
  }

  async switchInputDevice(deviceId: string): Promise<boolean> {
    return this.room?.switchActiveDevice('audioinput', deviceId, true) ?? false
  }

  async switchOutputDevice(deviceId: string): Promise<boolean> {
    return this.room?.switchActiveDevice('audiooutput', deviceId, true) ?? false
  }

  async getDevices(requestPermissions = false): Promise<VoiceDevice[]> {
    const [inputs, outputs] = await Promise.all([
      Room.getLocalDevices('audioinput', requestPermissions),
      Room.getLocalDevices('audiooutput', requestPermissions),
    ])

    return [...inputs, ...outputs].map((device, index) => ({
      deviceId: device.deviceId,
      kind: device.kind as VoiceDevice['kind'],
      label:
        device.label ||
        `${device.kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${index + 1}`,
    }))
  }

  async getStats(): Promise<LiveKitVoiceStats> {
    const room = this.room
    if (!room) return { latencyMs: null, quality: 'unknown' }

    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone)
    const senderStats = await publication?.audioTrack?.getSenderStats()
    const quality = room.localParticipant.connectionQuality

    return {
      latencyMs:
        typeof senderStats?.roundTripTime === 'number'
          ? Math.max(0, Math.round(senderStats.roundTripTime * 1000))
          : null,
      quality:
        quality === ConnectionQuality.Excellent
          ? 'excellent'
          : quality === ConnectionQuality.Good
            ? 'good'
            : quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost
              ? 'poor'
              : 'unknown',
    }
  }

  get sessionId(): string | null {
    return this.credentials?.sessionId ?? null
  }

  private bindRoom(room: Room): void {
    room
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        this.handlers.onConnectionState?.(connectionState(state), null)
      })
      .on(RoomEvent.Reconnecting, () => {
        this.handlers.onConnectionState?.('reconnecting', 'network interruption')
      })
      .on(RoomEvent.Reconnected, () => {
        this.handlers.onConnectionState?.('connected', null)
      })
      .on(RoomEvent.Disconnected, () => {
        if (!this.disconnecting) {
          this.handlers.onConnectionState?.('disconnected', 'call ended')
        }
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        if (participant.identity !== room.localParticipant.identity) {
          this.playCue('join')
        }
        this.subscribeKeyedParticipant(participant.identity)
        this.emitPeers(room)
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (participant.identity !== room.localParticipant.identity) {
          this.playCue('leave')
        }
        this.emitPeers(room)
      })
      .on(RoomEvent.ParticipantNameChanged, () => this.emitPeers(room))
      .on(RoomEvent.ParticipantMetadataChanged, () => this.emitPeers(room))
      .on(RoomEvent.ParticipantAttributesChanged, () => this.emitPeers(room))
      .on(RoomEvent.ConnectionQualityChanged, () => this.emitPeers(room))
      .on(RoomEvent.TrackSubscribed, (_track: RemoteTrack) => this.emitPeers(room))
      .on(RoomEvent.TrackUnsubscribed, () => this.emitPeers(room))
      .on(RoomEvent.TrackPublished, (publication, participant) => {
        if (this.keyedParticipantIdentities.has(participant.identity)) {
          publication.setSubscribed(true)
        }
      })
      .on(RoomEvent.LocalTrackPublished, () => {
        this.syncDesiredVideoIntent(room)
        this.emitPeers(room)
      })
      .on(RoomEvent.LocalTrackUnpublished, () => {
        this.syncDesiredVideoIntent(room)
        this.emitPeers(room)
      })
      .on(RoomEvent.TrackMuted, () => this.emitPeers(room))
      .on(RoomEvent.TrackUnmuted, () => this.emitPeers(room))
      .on(RoomEvent.ActiveSpeakersChanged, () => this.emitPeers(room))
      .on(RoomEvent.MediaDevicesChanged, () => this.handlers.onDevicesChanged?.())
      .on(RoomEvent.MediaDevicesError, (error) => this.handlers.onError?.(error))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        this.handlers.onWarning?.(
          room.canPlaybackAudio
            ? null
            : 'Audio playback is blocked. Interact with the window, then try again.',
        )
      })
      .on(RoomEvent.EncryptionError, () => {
        void this.failClosedMediaEncryption()
      })
      .on(RoomEvent.ParticipantEncryptionStatusChanged, (encrypted) => {
        if (!encrypted) {
          void this.failClosedMediaEncryption(
            'A call participant is not using private media encryption',
          )
        }
      })
  }

  private playCue(cue: 'join' | 'leave'): void {
    try {
      void Promise.resolve(this.cuePlayer(cue)).catch(() => {})
    } catch {
      // Join and leave updates are authoritative even when audio playback is blocked.
    }
  }

  private enqueueMediaOperation(operation: () => Promise<void>): Promise<void> {
    const scheduled = this.mediaOperationQueue.then(operation)
    this.mediaOperationQueue = scheduled.catch(() => {})
    return scheduled
  }

  private hasValidPublicationLease(): boolean {
    return (
      this.publicationLeaseDeadline > 0 &&
      performance.now() < this.publicationLeaseDeadline
    )
  }

  private clearPublicationLease(): void {
    this.publicationLeaseSequence += 1
    this.publicationLeaseDeadline = 0
    if (this.publicationLeaseTimer !== null) {
      clearTimeout(this.publicationLeaseTimer)
      this.publicationLeaseTimer = null
    }
  }

  private screenShareCaptureOptions() {
    return {
      audio: true,
      resolution: {
        width: 1920,
        height: 1080,
        frameRate: 60,
      },
      contentHint: 'detail' as const,
      surfaceSwitching: 'include' as const,
      systemAudio: 'include' as const,
    }
  }

  private screenSharePublishOptions() {
    return {
      screenShareEncoding: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
      },
    }
  }

  private syncDesiredVideoIntent(room: Room): void {
    if (this.publicationPaused) return
    this.desiredCameraEnabled = room.localParticipant.isCameraEnabled
    this.desiredScreenShareEnabled = room.localParticipant.isScreenShareEnabled
  }

  private rememberCompletedActivation(activationId: string): void {
    this.completedActivationIds.add(activationId)
    this.completedActivationOrder.push(activationId)
    if (this.completedActivationOrder.length > 32) {
      const oldest = this.completedActivationOrder.shift()
      if (oldest) this.completedActivationIds.delete(oldest)
    }
  }

  private subscribeKeyedParticipant(identity: string): void {
    if (!this.keyedParticipantIdentities.has(identity)) return
    const participant = this.room?.remoteParticipants.get(identity)
    if (!participant) return
    for (const publication of participant.trackPublications.values()) {
      publication.setSubscribed(true)
    }
  }

  private emitPeers(room: Room | null): void {
    if (!room) return
    const peers = [
      peerFromParticipant(room.localParticipant, room.localParticipant),
      ...[...room.remoteParticipants.values()].map((participant: RemoteParticipant) =>
        peerFromParticipant(participant, room.localParticipant),
      ),
    ]
    this.handlers.onPeers?.(peers)
    this.handlers.onLocalMediaState?.({
      cameraEnabled: this.publicationPaused
        ? this.desiredCameraEnabled
        : room.localParticipant.isCameraEnabled,
      screenShareEnabled: this.publicationPaused
        ? this.desiredScreenShareEnabled
        : room.localParticipant.isScreenShareEnabled,
    })
  }

  private startLevelMeter(room: Room): void {
    this.stopLevelMeter()
    this.levelTimer = setInterval(() => {
      this.handlers.onLocalAudioLevel?.(room.localParticipant.audioLevel)
    }, 100)
  }

  private stopLevelMeter(): void {
    if (this.levelTimer) {
      clearInterval(this.levelTimer)
      this.levelTimer = null
    }
  }
}
