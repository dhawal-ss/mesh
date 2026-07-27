import { useCallback, useEffect, useRef, useState } from 'react'

import * as bridge from '../lib/bridge'
import { useDraftStore } from '../store/drafts'

const DRAFT_SAVE_DEBOUNCE_MS = 500

type DraftSyncStatus =
  | 'local'
  | 'loading'
  | 'saved'
  | 'saving'
  | 'clearing'
  | 'failed'

interface DraftSyncState {
  roomId: string
  status: DraftSyncStatus
}

interface DurableDraftState {
  status: DraftSyncStatus
  markChanged: () => void
  clear: () => void
  retry: () => void
}

export function useDurableDraft(
  roomId: string,
  value: string,
  applyLoadedDraft: (value: string) => void,
): DurableDraftState {
  const matrixMode = bridge.isMatrixBackend()
  const [syncState, setSyncState] = useState<DraftSyncState>(() => ({
    roomId,
    status: matrixMode ? 'loading' : 'local',
  }))
  const revisionRef = useRef(0)
  const persistedRevisionRef = useRef(-1)
  const hydratedRoomRef = useRef<string | null>(matrixMode ? null : roomId)
  const loadGenerationRef = useRef(0)
  const writeChainRef = useRef<Promise<void>>(Promise.resolve())
  const [loadRetry, setLoadRetry] = useState(0)

  const status = syncState.roomId === roomId
    ? syncState.status
    : matrixMode
      ? 'loading'
      : 'local'

  const enqueueWrite = useCallback((operation: () => Promise<void>) => {
    const result = writeChainRef.current
      .catch(() => {})
      .then(operation)
    writeChainRef.current = result.catch(() => {})
    return result
  }, [])

  useEffect(() => {
    const generation = ++loadGenerationRef.current
    persistedRevisionRef.current = -1
    hydratedRoomRef.current = matrixMode ? null : roomId
    if (!matrixMode) return

    const revisionAtStart = revisionRef.current
    void bridge.loadComposerDraft(roomId).then((loadedDraft) => {
      if (generation !== loadGenerationRef.current) return

      const remoteValue = loadedDraft ?? ''
      const localValue = useDraftStore.getState().drafts[roomId] ?? ''
      const userChangedWhileLoading = revisionRef.current !== revisionAtStart
      hydratedRoomRef.current = roomId

      if (!userChangedWhileLoading && !localValue) {
        applyLoadedDraft(remoteValue)
        persistedRevisionRef.current = revisionRef.current
        setSyncState({ roomId, status: 'saved' })
        return
      }

      if (localValue === remoteValue) {
        persistedRevisionRef.current = revisionRef.current
        setSyncState({ roomId, status: 'saved' })
      } else {
        setSyncState({ roomId, status: 'saving' })
      }
    }).catch(() => {
      if (generation !== loadGenerationRef.current) return
      setSyncState({ roomId, status: 'failed' })
    })

    return () => {
      loadGenerationRef.current += 1
    }
  }, [applyLoadedDraft, loadRetry, matrixMode, roomId])

  const markChanged = useCallback(() => {
    revisionRef.current += 1
    hydratedRoomRef.current = roomId
    setSyncState({
      roomId,
      status: matrixMode ? 'saving' : 'local',
    })
  }, [matrixMode, roomId])

  useEffect(() => {
    if (
      !matrixMode
      || status !== 'saving'
      || hydratedRoomRef.current !== roomId
      || persistedRevisionRef.current === revisionRef.current
    ) {
      return
    }

    const revision = revisionRef.current
    const generation = loadGenerationRef.current
    const timer = window.setTimeout(() => {
      const operation = value
        ? () => bridge.saveComposerDraft(roomId, value)
        : () => bridge.clearComposerDraft(roomId)
      void enqueueWrite(operation).then(() => {
        if (
          generation !== loadGenerationRef.current
          || revision !== revisionRef.current
        ) {
          return
        }
        persistedRevisionRef.current = revision
        setSyncState({ roomId, status: 'saved' })
      }).catch(() => {
        if (
          generation === loadGenerationRef.current
          && revision === revisionRef.current
        ) {
          setSyncState({ roomId, status: 'failed' })
        }
      })
    }, DRAFT_SAVE_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [enqueueWrite, matrixMode, roomId, status, value])

  const clear = useCallback(() => {
    revisionRef.current += 1
    const revision = revisionRef.current
    const generation = loadGenerationRef.current
    hydratedRoomRef.current = roomId
    if (!matrixMode) {
      persistedRevisionRef.current = revision
      setSyncState({ roomId, status: 'local' })
      return
    }

    setSyncState({ roomId, status: 'clearing' })
    void enqueueWrite(() => bridge.clearComposerDraft(roomId)).then(() => {
      if (
        generation !== loadGenerationRef.current
        || revision !== revisionRef.current
      ) {
        return
      }
      persistedRevisionRef.current = revision
      setSyncState({ roomId, status: 'saved' })
    }).catch(() => {
      if (
        generation === loadGenerationRef.current
        && revision === revisionRef.current
      ) {
        setSyncState({ roomId, status: 'failed' })
      }
    })
  }, [enqueueWrite, matrixMode, roomId])

  const retry = useCallback(() => {
    if (!matrixMode) return
    if (hydratedRoomRef.current === roomId) {
      setSyncState({ roomId, status: 'saving' })
    } else {
      setSyncState({ roomId, status: 'loading' })
      setLoadRetry((current) => current + 1)
    }
  }, [matrixMode, roomId])

  useEffect(
    () => () => {
      if (
        !matrixMode
        || hydratedRoomRef.current !== roomId
        || persistedRevisionRef.current === revisionRef.current
      ) {
        return
      }
      const pendingValue = useDraftStore.getState().drafts[roomId] ?? ''
      const operation = pendingValue
        ? () => bridge.saveComposerDraft(roomId, pendingValue)
        : () => bridge.clearComposerDraft(roomId)
      void enqueueWrite(operation)
    },
    [enqueueWrite, matrixMode, roomId],
  )

  return { status, markChanged, clear, retry }
}
