import { useEffect, useMemo } from 'react'
import {
  matrixRtcMembers,
  onMatrixRtcMembership,
} from '../lib/bridge'
import { useVoiceStore } from '../store/voice'

export function useMatrixRtcMembershipSync(roomIds: string[]): void {
  const setMatrixRtcMembers = useVoiceStore((state) => state.setMatrixRtcMembers)
  const roomIdsKey = useMemo(
    () => [...new Set(roomIds)].sort().slice(0, 100).join('\u0000'),
    [roomIds],
  )

  useEffect(() => {
    let active = true
    const boundedRoomIds = roomIdsKey ? roomIdsKey.split('\u0000') : []

    void Promise.allSettled(
      boundedRoomIds.map(async (roomId) => {
        const members = await matrixRtcMembers(roomId)
        if (active) setMatrixRtcMembers(roomId, members)
      }),
    )

    const unlistenTask = onMatrixRtcMembership((event) => {
      if (active) setMatrixRtcMembers(event.roomId, event.members)
    })

    return () => {
      active = false
      void unlistenTask.then((unlisten) => unlisten())
    }
  }, [roomIdsKey, setMatrixRtcMembers])
}
