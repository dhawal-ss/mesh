import { useEffect, useMemo, useState } from 'react'
import { useCommunityStore } from '../store/communities'
import { useIdentityStore } from '../store/identity'
import { useMembershipStore } from '../store/membership'
import * as bridge from '../lib/bridge'

interface PresenceEntry {
  publicKey: string
  displayName: string
  avatarColor: string
  role: 'owner' | 'admin' | 'member'
  online: boolean
  lastSeen?: string
}

/**
 * Tracks online presence for members of the active community.
 * Subscribes to presence:update events from the Rust P2P layer.
 */
export function usePresence() {
  const matrixMode = bridge.isMatrixBackend()
  const identity = useIdentityStore((s) => s.identity)
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const communities = useCommunityStore((s) => s.communities)
  // Select raw members map — never call .filter() inside a Zustand selector
  // because it creates a new array reference on every call, causing infinite re-renders.
  const allMembers = useMembershipStore((s) => s.members)
  const touchMember = useMembershipStore((s) => s.touchMember)
  const [onlinePeers, setOnlinePeers] = useState<Set<string>>(new Set())

  const activeCommunity = communities.find((c) => c.id === activeCommunityId)

  // Derive active roster from raw state in useMemo (stable reference)
  const roster = useMemo(() => {
    if (!activeCommunityId) return []
    return (allMembers[activeCommunityId] ?? []).filter(
      (m) => m.joinStatus === 'joined' && m.banStatus === 'none',
    )
  }, [allMembers, activeCommunityId])

  // Subscribe to presence events
  useEffect(() => {
    if (matrixMode) return
    const unsub = bridge.onPresenceUpdate((data) => {
      if (data.communityId !== activeCommunityId) return

      setOnlinePeers((prev) => {
        const next = new Set(prev)
        if (data.status === 'offline') {
          next.delete(data.author)
        } else {
          next.add(data.author)
          touchMember(data.communityId, data.author)
        }
        return next
      })
    })

    return () => {
      unsub.then((fn) => fn())
    }
  }, [activeCommunityId, matrixMode, touchMember])

  useEffect(() => {
    setOnlinePeers(new Set())
  }, [activeCommunityId])

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
        avatarColor: identity.avatarColor || '#c8b89a',
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
