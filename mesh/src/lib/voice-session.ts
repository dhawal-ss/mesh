import type {
  Peer,
  VoiceMemberSnapshot,
  VoiceRelayElection,
  VoiceSessionSnapshot,
  VoiceSessionUpdate,
} from '../types/ipc'

const VOICE_RELAY_THRESHOLD = 8

export function normalizeVoiceMember(
  member: Partial<VoiceMemberSnapshot> & Pick<VoiceMemberSnapshot, 'publicKey'>,
  fallbackPeerId?: string,
  isLocal = false,
): VoiceMemberSnapshot {
  const publicKey = member.publicKey.trim()

  return {
    publicKey,
    joinedAt: member.joinedAt ?? new Date().toISOString(),
    lastSeenAt: member.lastSeenAt ?? new Date().toISOString(),
    isLocal: member.isLocal ?? isLocal,
    displayName: member.displayName?.trim() || shortVoiceLabel(publicKey),
    avatarColor: member.avatarColor?.trim() || voiceColorForKey(publicKey),
    peerId: member.peerId?.trim() || fallbackPeerId || publicKey,
    isRelay: member.isRelay ?? false,
    speaking: member.speaking ?? false,
    connectionState: member.connectionState ?? 'connected',
    latency: Number.isFinite(member.latency) ? member.latency : 0,
    stream: member.stream,
  }
}

export function deriveRelayElection(snapshot: Pick<VoiceSessionSnapshot, 'memberCount' | 'members' | 'relay' | 'updatedAt'>): VoiceRelayElection | null {
  if (!snapshot.relay.relayRequired && snapshot.memberCount <= VOICE_RELAY_THRESHOLD) {
    return null
  }

  const relayPublicKey =
    snapshot.relay.relayCandidatePublicKey ??
    [...snapshot.members]
      .map((member) => member.publicKey)
      .sort((left, right) => left.localeCompare(right))[0] ??
    null

  if (!relayPublicKey) {
    return null
  }

  return {
    relayPublicKey,
    participantCount: snapshot.memberCount,
    reason: 'lexicographic',
    electedAt: snapshot.updatedAt,
  }
}

export function normalizeVoiceSessionSnapshot(
  snapshot: VoiceSessionSnapshot,
  localPublicKey?: string | null,
): VoiceSessionSnapshot {
  const members = snapshot.members.map((member) =>
    normalizeVoiceMember(member, member.peerId, member.isLocal || member.publicKey === localPublicKey),
  )
  const relayElection = deriveRelayElection({
    memberCount: snapshot.memberCount,
    members,
    relay: snapshot.relay,
    updatedAt: snapshot.updatedAt,
  })
  const relayCandidatePublicKey = relayElection?.relayPublicKey ?? snapshot.relay.relayCandidatePublicKey ?? null

  return {
    ...snapshot,
    members: members.map((member) => ({
      ...member,
      isRelay: relayCandidatePublicKey !== null && member.publicKey === relayCandidatePublicKey,
    })),
    relay: {
      relayRequired: snapshot.relay.relayRequired || snapshot.memberCount > VOICE_RELAY_THRESHOLD,
      relayCandidatePublicKey,
    },
    relayElection,
    topology: relayCandidatePublicKey ? 'relay-election' : 'mesh',
    localPublicKey: localPublicKey ?? snapshot.localPublicKey ?? null,
  }
}

export function mergeVoiceSessionSnapshot(
  current: VoiceSessionSnapshot | null,
  update: VoiceSessionUpdate,
): VoiceSessionSnapshot {
  const members = mergeMembers(
    current?.members ?? [],
    update.members ?? [],
    update.joined ?? [],
    update.left ?? [],
  )

  return normalizeVoiceSessionSnapshot(
    {
      communityId: update.communityId,
      channelId: update.channelId,
      sessionEpoch: update.sessionEpoch,
      memberCount: members.length,
      members,
      relay: update.relay ?? current?.relay ?? {
        relayRequired: members.length > VOICE_RELAY_THRESHOLD,
        relayCandidatePublicKey: null,
      },
      updatedAt: update.updatedAt ?? new Date().toISOString(),
      localPublicKey: current?.localPublicKey ?? null,
    },
    current?.localPublicKey ?? null,
  )
}

export function shouldConnectToPeer(
  localPublicKey: string,
  remotePublicKey: string,
  relayPublicKey: string | null,
  participantCount: number,
): boolean {
  if (!localPublicKey || !remotePublicKey || localPublicKey === remotePublicKey) {
    return false
  }

  if (relayPublicKey && participantCount > VOICE_RELAY_THRESHOLD) {
    return localPublicKey === relayPublicKey || remotePublicKey === relayPublicKey
  }

  return true
}

export function shouldInitiatePeerConnection(
  localPublicKey: string,
  remotePublicKey: string,
  relayPublicKey: string | null,
  participantCount: number,
): boolean {
  if (!shouldConnectToPeer(localPublicKey, remotePublicKey, relayPublicKey, participantCount)) {
    return false
  }

  if (relayPublicKey && participantCount > VOICE_RELAY_THRESHOLD) {
    if (localPublicKey === relayPublicKey) {
      return true
    }

    if (remotePublicKey === relayPublicKey) {
      return false
    }
  }

  return localPublicKey.localeCompare(remotePublicKey) > 0
}

export function buildPeerFromMember(member: VoiceMemberSnapshot, existing?: Peer): Peer {
  return {
    publicKey: member.publicKey,
    peerId: existing?.peerId ?? member.peerId ?? member.publicKey,
    displayName: existing?.displayName ?? member.displayName ?? shortVoiceLabel(member.publicKey),
    avatarColor: existing?.avatarColor ?? member.avatarColor ?? voiceColorForKey(member.publicKey),
    latency: existing?.latency ?? member.latency ?? 0,
    stream: existing?.stream ?? member.stream,
    role: member.isRelay ? 'relay' : existing?.role ?? 'member',
    connectionState: existing?.connectionState ?? member.connectionState ?? 'connected',
    joinedAt: member.joinedAt,
    lastSeenAt: member.lastSeenAt,
    isSelf: member.isLocal ?? existing?.isSelf ?? false,
    isLocal: member.isLocal,
    isRelay: member.isRelay,
    speaking: member.speaking ?? existing?.speaking ?? false,
  }
}

function mergeMembers(
  current: VoiceMemberSnapshot[],
  full: VoiceMemberSnapshot[],
  joined: VoiceMemberSnapshot[],
  left: string[],
): VoiceMemberSnapshot[] {
  const byPublicKey = new Map<string, VoiceMemberSnapshot>()

  for (const member of current) {
    byPublicKey.set(member.publicKey, normalizeVoiceMember(member, member.peerId, member.isLocal))
  }

  for (const member of full) {
    byPublicKey.set(member.publicKey, normalizeVoiceMember(member, member.peerId, member.isLocal))
  }

  for (const member of joined) {
    byPublicKey.set(member.publicKey, normalizeVoiceMember(member, member.peerId, member.isLocal))
  }

  for (const publicKey of left) {
    byPublicKey.delete(publicKey)
  }

  return Array.from(byPublicKey.values()).sort((leftMember, rightMember) =>
    leftMember.publicKey.localeCompare(rightMember.publicKey),
  )
}

export function shortVoiceLabel(publicKey: string): string {
  const prefix = publicKey.slice(0, 6)
  return prefix ? `Peer ${prefix}` : 'Peer'
}

export function voiceColorForKey(publicKey: string): string {
  const palette = ['#8d6e63', '#78909c', '#7c9d7d', '#a1887f', '#5c6bc0', '#546e7a']
  let hash = 0
  for (let index = 0; index < publicKey.length; index += 1) {
    hash = (hash * 31 + publicKey.charCodeAt(index)) >>> 0
  }

  return palette[hash % palette.length]
}
