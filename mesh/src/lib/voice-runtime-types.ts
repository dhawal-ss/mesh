import type {
  MatrixRtcMediaKey,
  MatrixRtcMediaKeyLease,
  MatrixRtcMediaKeyPause,
} from './bridge'
import type {
  Peer,
  VoiceConnectionState,
  VoiceSessionEvent,
  VoiceSessionSnapshot,
  VoiceSignalEvent,
} from '../types/ipc'

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

export type PublisherActivationPauseResult = 'paused' | 'duplicate' | 'replayed' | 'ignored'

export interface LiveKitVoiceEngineRuntime {
  readonly sessionId: string | null
  readonly canApplyMediaKeys: boolean
  readonly publicationGeneration: number
  readonly activePublisherActivationId: string | null
  connect(
    credentials: {
      roomId: string
      roomName: string
      memberId: string
      participantIdentity: string
      sessionId: string
      url: string
      token: string
      mediaE2eeReady: boolean
    },
    inputDeviceId?: string | null,
    publishMicrophone?: boolean,
    localMediaKey?: MatrixRtcMediaKey | null,
    initialMediaKeys?: MatrixRtcMediaKey[],
    publicationLease?: MatrixRtcMediaKeyLease | null,
  ): Promise<void>
  disconnect(notify?: boolean): Promise<void>
  updatePublicationLease(
    lease: MatrixRtcMediaKeyLease,
    expectedGeneration: number,
    activationId?: string | null,
  ): boolean
  applyMediaKey(mediaKey: MatrixRtcMediaKey): Promise<void>
  pausePublisherForActivation(pause: MatrixRtcMediaKeyPause): Promise<PublisherActivationPauseResult>
  installLocalActivationKey(pause: MatrixRtcMediaKeyPause, mediaKey: MatrixRtcMediaKey): Promise<void>
  resumePublisherAfterActivation(activationId: string): Promise<boolean>
  failClosedMediaEncryption(reason?: string): Promise<void>
  setMuted(muted: boolean): Promise<void>
  setDeafened(deafened: boolean): void
  setParticipantVolume(identity: string, volume: number): void
  setCameraEnabled(enabled: boolean): Promise<void>
  setScreenShareEnabled(enabled: boolean): Promise<void>
  switchInputDevice(deviceId: string): Promise<boolean>
  switchOutputDevice(deviceId: string): Promise<boolean>
  getDevices(requestPermissions?: boolean): Promise<VoiceDevice[]>
  getStats(): Promise<LiveKitVoiceStats>
}

export interface LegacyVoiceEngineHandlers {
  onSessionSnapshot?: (snapshot: VoiceSessionSnapshot) => void
  onPeerUpsert?: (peer: Peer) => void
  onPeerRemove?: (publicKey: string) => void
  onConnectionState?: (state: VoiceConnectionState, reason?: string | null) => void
  onError?: (message: string) => void
  onRelayChanged?: () => void
  onConnectionWarning?: (message: string) => void
}

export interface LegacyVoiceEngineRuntime {
  start(): Promise<VoiceSessionSnapshot | null>
  destroy(): Promise<void>
  applySessionSnapshot(snapshot: VoiceSessionSnapshot): void
  applySessionEvent(event: VoiceSessionEvent): void
  handleVoiceSignal(event: VoiceSignalEvent): void
  handleLegacyJoin(payload: { author?: string; communityId?: string; channelId?: string }): void
  handleLegacyLeave(payload: { author?: string; communityId?: string; channelId?: string }): void
  setMuted(muted: boolean): void
}

export type LiveKitVoiceEngineConstructor = new (
  handlers?: LiveKitVoiceHandlers,
) => LiveKitVoiceEngineRuntime

export type LegacyVoiceEngineConstructor = new (
  communityId: string,
  channelId: string,
  handlers?: LegacyVoiceEngineHandlers,
) => LegacyVoiceEngineRuntime
