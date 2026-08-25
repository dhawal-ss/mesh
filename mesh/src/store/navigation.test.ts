import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentMeshRoute, meshNavigationStorageKey } from '../lib/mesh-navigation'
import { useMeshNavigationStore } from './navigation'

/** Comfortably past NAVIGATION_PERSIST_DELAY_MS in ./navigation. */
const PERSIST_WINDOW_MS = 400

describe('Mesh navigation store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    useMeshNavigationStore.getState().clearAccount()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('isolates route history by account', () => {
    useMeshNavigationStore.getState().initialize('@taylor:example.org')
    useMeshNavigationStore.getState().navigate({
      kind: 'room',
      communityId: 'guild',
      roomId: 'lobby',
    })
    // Persistence is deferred off the interaction frame.
    expect(localStorage.getItem(meshNavigationStorageKey('@taylor:example.org'))).toBeNull()
    vi.advanceTimersByTime(PERSIST_WINDOW_MS)
    expect(localStorage.getItem(meshNavigationStorageKey('@taylor:example.org'))).not.toBeNull()

    useMeshNavigationStore.getState().initialize('@maya:example.org')
    expect(currentMeshRoute(useMeshNavigationStore.getState())).toEqual({ kind: 'home' })
  })

  it('opens only one compact drawer at a time', () => {
    useMeshNavigationStore.getState().setDrawer('context')
    expect(useMeshNavigationStore.getState().drawer).toBe('context')
    useMeshNavigationStore.getState().setDrawer('secondary')
    expect(useMeshNavigationStore.getState().drawer).toBe('secondary')
    useMeshNavigationStore.getState().setDrawer('none')
    expect(useMeshNavigationStore.getState().drawer).toBe('none')
  })

  it('supports back and forward without losing the account boundary', () => {
    useMeshNavigationStore.getState().initialize('@taylor:example.org')
    useMeshNavigationStore.getState().navigate({ kind: 'you', section: 'profile' })
    useMeshNavigationStore.getState().back()
    expect(currentMeshRoute(useMeshNavigationStore.getState())).toEqual({ kind: 'home' })
    useMeshNavigationStore.getState().forward()
    expect(currentMeshRoute(useMeshNavigationStore.getState())).toEqual({
      kind: 'you',
      section: 'profile',
    })
  })

  it('flushes a queued navigation write when the window goes away', () => {
    useMeshNavigationStore.getState().initialize('@taylor:example.org')
    useMeshNavigationStore.getState().navigate({
      kind: 'room',
      communityId: 'guild',
      roomId: 'lobby',
    })
    expect(localStorage.getItem(meshNavigationStorageKey('@taylor:example.org'))).toBeNull()

    window.dispatchEvent(new Event('pagehide'))

    const saved = localStorage.getItem(meshNavigationStorageKey('@taylor:example.org'))
    expect(saved).not.toBeNull()
    expect(saved).toContain('lobby')
  })

  it('does not resurrect a removed account from a queued write', () => {
    useMeshNavigationStore.getState().initialize('@taylor:example.org')
    useMeshNavigationStore.getState().navigate({
      kind: 'room',
      communityId: 'guild',
      roomId: 'lobby',
    })

    useMeshNavigationStore.getState().resetForAccountTransition('@taylor:example.org')
    vi.advanceTimersByTime(PERSIST_WINDOW_MS)

    expect(localStorage.getItem(meshNavigationStorageKey('@taylor:example.org'))).toBeNull()
  })
})
