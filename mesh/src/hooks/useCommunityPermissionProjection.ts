import { useCallback, useEffect, useRef, useState } from 'react'
import * as bridge from '../lib/bridge'
import type { CommunityPermissionProjection } from '../types/ipc'
import { describeError } from '../lib/errors'

interface CommunityPermissionProjectionOptions {
  communityId: string | null
  enabled: boolean
  sessionKey: string | null
}

interface CommunityPermissionProjectionState {
  projection: CommunityPermissionProjection | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

const REMOTE_REFRESH_DEBOUNCE_MS = 150

export function useCommunityPermissionProjection({
  communityId,
  enabled,
  sessionKey,
}: CommunityPermissionProjectionOptions): CommunityPermissionProjectionState {
  const generationRef = useRef(0)
  const projectionRef = useRef<CommunityPermissionProjection | null>(null)
  const [projection, setProjection] = useState<CommunityPermissionProjection | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const commitProjection = useCallback((next: CommunityPermissionProjection | null) => {
    projectionRef.current = next
    setProjection(next)
  }, [])

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current
    if (!enabled || !communityId) {
      commitProjection(null)
      setLoading(false)
      setError(null)
      return
    }
    if (!sessionKey) {
      commitProjection(null)
      setLoading(false)
      setError('Sign in again before reviewing community permissions.')
      return
    }

    const subjectUserId = bridge.getMatrixUserId()
    if (!subjectUserId) {
      commitProjection(null)
      setLoading(false)
      setError('Sign in again before reviewing community permissions.')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const next = await bridge.getCommunityPermissionProjection(communityId, subjectUserId)
      if (generation !== generationRef.current) return
      if (next.communityId !== communityId || next.subjectUserId !== subjectUserId) {
        commitProjection(null)
        setError('Mesh rejected permission results from an older account or community.')
        return
      }
      commitProjection(next)
    } catch (requestError) {
      if (generation !== generationRef.current) return
      const description = describeError(requestError, {
        operation: 'review community permissions',
        resource: 'community',
      })
      commitProjection(null)
      setError(`${description.title}. ${description.body}`)
    } finally {
      if (generation === generationRef.current) {
        setLoading(false)
      }
    }
  }, [commitProjection, communityId, enabled, sessionKey])

  useEffect(() => {
    let disposed = false
    void Promise.resolve().then(() => {
      if (!disposed) return refresh()
    })
    return () => {
      disposed = true
      generationRef.current += 1
    }
  }, [refresh])

  useEffect(() => {
    if (!enabled || !communityId) return

    let disposed = false
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let unlisten: (() => void) | null = null

    void bridge.onMatrixPermissionStateChanged((change) => {
      if (disposed) return
      const current = projectionRef.current
      const affectsActiveCommunity =
        change.roomId === communityId
        || current?.rooms.some((room) => room.roomId === change.roomId) === true
      if (!affectsActiveCommunity) return

      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void refresh()
      }, REMOTE_REFRESH_DEBOUNCE_MS)
    }).then((disposeListener) => {
      if (disposed) {
        disposeListener()
      } else {
        unlisten = disposeListener
      }
    }).catch(() => {
      // The initial bounded read remains available if the event stream cannot
      // be installed. A later panel mount will retry the listener.
    })

    return () => {
      disposed = true
      if (refreshTimer) clearTimeout(refreshTimer)
      unlisten?.()
    }
  }, [communityId, enabled, refresh])

  return { projection, loading, error, refresh }
}
