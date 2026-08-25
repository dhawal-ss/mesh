import { useCallback, useEffect, useRef, useState } from 'react'

import * as bridge from '../lib/bridge'
import { useMessageStore } from '../store/messages'
import type { MatrixQueuedMessageUpdate } from '../types/ipc'

export type QueuedMessageSyncStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'retrying-degraded'
  | 'retrying-failed'

export interface QueuedMessageSyncResult {
  status: QueuedMessageSyncStatus
  retry: () => void
}

export function useQueuedMessageSync(
  matrixMode: boolean,
  reconnectSignal?: number,
): QueuedMessageSyncResult {
  const [status, setStatus] = useState<QueuedMessageSyncStatus>(
    matrixMode ? 'loading' : 'idle',
  )
  const activeRef = useRef(false)
  const generationRef = useRef(0)
  const runningRef = useRef(false)
  const pendingRetryRef = useRef(false)
  const hydratingRef = useRef(false)
  const listenerAttachedRef = useRef(false)
  const unlistenRef = useRef<(() => void) | undefined>(undefined)
  const bufferedRef = useRef(new Map<string, MatrixQueuedMessageUpdate>())
  const lastReconnectSignalRef = useRef(reconnectSignal)
  const startRef = useRef<() => Promise<void>>(async () => {})

  const start = useCallback(async () => {
    if (!matrixMode || !activeRef.current) return
    if (runningRef.current) {
      pendingRetryRef.current = true
      return
    }

    runningRef.current = true
    const generation = generationRef.current
    setStatus((current) => {
      if (current === 'failed' || current === 'retrying-failed') {
        return 'retrying-failed'
      }
      if (current === 'degraded' || current === 'retrying-degraded') {
        return 'retrying-degraded'
      }
      return 'loading'
    })
    let listenerFailed = false
    let restoreFailed = false

    try {
      if (!listenerAttachedRef.current) {
        try {
          const unlisten = await bridge.onMatrixQueuedMessage((update) => {
            if (!activeRef.current) return
            if (hydratingRef.current) {
              const key = `${update.roomId}\u0000${update.transactionId}`
              const previous = bufferedRef.current.get(key)
              bufferedRef.current.set(key, {
                ...previous,
                ...update,
                message: update.message ?? previous?.message,
              })
              return
            }
            useMessageStore.getState().applyQueuedMessageUpdate(update)
          })

          if (!activeRef.current || generation !== generationRef.current) {
            unlisten()
            return
          }
          unlistenRef.current = unlisten
          listenerAttachedRef.current = true
        } catch (error) {
          listenerFailed = true
          console.error('Failed to watch saved messages:', error)
        }
      }

      if (!activeRef.current || generation !== generationRef.current) return

      hydratingRef.current = true
      try {
        const queued = await bridge.matrixQueuedMessages()
        if (!activeRef.current || generation !== generationRef.current) return
        useMessageStore.getState().hydrateQueuedMessages(queued)
      } catch (error) {
        restoreFailed = true
        console.error('Failed to restore saved messages:', error)
      } finally {
        if (!activeRef.current || generation !== generationRef.current) return
        hydratingRef.current = false
        for (const update of bufferedRef.current.values()) {
          useMessageStore.getState().applyQueuedMessageUpdate(update)
        }
        bufferedRef.current.clear()
      }

      if (!activeRef.current || generation !== generationRef.current) return
      setStatus(
        restoreFailed
          ? 'failed'
          : listenerFailed || !listenerAttachedRef.current
            ? 'degraded'
            : 'ready',
      )
    } finally {
      if (generation === generationRef.current) {
        runningRef.current = false
        if (pendingRetryRef.current && activeRef.current) {
          pendingRetryRef.current = false
          void startRef.current()
        }
      }
    }
  }, [matrixMode])

  useEffect(() => {
    startRef.current = start
  }, [start])

  useEffect(() => {
    activeRef.current = true
    generationRef.current += 1
    const buffered = bufferedRef.current
    if (matrixMode) {
      void start()
    }

    return () => {
      activeRef.current = false
      generationRef.current += 1
      runningRef.current = false
      pendingRetryRef.current = false
      hydratingRef.current = false
      buffered.clear()
      listenerAttachedRef.current = false
      unlistenRef.current?.()
      unlistenRef.current = undefined
    }
  }, [matrixMode, start])

  useEffect(() => {
    if (
      !matrixMode
      || reconnectSignal == null
      || reconnectSignal === lastReconnectSignalRef.current
    ) return
    lastReconnectSignalRef.current = reconnectSignal
    void start()
  }, [matrixMode, reconnectSignal, start])

  return {
    status,
    retry: () => {
      void start()
    },
  }
}
