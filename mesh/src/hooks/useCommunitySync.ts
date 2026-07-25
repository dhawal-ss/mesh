import { useEffect, useRef } from 'react'
import { useCommunityStore } from '../store/communities'
import { useChannelStore } from '../store/channels'
import { useMembershipStore } from '../store/membership'
import { useIdentityStore } from '../store/identity'
import { getMembers, isMatrixBackend, onControlEvent, requestControlLogSync } from '../lib/bridge'
import type { Channel } from '../types/ipc'
import type { ControlEventData } from '../lib/bridge'
import type { MemberRecord } from '../store/membership'
import { registerPoll } from '../lib/scheduler'

/**
 * Community sync hook for the authoritative signed control-log model.
 *
 * Instead of syncing via document replication, this hook:
 * 1. Loads the membership roster from the backend on community activation.
 * 2. Subscribes to `control:event` Tauri events to apply real-time mutations
 *    (channel create/delete, member join/leave/ban, role changes) directly
 *    to the Zustand stores.
 *
 * The control-log model is authoritative - only events signed by the
 * community owner (or admin for allowed actions) are applied.
 */
export function useCommunitySync() {
  const matrixMode = isMatrixBackend()
  const activeCommunityId = useCommunityStore((s) => s.activeCommunityId)
  const patchCommunity = useCommunityStore((s) => s.patchCommunity)
  const removeCommunity = useCommunityStore((s) => s.removeCommunity)
  const addChannel = useChannelStore((s) => s.addChannel)
  const removeChannel = useChannelStore((s) => s.removeChannel)
  const setRoster = useMembershipStore((s) => s.setRoster)
  const clearCommunity = useMembershipStore((s) => s.clearCommunity)
  const upsertMember = useMembershipStore((s) => s.upsertMember)
  const removeMember = useMembershipStore((s) => s.removeMember)
  const banMember = useMembershipStore((s) => s.banMember)
  const updateRole = useMembershipStore((s) => s.updateRole)
  const identityPublicKey = useIdentityStore((s) => s.identity?.publicKey ?? null)
  const mountedRef = useRef(true)
  const bootstrappingCommunityRef = useRef<string | null>(null)
  const queuedBootstrapEventsRef = useRef<ControlEventData[]>([])

  useEffect(() => {
    if (matrixMode) {
      if (!activeCommunityId) return
      let cancelled = false
      const communityId = activeCommunityId
      const refreshMatrixRoster = async () => {
        try {
          const members = await getMembers(communityId)
          if (cancelled) return
          const roster: MemberRecord[] = members.map((member) => ({
            publicKey: member.publicKey,
            displayName: member.displayName,
            avatarColor: member.avatarColor,
            role: member.role as MemberRecord['role'],
            joinStatus: (member.joinStatus as MemberRecord['joinStatus']) ?? 'joined',
            banStatus: (member.banStatus as MemberRecord['banStatus']) ?? 'none',
            lastSeen: member.lastSeen,
            online: member.online ?? false,
          }))
          setRoster(communityId, roster)
          patchCommunity(communityId, {
            memberCount: roster.filter(
              (member) => member.joinStatus === 'joined' && member.banStatus === 'none',
            ).length,
          })
        } catch (error) {
          console.error('Failed to refresh Matrix member roster:', error)
          throw error
        }
      }
      const unregisterPoll = registerPoll({
        key: `matrix-roster:${communityId}`,
        intervalMs: 5_000,
        run: refreshMatrixRoster,
        pauseWhenHidden: true,
        backoffOnError: true,
      })
      return () => {
        cancelled = true
        unregisterPoll()
      }
    }

    if (!activeCommunityId) {
      bootstrappingCommunityRef.current = null
      queuedBootstrapEventsRef.current = []
      return
    }

    let cancelled = false
    const communityId = activeCommunityId
    bootstrappingCommunityRef.current = communityId
    queuedBootstrapEventsRef.current = []

    async function loadRoster() {
      try {
        await requestControlLogSync(communityId)
        const members = await getMembers(communityId)
        if (cancelled) return

        const roster: MemberRecord[] = members.map((member) => ({
          publicKey: member.publicKey,
          displayName: member.displayName,
          avatarColor: member.avatarColor,
          role: member.role as MemberRecord['role'],
          joinStatus: (member.joinStatus as MemberRecord['joinStatus']) ?? 'joined',
          banStatus: (member.banStatus as MemberRecord['banStatus']) ?? 'none',
          lastSeen: member.lastSeen,
          online: member.online ?? false,
        }))

        setRoster(communityId, roster)
        patchCommunity(communityId, {
          memberCount: roster.filter(
            (member) => member.joinStatus === 'joined' && member.banStatus === 'none',
          ).length,
        })

        const queuedEvents = queuedBootstrapEventsRef.current.filter(
          (event) => event.communityId === communityId && event.applied,
        )
        queuedBootstrapEventsRef.current = queuedBootstrapEventsRef.current.filter(
          (event) => event.communityId !== communityId,
        )
        bootstrappingCommunityRef.current = null

        for (const event of queuedEvents) {
          handleControlEvent(event, {
            addChannel,
            removeChannel,
            upsertMember,
            removeMember,
            banMember,
            updateRole,
            patchCommunity,
            removeCommunity,
            clearCommunity,
            identityPublicKey,
          })
        }
      } catch (error) {
        bootstrappingCommunityRef.current = null
        queuedBootstrapEventsRef.current = queuedBootstrapEventsRef.current.filter(
          (event) => event.communityId !== communityId,
        )
        console.error('Failed to load member roster:', error)
      }
    }

    void loadRoster()

    return () => {
      cancelled = true
      if (bootstrappingCommunityRef.current === communityId) {
        bootstrappingCommunityRef.current = null
        queuedBootstrapEventsRef.current = queuedBootstrapEventsRef.current.filter(
          (event) => event.communityId !== communityId,
        )
      }
    }
  }, [
    activeCommunityId,
    addChannel,
    banMember,
    clearCommunity,
    identityPublicKey,
    patchCommunity,
    removeChannel,
    removeCommunity,
    removeMember,
    setRoster,
    updateRole,
    upsertMember,
    matrixMode,
  ])

  useEffect(() => {
    if (matrixMode) {
      return
    }

    let unlisten: (() => void) | null = null

    const subscribe = async () => {
      unlisten = await onControlEvent((event: ControlEventData) => {
        if (!mountedRef.current || !event.applied) {
          return
        }

        if (bootstrappingCommunityRef.current === event.communityId) {
          queuedBootstrapEventsRef.current.push(event)
          return
        }

        handleControlEvent(event, {
          addChannel,
          removeChannel,
          upsertMember,
          removeMember,
          banMember,
          updateRole,
          patchCommunity,
          removeCommunity,
          clearCommunity,
          identityPublicKey,
        })
      })
    }

    void subscribe()

    return () => {
      unlisten?.()
    }
  }, [
    addChannel,
    banMember,
    clearCommunity,
    identityPublicKey,
    patchCommunity,
    removeChannel,
    removeCommunity,
    removeMember,
    updateRole,
    upsertMember,
    matrixMode,
  ])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
}

interface ControlEventHandlers {
  addChannel: (channel: Channel) => void
  removeChannel: (channelId: string) => void
  upsertMember: (communityId: string, member: MemberRecord) => void
  removeMember: (communityId: string, publicKey: string) => void
  banMember: (communityId: string, publicKey: string) => void
  updateRole: (communityId: string, publicKey: string, role: MemberRecord['role']) => void
  patchCommunity: (id: string, patch: { memberCount?: number; name?: string; description?: string }) => void
  removeCommunity: (communityId: string) => void
  clearCommunity: (communityId: string) => void
  identityPublicKey: string | null
}

function handleControlEvent(
  event: ControlEventData,
  handlers: ControlEventHandlers,
) {
  const { payload } = event

  switch (event.eventType) {
    case 'channel_create': {
      const channel: Channel = {
        id: (payload.channelId as string) ?? '',
        communityId: event.communityId,
        name: (payload.name as string) ?? 'untitled',
        channelType: ((payload.channelType as string) ?? 'text') as Channel['channelType'],
        unreadCount: 0,
      }
      handlers.addChannel(channel)
      break
    }

    case 'channel_delete': {
      const channelId = payload.channelId as string
      if (channelId) {
        handlers.removeChannel(channelId)
      }
      break
    }

    case 'member_join': {
      handlers.upsertMember(event.communityId, {
        publicKey: (payload.publicKey as string) ?? '',
        displayName: (payload.displayName as string) ?? 'Unknown',
        avatarColor: (payload.avatarColor as string) ?? '#c8b89a',
        role: ((payload.role as string) ?? 'member') as MemberRecord['role'],
        joinStatus: 'joined',
        banStatus: 'none',
        lastSeen: null,
      })
      break
    }

    case 'member_leave': {
      const publicKey = payload.publicKey as string
      if (!publicKey) {
        break
      }

      if (handlers.identityPublicKey && publicKey === handlers.identityPublicKey) {
        handlers.clearCommunity(event.communityId)
        handlers.removeCommunity(event.communityId)
        break
      }

      handlers.removeMember(event.communityId, publicKey)
      break
    }

    case 'member_ban': {
      const publicKey = payload.publicKey as string
      if (!publicKey) {
        break
      }

      if (handlers.identityPublicKey && publicKey === handlers.identityPublicKey) {
        handlers.clearCommunity(event.communityId)
        handlers.removeCommunity(event.communityId)
        break
      }

      handlers.banMember(event.communityId, publicKey)
      break
    }

    case 'role_change': {
      const publicKey = payload.publicKey as string
      const role = payload.role as string
      if (publicKey && role) {
        handlers.updateRole(event.communityId, publicKey, role as MemberRecord['role'])
      }
      break
    }

    case 'community_update': {
      handlers.patchCommunity(event.communityId, {
        name: (payload.name as string | undefined) ?? undefined,
        description: (payload.description as string | undefined) ?? undefined,
      })
      break
    }

    case 'community_delete': {
      handlers.clearCommunity(event.communityId)
      handlers.removeCommunity(event.communityId)
      break
    }

    default:
      break
  }
}
