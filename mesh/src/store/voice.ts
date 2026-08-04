import { create } from 'zustand'
import type { Peer, VoiceConnectionState, VoiceSessionSnapshot } from '../types/ipc'
import type { MatrixRtcMember } from '../lib/bridge'
import { beginVoiceActivation, clearVoiceActivation } from '../lib/voice-activation'
import {
  buildPeerFromMember,
  normalizeVoiceSessionSnapshot,
  shortVoiceLabel,
} from '../lib/voice-session'

interface VoiceStore {
  currentChannelId: string | null
  currentCommunityId: string | null
  localPublicKey: string | null
  sessionSnapshot: VoiceSessionSnapshot | null
  peers: Peer[]
  connectionState: VoiceConnectionState
  lastReconnectReason: string | null
  isMuted: boolean
  isDeafened: boolean
  inputMode: 'voice-activity' | 'push-to-talk'
  isPushToTalking: boolean
  isCameraEnabled: boolean
  isScreenSharing: boolean
  inputDeviceId: string | null
  outputDeviceId: string | null
  localAudioLevel: number
  participantVolumes: Record<string, number>
  matrixRtcMembersByRoom: Record<string, MatrixRtcMember[]>
  setCurrentVoiceSession: (communityId: string | null, channelId: string | null) => void
  setLocalPublicKey: (publicKey: string | null) => void
  setSessionSnapshot: (snapshot: VoiceSessionSnapshot | null) => void
  upsertPeer: (peer: Peer) => void
  removePeer: (publicKey: string) => void
  setPeers: (peers: Peer[]) => void
  setConnectionState: (state: VoiceConnectionState, reason?: string | null) => void
  setMuted: (muted: boolean) => void
  setDeafened: (deafened: boolean) => void
  setInputMode: (mode: 'voice-activity' | 'push-to-talk') => void
  setPushToTalking: (talking: boolean) => void
  setCameraEnabled: (enabled: boolean) => void
  setScreenSharing: (sharing: boolean) => void
  setInputDeviceId: (deviceId: string | null) => void
  setOutputDeviceId: (deviceId: string | null) => void
  setLocalAudioLevel: (level: number) => void
  setParticipantVolume: (publicKey: string, volume: number) => void
  setMatrixRtcMembers: (roomId: string, members: MatrixRtcMember[]) => void
  resetVoiceState: () => void
}

const MAX_MATRIX_RTC_ROOMS = 100
const MAX_MATRIX_RTC_MEMBERS_PER_ROOM = 100

function isStreamActive(stream: MediaStream): boolean {
  return stream.getAudioTracks().some((track) => track.readyState === 'live')
}

function mergePeerRecord(
  existing: Peer | undefined,
  next: Peer,
  mediaSnapshotIsAuthoritative = false,
): Peer {
  const peer = existing ?? next

  return {
    publicKey: next.publicKey,
    peerId: next.peerId ?? peer.peerId ?? next.publicKey,
    displayName: next.displayName || peer.displayName || shortVoiceLabel(next.publicKey),
    avatarColor: next.avatarColor || peer.avatarColor || 'var(--avatar-sand)',
    latency: Number.isFinite(next.latency) ? next.latency : peer.latency ?? 0,
    stream: next.stream ?? (peer.stream && isStreamActive(peer.stream) ? peer.stream : undefined),
    cameraStream: mediaSnapshotIsAuthoritative ? next.cameraStream : next.cameraStream ?? peer.cameraStream,
    screenShareStream: mediaSnapshotIsAuthoritative
      ? next.screenShareStream
      : next.screenShareStream ?? peer.screenShareStream,
    screenShareAudioStream: mediaSnapshotIsAuthoritative
      ? next.screenShareAudioStream
      : next.screenShareAudioStream ?? peer.screenShareAudioStream,
    role: next.role ?? peer.role ?? (next.isRelay ? 'relay' : 'member'),
    connectionState: next.connectionState ?? peer.connectionState ?? 'connected',
    joinedAt: next.joinedAt ?? peer.joinedAt,
    lastSeenAt: next.lastSeenAt ?? peer.lastSeenAt,
    isSelf: next.isSelf ?? peer.isSelf ?? false,
    isLocal: next.isLocal ?? peer.isLocal ?? false,
    isRelay: next.isRelay ?? peer.isRelay ?? false,
    speaking: next.speaking ?? peer.speaking ?? false,
  }
}

function buildSessionPeers(snapshot: VoiceSessionSnapshot, currentPeers: Peer[]): Peer[] {
  const byPublicKey = new Map(currentPeers.map((peer) => [peer.publicKey, peer] as const))

  return snapshot.members.map((member) => {
    const existing = byPublicKey.get(member.publicKey)
    return buildPeerFromMember(member, existing)
  })
}

export const useVoiceStore = create<VoiceStore>((set) => ({
  currentChannelId: null,
  currentCommunityId: null,
  localPublicKey: null,
  sessionSnapshot: null,
  peers: [],
  connectionState: 'idle',
  lastReconnectReason: null,
  isMuted: false,
  isDeafened: false,
  inputMode: 'voice-activity',
  isPushToTalking: false,
  isCameraEnabled: false,
  isScreenSharing: false,
  inputDeviceId: null,
  outputDeviceId: null,
  localAudioLevel: 0,
  participantVolumes: {},
  matrixRtcMembersByRoom: {},
  setCurrentVoiceSession: (communityId, channelId) =>
    set((state) => {
      if (channelId === null || communityId === null) {
        if (state.currentChannelId) clearVoiceActivation(state.currentChannelId)
        return {
          currentChannelId: null,
          currentCommunityId: null,
          sessionSnapshot: null,
          peers: [],
          connectionState: 'idle',
          lastReconnectReason: null,
        }
      }

      const sameSession =
        state.currentCommunityId === communityId && state.currentChannelId === channelId

      if (!sameSession) beginVoiceActivation(channelId)

      return {
        currentChannelId: channelId,
        currentCommunityId: communityId,
        sessionSnapshot: sameSession ? state.sessionSnapshot : null,
        peers: sameSession ? state.peers : [],
        connectionState: sameSession ? state.connectionState : 'connecting',
        lastReconnectReason: sameSession ? state.lastReconnectReason : null,
      }
    }),
  setLocalPublicKey: (localPublicKey) => set({ localPublicKey }),
  setSessionSnapshot: (snapshot) =>
    set((state) => {
      if (!snapshot) {
        return {
          sessionSnapshot: null,
          peers: [],
          connectionState: 'idle',
          lastReconnectReason: null,
        }
      }

      const normalized = normalizeVoiceSessionSnapshot(snapshot, state.localPublicKey)
      const previousEpoch = state.sessionSnapshot?.sessionEpoch ?? null
      const nextPeers = buildSessionPeers(normalized, state.peers)
      const epochChanged = previousEpoch !== null && previousEpoch !== normalized.sessionEpoch

      return {
        sessionSnapshot: normalized,
        localPublicKey: normalized.localPublicKey ?? state.localPublicKey,
        peers: nextPeers,
        connectionState: epochChanged ? 'reconnecting' : state.connectionState,
        lastReconnectReason: epochChanged ? 'epoch change' : state.lastReconnectReason,
      }
    }),
  upsertPeer: (peer) =>
    set((state) => {
      const existing = state.peers.find((item) => item.publicKey === peer.publicKey)
      const merged = mergePeerRecord(existing, peer)

      return {
        peers: existing
          ? state.peers.map((item) => (item.publicKey === peer.publicKey ? merged : item))
          : [...state.peers, merged],
      }
    }),
  removePeer: (publicKey) =>
    set((state) => ({
      peers: state.peers.filter((peer) => peer.publicKey !== publicKey),
    })),
  setPeers: (peers) =>
    set((state) => ({
      peers: peers.map((peer) =>
        mergePeerRecord(
          state.peers.find((item) => item.publicKey === peer.publicKey),
          peer,
          true,
        ),
      ),
    })),
  setConnectionState: (connectionState, reason = null) =>
    set({
      connectionState,
      lastReconnectReason: reason,
    }),
  setMuted: (isMuted) => set({ isMuted }),
  setDeafened: (isDeafened) => set({ isDeafened }),
  setInputMode: (inputMode) =>
    set({
      inputMode,
      isPushToTalking: false,
      isMuted: inputMode === 'push-to-talk',
    }),
  setPushToTalking: (isPushToTalking) => set({ isPushToTalking }),
  setCameraEnabled: (isCameraEnabled) => set({ isCameraEnabled }),
  setScreenSharing: (isScreenSharing) => set({ isScreenSharing }),
  setInputDeviceId: (inputDeviceId) => set({ inputDeviceId }),
  setOutputDeviceId: (outputDeviceId) => set({ outputDeviceId }),
  setLocalAudioLevel: (localAudioLevel) =>
    set({ localAudioLevel: Math.max(0, Math.min(1, localAudioLevel)) }),
  setParticipantVolume: (publicKey, volume) =>
    set((state) => ({
      participantVolumes: {
        ...state.participantVolumes,
        [publicKey]: Math.max(0, Math.min(2, volume)),
      },
    })),
  setMatrixRtcMembers: (roomId, members) =>
    set((state) => {
      const next = { ...state.matrixRtcMembersByRoom }
      const authoritativeMembers = members
        .filter((member) => member.roomId === roomId)
        .slice(0, MAX_MATRIX_RTC_MEMBERS_PER_ROOM)

      if (authoritativeMembers.length === 0) {
        delete next[roomId]
        return { matrixRtcMembersByRoom: next }
      }

      if (!(roomId in next) && Object.keys(next).length >= MAX_MATRIX_RTC_ROOMS) {
        const oldestRoomId = Object.keys(next)[0]
        delete next[oldestRoomId]
      }
      next[roomId] = authoritativeMembers
      return { matrixRtcMembersByRoom: next }
    }),
  resetVoiceState: () => {
    clearVoiceActivation()
    set({
      currentChannelId: null,
      currentCommunityId: null,
      localPublicKey: null,
      sessionSnapshot: null,
      peers: [],
      connectionState: 'idle',
      lastReconnectReason: null,
      isPushToTalking: false,
      isCameraEnabled: false,
      isScreenSharing: false,
      localAudioLevel: 0,
      participantVolumes: {},
    })
  },
}))

export function setVoiceSessionFromSnapshot(snapshot: VoiceSessionSnapshot | null) {
  useVoiceStore.getState().setSessionSnapshot(snapshot)
}

export function setVoiceSessionPeers(peers: Peer[]) {
  useVoiceStore.getState().setPeers(peers)
}
