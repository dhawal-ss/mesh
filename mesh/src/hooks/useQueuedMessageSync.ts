import { useEffect } from 'react'

import * as bridge from '../lib/bridge'
import { useMessageStore } from '../store/messages'
import type { MatrixQueuedMessageUpdate } from '../types/ipc'

export function useQueuedMessageSync(matrixMode: boolean) {
  useEffect(() => {
    if (!matrixMode) return

    let active = true
    let hydrating = true
    let unlisten: (() => void) | undefined
    const buffered = new Map<string, MatrixQueuedMessageUpdate>()

    const start = async () => {
      try {
        unlisten = await bridge.onMatrixQueuedMessage((update) => {
          if (!active) return
          if (hydrating) {
            const key = `${update.roomId}\u0000${update.transactionId}`
            const previous = buffered.get(key)
            buffered.set(key, {
              ...previous,
              ...update,
              message: update.message ?? previous?.message,
            })
            return
          }
          useMessageStore.getState().applyQueuedMessageUpdate(update)
        })
      } catch (error) {
        console.error('Failed to watch saved messages:', error)
        return
      }
      if (!active) {
        unlisten()
        return
      }

      try {
        const queued = await bridge.matrixQueuedMessages()
        if (!active) return
        useMessageStore.getState().hydrateQueuedMessages(queued)
      } catch (error) {
        console.error('Failed to restore saved messages:', error)
      } finally {
        if (!active) return
        hydrating = false
        for (const update of buffered.values()) {
          useMessageStore.getState().applyQueuedMessageUpdate(update)
        }
        buffered.clear()
      }
    }

    void start()
    return () => {
      active = false
      unlisten?.()
    }
  }, [matrixMode])
}
