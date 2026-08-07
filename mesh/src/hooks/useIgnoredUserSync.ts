import { useEffect } from 'react'

import * as bridge from '../lib/bridge'
import { useDmStore } from '../store/dms'

export function useIgnoredUserSync(matrixMode: boolean) {
  useEffect(() => {
    if (!matrixMode) return

    let active = true
    let unlisten: (() => void) | undefined
    void bridge.onMatrixIgnoredUsersChanged((change) => {
      if (!active) return
      const store = useDmStore.getState()
      if (change.resetAll) {
        store.resetIgnoredUserProjection()
      } else {
        for (const userId of change.blockedUserIds) {
          store.upsertBlockedAccount({ userId })
        }
      }

      const refreshed = useDmStore.getState()
      void Promise.allSettled([
        refreshed.loadConversations(),
        refreshed.loadRequests(),
        refreshed.loadBlockedAccounts(),
      ])
    }).then((stopListening) => {
      if (!active) {
        stopListening()
        return
      }
      unlisten = stopListening
    }).catch((error) => {
      console.error('Failed to watch blocked-account changes:', error)
    })

    return () => {
      active = false
      unlisten?.()
    }
  }, [matrixMode])
}
