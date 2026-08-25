import { useCallback, useEffect, useState } from 'react'
import * as bridge from '../lib/bridge'
import type { MatrixThreadContextDto } from '../types/ipc'

export type MatrixThreadContextStatus = 'idle' | 'loading' | 'ready' | 'failed'

interface MatrixThreadContextState {
  status: MatrixThreadContextStatus
  context: MatrixThreadContextDto | null
  error: unknown
}

interface SettledMatrixThreadContextState extends MatrixThreadContextState {
  key: string
  status: 'ready' | 'failed'
}

const IDLE_STATE: MatrixThreadContextState = {
  status: 'idle',
  context: null,
  error: null,
}

export function useMatrixThreadContext(
  roomId: string | null,
  threadRootId: string | null,
  enabled: boolean,
) {
  const [settled, setSettled] = useState<SettledMatrixThreadContextState | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const requestKey = enabled && roomId && threadRootId
    ? `${roomId}\u0000${threadRootId}\u0000${reloadToken}`
    : null

  useEffect(() => {
    if (!requestKey || !roomId || !threadRootId) return

    let current = true
    void bridge.matrixThreadContext(roomId, threadRootId).then(
      (context) => {
        if (current) setSettled({ key: requestKey, status: 'ready', context, error: null })
      },
      (error) => {
        if (current) setSettled({ key: requestKey, status: 'failed', context: null, error })
      },
    )
    return () => {
      current = false
    }
  }, [requestKey, roomId, threadRootId])

  const state: MatrixThreadContextState = requestKey === null
    ? IDLE_STATE
    : settled?.key === requestKey
      ? settled
      : { status: 'loading', context: null, error: null }

  const retry = useCallback(() => setReloadToken((token) => token + 1), [])
  const clearUnread = useCallback(() => {
    setSettled((current) => current?.key === requestKey && current.context
      ? {
          ...current,
          context: {
            ...current.context,
            unreadCount: 0,
            unreadMentions: 0,
          },
        }
      : current)
  }, [requestKey])

  return { ...state, retry, clearUnread }
}
