import SimplePeer from 'simple-peer'
import {
  getIdentity,
  getIceServers,
  isTauriRuntime,
  joinVoice,
  leaveVoice,
  sendVoiceSignal,
} from './bridge'
import { describeError } from './errors'
import {
  buildPeerFromMember,
  normalizeVoiceMember,
  normalizeVoiceSessionSnapshot,
  shouldConnectToPeer,
  shouldInitiatePeerConnection,
  shortVoiceLabel,
  voiceColorForKey,
} from './voice-session'
import {
  DefaultVoicePeerFactory,
  type VoicePeer,
  type VoicePeerFactory,
} from './voice-peer'
import type {
  Peer,
  VoiceConnectionState,
  VoiceMemberSnapshot,
  VoiceSessionEvent,
  VoiceSessionSnapshot,
  VoiceSignalEvent,
} from '../types/ipc'

type PeerConnectionRecord = {
  peer: VoicePeer
  initiator: boolean
}

// Reconnect attempt counts per peer for exponential backoff
const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 10_000

export interface VoiceEngineHandlers {
  onSessionSnapshot?: (snapshot: VoiceSessionSnapshot) => void
  onPeerUpsert?: (peer: Peer) => void
  onPeerRemove?: (publicKey: string) => void
  onConnectionState?: (state: VoiceConnectionState, reason?: string | null) => void
  onError?: (message: string) => void
  onRelayChanged?: () => void
  onConnectionWarning?: (message: string) => void
}

export class VoiceEngine {
  private readonly peers = new Map<string, PeerConnectionRecord>()
  private readonly peerViews = new Map<string, Peer>()
  private localStream: MediaStream | null = null
  private localPublicKey: string | null = null
  private sessionSnapshot: VoiceSessionSnapshot | null = null
  private topologyRebuildTimer: number | null = null
  private readonly peerReconnectTimers = new Map<string, number>()
  private readonly peerReconnectAttempts = new Map<string, number>()
  // Relay peer stores incoming streams from other peers to forward to new connections
  private readonly relayReceivedStreams = new Map<string, MediaStream>()
  private destroyed = false
  private iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  private audioContext: AudioContext | null = null
  private readonly audioAnalysers = new Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode; interval: number }>()
  // Debounced relay-failover rebuild state. When multiple peers depart rapidly
  // we coalesce the rebuilds into a single bounded operation to avoid thrashing.
  private relayRebuildPending = false
  private relayRebuildTimer: number | null = null
  private relayRebuildCount = 0
  private lastRelayKey: string | null = null
  // Injectable seam for peer creation: tests pass a FakeVoicePeerFactory.
  private readonly peerFactory: VoicePeerFactory

  constructor(
    private readonly communityId: string,
    private readonly channelId: string,
    private readonly handlers: VoiceEngineHandlers = {},
    peerFactory?: VoicePeerFactory,
  ) {
    this.peerFactory = peerFactory ?? new DefaultVoicePeerFactory()
  }

  async loadIceServers(): Promise<void> {
    try {
      const servers = await getIceServers()
      this.iceServers = servers.map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      }))

      // Check if any TURN server is configured
      const hasTurn = this.iceServers.some((s) =>
        (Array.isArray(s.urls) ? s.urls : [s.urls]).some(
          (u) => typeof u === 'string' && u.startsWith('turn:'),
        ),
      )
      if (!hasTurn) {
        console.warn('[VoiceEngine] No TURN server configured. Voice may fail behind strict NATs.')
        this.handlers.onConnectionWarning?.(
          'Voice may not connect on this network. Try another network or ask the community owner for help.',
        )
      }
    } catch (e) {
      console.warn('Failed to load ICE servers, using defaults:', e)
      this.handlers.onConnectionWarning?.(
        'Voice setup could not be checked. Messages still work; try voice again later.',
      )
    }
  }

  async start(): Promise<VoiceSessionSnapshot | null> {
    this.destroyed = false
    this.handlers.onConnectionState?.('connecting')

    await this.loadIceServers()

    const identity = await getIdentity().catch(() => null)
    this.localPublicKey = identity?.publicKey ?? null

    if (!this.localPublicKey) {
      this.handlers.onError?.('No local identity is available for voice')
      this.handlers.onConnectionState?.('disconnected', 'missing identity')
      return null
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48_000 },
        video: false,
      })
      this.startSpeakingDetection(this.localPublicKey, this.localStream)
      this.handlers.onConnectionState?.('connecting')
    } catch (error) {
      this.localStream = null
      const description = describeError(error, {
        operation: 'start voice',
        mediaKind: 'microphone',
      })
      this.handlers.onConnectionWarning?.(`${description.title}. ${description.body}`)
      this.handlers.onConnectionState?.('degraded', 'microphone unavailable')
      console.error('VoiceEngine: microphone access failed, continuing in receive-only mode', error)
    }

    if (!isTauriRuntime()) {
      const snapshot = normalizeVoiceSessionSnapshot(
        {
          communityId: this.communityId,
          channelId: this.channelId,
          sessionEpoch: Date.now(),
          memberCount: 1,
          members: [
            normalizeVoiceMember({
              publicKey: this.localPublicKey,
              isLocal: true,
              displayName: identity?.displayName ?? shortVoiceLabel(this.localPublicKey),
              avatarColor: identity?.avatarColor ?? voiceColorForKey(this.localPublicKey),
              joinedAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
            }),
          ],
          relay: { relayRequired: false, relayCandidatePublicKey: null },
          updatedAt: new Date().toISOString(),
          localPublicKey: this.localPublicKey,
        },
        this.localPublicKey,
      )

      this.applySessionSnapshot(snapshot)
      this.handlers.onConnectionState?.('connected')
      return snapshot
    }

    const snapshot = await joinVoice(this.communityId, this.channelId).catch((error) => {
      console.error('Failed to join voice room:', error)
      const description = describeError(error, { operation: 'join this voice room' })
      const message = `${description.title}. ${description.body}`
      this.handlers.onError?.(message)
      this.handlers.onConnectionState?.('disconnected', message)
      return null
    })

    if (snapshot) {
      this.applySessionSnapshot(snapshot)
      this.handlers.onConnectionState?.(this.sessionSnapshot?.memberCount ? 'connected' : 'connecting')
    }

    return snapshot
  }

  /**
   * Test-only entry point: initializes the engine with a known local public
   * key and no real media stream, bypassing the getUserMedia/joinVoice flow.
   * Enables integration tests to drive the engine with a FakeVoicePeerFactory
   * without requiring a browser WebRTC environment.
   *
   * Do not use in production code paths: always call `start()`.
   */
  initForTesting(localPublicKey: string): void {
    this.destroyed = false
    this.localPublicKey = localPublicKey
    this.localStream = null
    // Use a stable default ICE config so tests are deterministic
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]
  }

  /**
   * Test-only accessor: returns the set of peer public keys the engine
   * currently has connections to.
   */
  getPeerKeysForTesting(): string[] {
    return Array.from(this.peers.keys())
  }

  /**
   * Test-only accessor: returns the underlying VoicePeer for a given remote
   * public key, if present. Used to drive peer event simulation.
   */
  getPeerForTesting(remotePublicKey: string): VoicePeer | undefined {
    return this.peers.get(remotePublicKey)?.peer
  }

  applySessionSnapshot(snapshot: VoiceSessionSnapshot): void {
    if (
      this.destroyed ||
      snapshot.communityId !== this.communityId ||
      snapshot.channelId !== this.channelId
    ) {
      return
    }

    const normalized = normalizeVoiceSessionSnapshot(snapshot, this.localPublicKey)
    if (this.isSameSnapshot(normalized, this.sessionSnapshot)) {
      return
    }

    const previousRelay = this.sessionSnapshot?.relay.relayCandidatePublicKey ?? null
    const nextRelay = normalized.relay.relayCandidatePublicKey ?? null
    const epochChanged =
      this.sessionSnapshot !== null &&
      this.sessionSnapshot.sessionEpoch !== normalized.sessionEpoch
    const topologyChanged = epochChanged || previousRelay !== nextRelay

    this.sessionSnapshot = normalized
    this.syncPeerViews(normalized)
    this.handlers.onSessionSnapshot?.(normalized)

    if (topologyChanged) {
      this.handlers.onConnectionState?.('reconnecting', epochChanged ? 'session epoch changed' : 'relay candidate changed')
      this.resetPeerConnections()
      this.scheduleRebuild(normalized)
      return
    }

    this.reconcilePeerConnections(normalized)
    this.handlers.onConnectionState?.(normalized.memberCount > 0 ? 'connected' : 'connecting')
  }

  applySessionEvent(event: VoiceSessionEvent): void {
    if (event.communityId !== this.communityId || event.channelId !== this.channelId || this.destroyed) {
      return
    }

    this.applySessionSnapshot(event.snapshot)
  }

  handleLegacyJoin(payload: { author?: string; communityId?: string; channelId?: string }): void {
    const author = payload.author?.trim()
    if (
      !author ||
      payload.communityId !== this.communityId ||
      payload.channelId !== this.channelId ||
      author === this.localPublicKey ||
      this.sessionSnapshot
    ) {
      return
    }

    const snapshot = this.buildSyntheticSnapshot([author], [])
    this.applySessionSnapshot(snapshot)
  }

  handleLegacyLeave(payload: { author?: string; communityId?: string; channelId?: string }): void {
    const author = payload.author?.trim()
    if (
      !author ||
      payload.communityId !== this.communityId ||
      payload.channelId !== this.channelId ||
      !this.sessionSnapshot
    ) {
      return
    }

    const members = this.sessionSnapshot.members.filter((member) => member.publicKey !== author)
    this.applySessionSnapshot(
      normalizeVoiceSessionSnapshot(
        {
          ...this.sessionSnapshot,
          members,
          memberCount: members.length,
          sessionEpoch: this.sessionSnapshot.sessionEpoch + 1,
          updatedAt: new Date().toISOString(),
        },
        this.localPublicKey,
      ),
    )
  }

  handleVoiceSignal(event: VoiceSignalEvent): void {
    if (this.destroyed || !this.localPublicKey) {
      return
    }

    if (event.communityId !== this.communityId || event.channelId !== this.channelId) {
      return
    }

    const remotePublicKey = event.sourcePublicKey
    const signal = event.signal

    if (!remotePublicKey || remotePublicKey === this.localPublicKey || !signal) {
      return
    }

    if (event.targetPeer && event.targetPeer !== this.localPublicKey) {
      return
    }

    const peer = this.ensurePeerConnection(remotePublicKey, false)
    peer.signal(signal as SimplePeer.SignalData)
  }

  setMuted(muted: boolean): void {
    if (!this.localStream) {
      return
    }

    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !muted
    }
  }

  async getConnectionStats(): Promise<{
    type: 'direct' | 'relay' | 'unknown'
    localCandidate: string
    remoteCandidate: string
    roundTripTime: number
    packetsLost: number
    jitter: number
  } | null> {
    // Get stats from the first connected peer
    for (const [, record] of this.peers) {
      if (!record.peer.connected) continue
      const pc = (record.peer as unknown as { _pc: RTCPeerConnection })._pc
      if (!pc) continue

      const stats = await pc.getStats()
      for (const report of stats.values()) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const localId = report.localCandidateId
          const remoteId = report.remoteCandidateId
          let localType = 'unknown'
          let remoteType = 'unknown'
          for (const r of stats.values()) {
            if (r.id === localId) localType = r.candidateType
            if (r.id === remoteId) remoteType = r.candidateType
          }
          return {
            type: (localType === 'relay' || remoteType === 'relay') ? 'relay' : 'direct',
            localCandidate: localType,
            remoteCandidate: remoteType,
            roundTripTime: (report.currentRoundTripTime ?? 0) * 1000,
            packetsLost: report.packetsLost ?? 0,
            jitter: report.jitter ?? 0,
          }
        }
      }
    }
    return null
  }

  async destroy(): Promise<void> {
    this.destroyed = true

    if (this.topologyRebuildTimer !== null) {
      window.clearTimeout(this.topologyRebuildTimer)
      this.topologyRebuildTimer = null
    }

    if (this.relayRebuildTimer !== null) {
      window.clearTimeout(this.relayRebuildTimer)
      this.relayRebuildTimer = null
    }
    this.relayRebuildPending = false

    for (const timer of this.peerReconnectTimers.values()) {
      window.clearTimeout(timer)
    }
    this.peerReconnectTimers.clear()

    for (const publicKey of this.audioAnalysers.keys()) {
      this.stopSpeakingDetection(publicKey)
    }

    this.stopAllRelayReceivedStreams()

    if (this.audioContext) {
      this.audioContext.close().catch(() => {})
      this.audioContext = null
    }

    for (const record of this.peers.values()) {
      record.peer.destroy()
    }
    this.peers.clear()
    this.peerViews.clear()
    this.peerReconnectAttempts.clear()
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop())
      this.localStream = null
    }

    if (isTauriRuntime()) {
      await leaveVoice(this.communityId, this.channelId).catch((error) => {
        console.error('VoiceEngine: failed to leave voice room cleanly', error)
      })
    }

    this.handlers.onConnectionState?.('disconnected')
  }

  private reconcilePeerConnections(snapshot: VoiceSessionSnapshot): void {
    if (!this.localPublicKey) {
      return
    }

    const relayPublicKey = snapshot.relay.relayCandidatePublicKey ?? snapshot.relayElection?.relayPublicKey ?? null
    const memberKeys = new Set(snapshot.members.map((member) => member.publicKey))

    for (const member of snapshot.members) {
      if (member.publicKey === this.localPublicKey) {
        continue
      }

      const shouldConnect = shouldConnectToPeer(
        this.localPublicKey,
        member.publicKey,
        relayPublicKey,
        snapshot.memberCount,
      )

      if (!shouldConnect) {
        const existing = this.peers.get(member.publicKey)
        if (existing) {
          this.stopRelayReceivedStream(member.publicKey)
          existing.peer.destroy()
          this.peers.delete(member.publicKey)
        }
        continue
      }

      const shouldInitiate = shouldInitiatePeerConnection(
        this.localPublicKey,
        member.publicKey,
        relayPublicKey,
        snapshot.memberCount,
      )
      const existing = this.peers.get(member.publicKey)

      if (existing && existing.initiator !== shouldInitiate) {
        this.stopRelayReceivedStream(member.publicKey)
        existing.peer.destroy()
        this.peers.delete(member.publicKey)
      }

      if (shouldInitiate && !this.peers.has(member.publicKey)) {
        this.ensurePeerConnection(member.publicKey, true)
      }
    }

    for (const [publicKey, record] of this.peers.entries()) {
      if (publicKey === this.localPublicKey) {
        continue
      }

      if (!memberKeys.has(publicKey)) {
        this.stopRelayReceivedStream(publicKey)
        record.peer.destroy()
        this.peers.delete(publicKey)
        this.peerViews.delete(publicKey)
        this.handlers.onPeerRemove?.(publicKey)
      }
    }
  }

  private ensurePeerConnection(remotePublicKey: string, initiator: boolean): VoicePeer {
    const existing = this.peers.get(remotePublicKey)
    if (existing) {
      return existing.peer
    }

    const peer = this.peerFactory.create({
      initiator,
      stream: this.localStream ?? undefined,
      trickle: true,
      iceServers: this.iceServers,
    })

    this.peers.set(remotePublicKey, { peer, initiator })
    this.emitPeerView(remotePublicKey, {
      connectionState: initiator ? 'connecting' : 'reconnecting',
    })

    peer.on('signal', (signal) => {
      sendVoiceSignal(remotePublicKey, signal, this.communityId, this.channelId).catch((error) => {
        const description = describeError(error, { operation: 'send voice signaling data' })
        this.handlers.onConnectionWarning?.(`${description.title}. ${description.body}`)
      })
    })

    peer.on('connect', () => {
      this.peerReconnectAttempts.delete(remotePublicKey)
      this.emitPeerView(remotePublicKey, { connectionState: 'connected' })

      // If we are the relay, add all already-received streams to the newly connected peer
      if (this.isLocalPeerRelay()) {
        for (const [senderKey, stream] of this.relayReceivedStreams.entries()) {
          if (senderKey !== remotePublicKey) {
            for (const track of stream.getAudioTracks()) {
              peer.addTrack(track, stream)
            }
          }
        }
      }
    })

    peer.on('stream', (remoteStream) => {
      this.emitPeerView(remotePublicKey, {
        stream: remoteStream,
        connectionState: 'connected',
      })
      this.startSpeakingDetection(remotePublicKey, remoteStream)

      // Relay forwarding: if we are the relay, store the stream and forward to all other peers
      if (this.isLocalPeerRelay()) {
        this.stopRelayReceivedStream(remotePublicKey)
        this.relayReceivedStreams.set(remotePublicKey, remoteStream)
        for (const [otherKey, otherRecord] of this.peers.entries()) {
          if (otherKey === remotePublicKey || otherKey === this.localPublicKey) {
            continue
          }
          for (const track of remoteStream.getAudioTracks()) {
            otherRecord.peer.addTrack(track, remoteStream)
          }
        }
      }
    })

    peer.on('error', (error) => {
      console.error(`VoiceEngine: peer error for ${remotePublicKey}`, error)
      this.handlePeerDisconnect(remotePublicKey, 'error')
    })

    peer.on('close', () => {
      this.handlePeerDisconnect(remotePublicKey, 'close')
    })

    return peer
  }

  private isLocalPeerRelay(): boolean {
    if (!this.sessionSnapshot || !this.localPublicKey) {
      return false
    }
    const relayPublicKey =
      this.sessionSnapshot.relay.relayCandidatePublicKey ??
      this.sessionSnapshot.relayElection?.relayPublicKey ??
      null
    return (
      this.localPublicKey === relayPublicKey &&
      this.sessionSnapshot.memberCount > 8
    )
  }

  private handlePeerDisconnect(remotePublicKey: string, reason: 'error' | 'close'): void {
    const record = this.peers.get(remotePublicKey)
    if (!record) {
      return
    }

    const pendingReconnect = this.peerReconnectTimers.get(remotePublicKey)
    if (pendingReconnect !== undefined) {
      window.clearTimeout(pendingReconnect)
      this.peerReconnectTimers.delete(remotePublicKey)
    }

    this.stopSpeakingDetection(remotePublicKey)
    record.peer.destroy()
    this.peers.delete(remotePublicKey)

    // Stop relay-owned tracks before dropping the last stream reference.
    this.stopRelayReceivedStream(remotePublicKey)

    const shouldRebuild =
      this.sessionSnapshot !== null &&
      this.localPublicKey !== null &&
      shouldConnectToPeer(
        this.localPublicKey,
        remotePublicKey,
        this.sessionSnapshot.relay.relayCandidatePublicKey ?? this.sessionSnapshot.relayElection?.relayPublicKey ?? null,
        this.sessionSnapshot.memberCount,
      )

    this.emitPeerView(remotePublicKey, {
      connectionState: shouldRebuild ? 'reconnecting' : 'disconnected',
      stream: undefined,
    })

    if (shouldRebuild) {
      this.scheduleReconnect(remotePublicKey, reason)
    }

    // ── Relay failover: if the relay peer disconnected, schedule a bounded rebuild ──
    // We debounce rebuilds because rapid churn (e.g. three members leaving within
    // 500ms) would otherwise trigger three full topology tear-downs. Coalescing
    // into a single rebuild keeps the operation bounded and observable.
    const members = this.sessionSnapshot?.members ?? []
    if (members.length >= 8) {
      const oldRelayKey = [...members].sort((a, b) =>
        a.publicKey.localeCompare(b.publicKey),
      )[0]?.publicKey
      if (oldRelayKey === remotePublicKey) {
        this.scheduleRelayRebuild()
      }
    }
  }

  /// Debounce relay rebuilds so rapid churn doesn't trigger multiple tear-downs.
  /// Waits 250ms after the last relay departure before rebuilding, up to a
  /// maximum of 1000ms of total delay. Bounded and observable.
  private scheduleRelayRebuild(): void {
    if (this.destroyed) return

    const DEBOUNCE_MS = 250
    const MAX_DELAY_MS = 1000

    // Clear any pending timer
    if (this.relayRebuildTimer !== null) {
      window.clearTimeout(this.relayRebuildTimer)
    }

    // If this is the first scheduled rebuild in a burst, mark the start
    if (!this.relayRebuildPending) {
      this.relayRebuildPending = true
      // Cap the maximum wait so we don't defer indefinitely under sustained churn
      this.relayRebuildTimer = window.setTimeout(() => {
        this.executeRelayRebuild()
      }, MAX_DELAY_MS)
      return
    }

    // On subsequent rebuilds within the burst, reset to DEBOUNCE_MS
    this.relayRebuildTimer = window.setTimeout(() => {
      this.executeRelayRebuild()
    }, DEBOUNCE_MS)
  }

  private executeRelayRebuild(): void {
    this.relayRebuildPending = false
    if (this.relayRebuildTimer !== null) {
      window.clearTimeout(this.relayRebuildTimer)
      this.relayRebuildTimer = null
    }
    if (this.destroyed || !this.sessionSnapshot) return

    const members = this.sessionSnapshot.members
    if (members.length < 8) return

    const newRelayKey = [...members].sort((a, b) =>
      a.publicKey.localeCompare(b.publicKey),
    )[0]?.publicKey ?? null

    // If the relay hasn't actually changed, skip the rebuild.
    // This can happen if rapid churn didn't affect the relay role.
    if (newRelayKey === this.lastRelayKey) {
      console.log('[VoiceEngine] Relay rebuild scheduled but relay unchanged, skipping')
      return
    }

    this.lastRelayKey = newRelayKey
    this.relayRebuildCount += 1
    console.log(
      `[VoiceEngine] Relay rebuild #${this.relayRebuildCount}: new relay ${newRelayKey?.slice(0, 16) ?? 'none'}`,
    )
    this.handlers.onRelayChanged?.()

    // Force reconnect all peers to establish new relay topology
    this.stopAllRelayReceivedStreams()
    for (const [pk, peerRecord] of this.peers) {
      peerRecord.peer.destroy()
      this.peers.delete(pk)
    }

    // Re-establish connections with new topology
    for (const member of members) {
      if (member.publicKey !== this.localPublicKey) {
        this.ensurePeerConnection(
          member.publicKey,
          shouldInitiatePeerConnection(
            this.localPublicKey!,
            member.publicKey,
            newRelayKey,
            members.length,
          ),
        )
      }
    }
  }

  /// Expose rebuild count for diagnostics/tests.
  getRelayRebuildCount(): number {
    return this.relayRebuildCount
  }

  private scheduleReconnect(remotePublicKey: string, reason: string): void {
    this.handlers.onConnectionState?.('reconnecting', reason)
    const previous = this.peerReconnectTimers.get(remotePublicKey)
    if (previous !== undefined) {
      window.clearTimeout(previous)
    }

    const attempt = (this.peerReconnectAttempts.get(remotePublicKey) ?? 0) + 1
    this.peerReconnectAttempts.set(remotePublicKey, attempt)
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
      RECONNECT_MAX_DELAY_MS,
    )

    const timer = window.setTimeout(() => {
      this.peerReconnectTimers.delete(remotePublicKey)

      if (this.destroyed || !this.sessionSnapshot || !this.localPublicKey) {
        return
      }

      const member = this.sessionSnapshot.members.find((item) => item.publicKey === remotePublicKey)
      if (!member) {
        return
      }

      const relayPublicKey =
        this.sessionSnapshot.relay.relayCandidatePublicKey ??
        this.sessionSnapshot.relayElection?.relayPublicKey ??
        null

      const shouldConnect = shouldConnectToPeer(
        this.localPublicKey,
        remotePublicKey,
        relayPublicKey,
        this.sessionSnapshot.memberCount,
      )

      if (shouldConnect) {
        this.ensurePeerConnection(
          remotePublicKey,
          shouldInitiatePeerConnection(
            this.localPublicKey,
            remotePublicKey,
            relayPublicKey,
            this.sessionSnapshot.memberCount,
          ),
        )
      }

      this.handlers.onConnectionState?.('connected')
    }, delay)

    this.peerReconnectTimers.set(remotePublicKey, timer)
  }

  private scheduleRebuild(snapshot: VoiceSessionSnapshot): void {
    if (this.topologyRebuildTimer !== null) {
      window.clearTimeout(this.topologyRebuildTimer)
    }

    this.topologyRebuildTimer = window.setTimeout(() => {
      this.topologyRebuildTimer = null

      if (this.destroyed || !this.sessionSnapshot || this.sessionSnapshot.sessionEpoch !== snapshot.sessionEpoch) {
        return
      }

      this.reconcilePeerConnections(snapshot)
      this.handlers.onConnectionState?.(snapshot.memberCount > 0 ? 'connected' : 'connecting')
    }, 180)
  }

  private resetPeerConnections(): void {
    this.stopAllRelayReceivedStreams()
    for (const record of this.peers.values()) {
      record.peer.destroy()
    }
    this.peers.clear()

    for (const timer of this.peerReconnectTimers.values()) {
      window.clearTimeout(timer)
    }
    this.peerReconnectTimers.clear()
    this.peerReconnectAttempts.clear()
  }

  private syncPeerViews(snapshot: VoiceSessionSnapshot): void {
    const members = snapshot.members
    const memberKeys = new Set(members.map((member) => member.publicKey))

    for (const member of members) {
      const existing = this.peerViews.get(member.publicKey)
      const next = buildPeerFromMember(member, existing)
      this.peerViews.set(member.publicKey, next)
      this.handlers.onPeerUpsert?.(next)
    }

    for (const publicKey of Array.from(this.peerViews.keys())) {
      if (publicKey === this.localPublicKey) {
        continue
      }

      if (!memberKeys.has(publicKey)) {
        this.peerViews.delete(publicKey)
        this.handlers.onPeerRemove?.(publicKey)
      }
    }
  }

  private startSpeakingDetection(publicKey: string, stream: MediaStream): void {
    // Stop any existing detection for this key before starting a new one
    this.stopSpeakingDetection(publicKey)

    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioContext()
    }

    // Resume AudioContext if it was suspended (browsers require user gesture)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {})
    }

    const source = this.audioContext.createMediaStreamSource(stream)
    const analyser = this.audioContext.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.3
    source.connect(analyser)

    const frequencyData = new Uint8Array(analyser.frequencyBinCount)
    let wasSpeaking = false
    const SPEAKING_THRESHOLD = 15

    const interval = window.setInterval(() => {
      analyser.getByteFrequencyData(frequencyData)

      let sum = 0
      for (let i = 0; i < frequencyData.length; i++) {
        sum += frequencyData[i]
      }
      const average = sum / frequencyData.length
      const isSpeaking = average > SPEAKING_THRESHOLD

      if (isSpeaking !== wasSpeaking) {
        wasSpeaking = isSpeaking
        this.emitPeerView(publicKey, { speaking: isSpeaking })
      }
    }, 100)

    this.audioAnalysers.set(publicKey, { analyser, source, interval })
  }

  private stopSpeakingDetection(publicKey: string): void {
    const entry = this.audioAnalysers.get(publicKey)
    if (!entry) {
      return
    }

    window.clearInterval(entry.interval)
    entry.source.disconnect()
    entry.analyser.disconnect()
    this.audioAnalysers.delete(publicKey)
  }

  private stopRelayReceivedStream(publicKey: string): void {
    const stream = this.relayReceivedStreams.get(publicKey)
    if (!stream) {
      return
    }

    for (const track of stream.getTracks()) {
      track.stop()
    }
    this.relayReceivedStreams.delete(publicKey)
  }

  private stopAllRelayReceivedStreams(): void {
    for (const publicKey of Array.from(this.relayReceivedStreams.keys())) {
      this.stopRelayReceivedStream(publicKey)
    }
  }

  private emitPeerView(publicKey: string, patch: Partial<Peer>): void {
    const member = this.memberForPublicKey(publicKey)
    const existing = this.peerViews.get(publicKey)
    const next = {
      ...buildPeerFromMember(member, existing),
      ...patch,
      publicKey,
      peerId: patch.peerId ?? existing?.peerId ?? member.peerId ?? publicKey,
    }

    this.peerViews.set(publicKey, next)
    this.handlers.onPeerUpsert?.(next)
  }

  private memberForPublicKey(publicKey: string): VoiceMemberSnapshot {
    const snapshotMember = this.sessionSnapshot?.members.find((member) => member.publicKey === publicKey)
    if (snapshotMember) {
      return snapshotMember
    }

    const fallbackName = shortVoiceLabel(publicKey)
    const color = voiceColorForKey(publicKey)
    const now = new Date().toISOString()

    return normalizeVoiceMember(
      {
        publicKey,
        displayName: fallbackName,
        avatarColor: color,
        joinedAt: now,
        lastSeenAt: now,
        isLocal: publicKey === this.localPublicKey,
        connectionState: 'connecting',
      },
      publicKey,
      publicKey === this.localPublicKey,
    )
  }

  private buildSyntheticSnapshot(memberKeys: string[], leftKeys: string[]): VoiceSessionSnapshot {
    const now = new Date().toISOString()
    const currentMembers = this.sessionSnapshot?.members ?? []
    const nextMembers = [...currentMembers.filter((member) => !leftKeys.includes(member.publicKey))]

    for (const publicKey of memberKeys) {
      if (!nextMembers.some((member) => member.publicKey === publicKey)) {
        nextMembers.push(this.memberForPublicKey(publicKey))
      }
    }

    return normalizeVoiceSessionSnapshot(
        {
          communityId: this.communityId,
          channelId: this.channelId,
          sessionEpoch: this.sessionSnapshot?.sessionEpoch ?? Date.now(),
        memberCount: nextMembers.length,
        members: nextMembers,
        relay: {
          relayRequired: nextMembers.length > 8,
          relayCandidatePublicKey: null,
        },
        updatedAt: now,
        localPublicKey: this.localPublicKey,
      },
      this.localPublicKey,
    )
  }

  private isSameSnapshot(left: VoiceSessionSnapshot | null, right: VoiceSessionSnapshot | null): boolean {
    if (!left || !right) {
      return false
    }

    if (
      left.channelId !== right.channelId ||
      left.communityId !== right.communityId ||
      left.sessionEpoch !== right.sessionEpoch ||
      left.memberCount !== right.memberCount ||
      left.updatedAt !== right.updatedAt
    ) {
      return false
    }

    if (left.members.length !== right.members.length) {
      return false
    }

    return left.members.every((member, index) => {
      const other = right.members[index]
      return (
        member.publicKey === other.publicKey &&
        member.joinedAt === other.joinedAt &&
        member.lastSeenAt === other.lastSeenAt &&
        member.isLocal === other.isLocal
      )
    })
  }
}
