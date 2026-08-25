import { useState } from 'react'

import * as bridge from '../lib/bridge'
import { useChannelStore } from '../store/channels'
import { useMeshNavigationStore } from '../store/navigation'
import { showToast } from '../components/ui/Toast'
import type { Channel } from '../types/ipc'

export interface JoinCommunityRoom {
  /** The room a join is in flight for, or null. */
  joiningRoomId: string | null
  /**
   * Joins a room this community already admits this account to. `open` lands in
   * the room afterwards, which is what a click on the room itself asked for; a
   * caller that is already looking at the room passes false.
   */
  joinRoom: (channel: Channel, open: boolean) => Promise<void>
}

/**
 * Joining a room of a community this account is already in.
 *
 * Shared between the room list and the conversation area because both can be
 * looking at the same unjoined room: the sidebar offers it, and the command
 * palette or a room link can select one directly. Two copies of this would be
 * two chances for one of them to forget to write the joined room back into the
 * store, which is what stops the row offering a join it has already done.
 */
export function useJoinCommunityRoom(): JoinCommunityRoom {
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null)
  const upsertChannel = useChannelStore((state) => state.upsertChannel)
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel)
  const navigate = useMeshNavigationStore((state) => state.navigate)

  const joinRoom = async (channel: Channel, open: boolean) => {
    // One at a time: the second click of a double-click would otherwise send a
    // second join for the same room.
    if (joiningRoomId) return
    setJoiningRoomId(channel.id)
    try {
      const joined = await bridge.joinCommunityChannel(channel.communityId, channel.id)
      upsertChannel(joined)
      if (open) {
        setActiveChannel(joined.id)
        navigate({ kind: 'room', communityId: joined.communityId, roomId: joined.id })
      } else {
        showToast(`Joined ${joined.name}.`, 'success')
      }
    } catch {
      showToast('Could not join this room. Try again.', 'error')
    } finally {
      setJoiningRoomId(null)
    }
  }

  return { joiningRoomId, joinRoom }
}
