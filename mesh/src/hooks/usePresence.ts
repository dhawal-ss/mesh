import { useEffect, useMemo, useState } from 'react'
import { useActiveCommunity, useCommunityStore } from '../store/communities'
import { useIdentityStore } from '../store/identity'
import { useCommunityMembers, useMembershipStore } from '../store/membership'
import * as bridge from '../lib/bridge'

interface PresenceEntry {
  publicKey: string
  displayName: string
  avatarColor: string
  role: 'owner' | 'admin' | 'member'
  online: boolean
  lastSeen?: string
}

const EMPTY_ONLINE_PEERS = new Set<string>()

/**
 * Tracks online presence for members of the active community.
 * Subscribes to presence:update events from the Rust P2P layer.
 */
export function usePresence() {
  const matrixMode = bridge.isMatrixBackend()
  const identity = useIdentityStore((s) => s.identity)
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const activeCommunity = useActiveCommunity()
  // The shared consumer selector is already limited to current members.
  const communityMembers = useCommunityMembers(activeCommunityId)
  const touchMember = useMembershipStore((s) => s.touchMember)
  const [onlinePeerState, setOnlinePeerState] = useState<{
    communityId: string | null
    peers: Set<string>
  }>(() => ({ communityId: activeCommunityId, peers: new Set() }))
  const onlinePeers = onlinePeerState.communityId === activeCommunityId
    ? onlinePeerState.peers
    : EMPTY_ONLINE_PEERS

  const roster = communityMembers

  // Subscribe to presence events
  useEffect(() => {
    if (matrixMode) return
    const unsub = bridge.onPresenceUpdate((data) => {
      if (data.communityId !== activeCommunityId) return

      setOnlinePeerState((previous) => {
        const next = previous.communityId === data.communityId
          ? new Set(previous.peers)
          : new Set<string>()
        if (data.status === 'offline') {
          next.delete(data.author)
        } else {
          next.add(data.author)
          touchMember(data.communityId, data.author)
        }
        return { communityId: data.communityId, peers: next }
      })
    })

    return () => {
      unsub.then((fn) => fn())
    }
  }, [activeCommunityId, matrixMode, touchMember])

  const members = useMemo<PresenceEntry[]>(() => {
    const byPublicKey = new Map<string, PresenceEntry>()

    for (const member of roster) {
      byPublicKey.set(member.publicKey, {
        publicKey: member.publicKey,
        displayName: member.displayName,
        avatarColor: member.avatarColor,
        role: member.role,
        online: matrixMode ? member.online ?? false : onlinePeers.has(member.publicKey),
        lastSeen: member.lastSeen ?? undefined,
      })
    }

    const selfIsActiveMember = identity
      ? roster.some((member) => member.publicKey === identity.publicKey)
      : false

    if (!matrixMode && identity && activeCommunity && selfIsActiveMember) {
      byPublicKey.set(identity.publicKey, {
        publicKey: identity.publicKey,
        displayName: identity.displayName || 'You',
        avatarColor: identity.avatarColor || 'var(--avatar-sand)',
        role: activeCommunity.role,
        online: true,
        lastSeen: new Date().toISOString(),
      })
    }

    return Array.from(byPublicKey.values())
  }, [roster, identity, activeCommunity, onlinePeers, matrixMode])

  return {
    members,
    onlineCount: members.filter((member) => member.online).length,
  }
}
