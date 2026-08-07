import { useEffect, useMemo } from 'react'
import {
  matrixRtcMembers,
  onMatrixRtcMembership,
} from '../lib/bridge'
import { useVoiceStore } from '../store/voice'
import { mapSettledWithConcurrency } from '../lib/concurrency'

export function useMatrixRtcMembershipSync(roomIds: string[]): void {
  const setMatrixRtcMembers = useVoiceStore((state) => state.setMatrixRtcMembers)
  const roomIdsKey = useMemo(
    () => [...new Set(roomIds)].sort().slice(0, 100).join('\u0000'),
    [roomIds],
  )

  useEffect(() => {
    let active = true
    const boundedRoomIds = roomIdsKey ? roomIdsKey.split('\u0000') : []

    void mapSettledWithConcurrency(
      boundedRoomIds,
      4,
      async (roomId) => {
        if (!active) return
        const members = await matrixRtcMembers(roomId)
        if (active) setMatrixRtcMembers(roomId, members)
      },
      () => active,
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
