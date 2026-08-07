import { beforeEach, describe, expect, it } from 'vitest'
import { currentMeshRoute, meshNavigationStorageKey } from '../lib/mesh-navigation'
import { useMeshNavigationStore } from './navigation'

describe('Mesh navigation store', () => {
  beforeEach(() => {
    localStorage.clear()
    useMeshNavigationStore.getState().clearAccount()
  })

  it('isolates route history by account', () => {
    useMeshNavigationStore.getState().initialize('@taylor:example.org')
    useMeshNavigationStore.getState().navigate({
      kind: 'room',
      communityId: 'guild',
      roomId: 'lobby',
    })
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
})
