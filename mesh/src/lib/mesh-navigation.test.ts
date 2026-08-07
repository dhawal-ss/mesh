import { describe, expect, it } from 'vitest'
import {
  closeMeshPane,
  currentMeshRoute,
  emptyMeshNavigation,
  meshNavigationStorageKey,
  moveMeshHistory,
  navigateMesh,
  restoreMeshNavigation,
  serializeMeshNavigation,
} from './mesh-navigation'

describe('Mesh product navigation', () => {
  it('moves through product routes and truncates forward history', () => {
    let state = emptyMeshNavigation('@taylor:example.org')
    state = navigateMesh(state, { kind: 'room', communityId: 'guild', roomId: 'lobby' })
    state = navigateMesh(state, { kind: 'direct', conversationId: 'maya' })

    state = moveMeshHistory(state, -1)
    expect(currentMeshRoute(state)).toEqual({
      kind: 'room',
      communityId: 'guild',
      roomId: 'lobby',
    })

    state = navigateMesh(state, { kind: 'you', section: 'appearance' })
    expect(state.entries.map((route) => route.kind)).toEqual(['home', 'room', 'you'])
    expect(moveMeshHistory(state, 1)).toBe(state)
  })

  it('closes a subordinate pane without leaving its primary destination', () => {
    let state = emptyMeshNavigation('local')
    state = navigateMesh(state, {
      kind: 'room',
      communityId: 'guild',
      roomId: 'art',
      pane: { kind: 'details', tab: 'files' },
    })

    state = closeMeshPane(state)
    expect(currentMeshRoute(state)).toEqual({
      kind: 'room',
      communityId: 'guild',
      roomId: 'art',
    })
    expect(state.entries).toHaveLength(2)
  })

  it('keeps recent destinations bounded and ordered by last open', () => {
    let state = emptyMeshNavigation('local')
    state = navigateMesh(state, { kind: 'room', communityId: 'guild', roomId: 'art' }, { now: 10 })
    state = navigateMesh(state, { kind: 'direct', conversationId: 'maya' }, { now: 20 })
    state = navigateMesh(state, { kind: 'home' })
    state = navigateMesh(state, { kind: 'room', communityId: 'guild', roomId: 'art' }, { now: 30 })

    expect(state.recents).toEqual([
      {
        route: { kind: 'room', communityId: 'guild', roomId: 'art' },
        lastOpenedAt: 30,
      },
      { route: { kind: 'direct', conversationId: 'maya' }, lastOpenedAt: 20 },
    ])
  })

  it('restores only the matching account and valid routes', () => {
    let state = emptyMeshNavigation('@taylor:example.org')
    state = navigateMesh(state, { kind: 'community', communityId: 'guild' })
    const serialized = serializeMeshNavigation(state)

    expect(restoreMeshNavigation(serialized, '@taylor:example.org')).toEqual(state)
    expect(currentMeshRoute(restoreMeshNavigation(serialized, '@maya:example.org'))).toEqual({
      kind: 'home',
    })
    expect(meshNavigationStorageKey('@taylor:example.org')).toBe(
      'mesh-navigation-v1:%40taylor%3Aexample.org',
    )
  })

  it('rejects invitation secrets in route history', () => {
    const serialized = JSON.stringify({
      schemaVersion: 1,
      accountId: 'local',
      entries: [
        { kind: 'home' },
        { kind: 'invitation', handle: 'https://invite.example.org/?token=secret' },
      ],
      index: 1,
      recents: [],
    })

    const restored = restoreMeshNavigation(serialized, 'local')
    expect(restored.entries).toEqual([{ kind: 'home' }])
    expect(JSON.stringify(restored)).not.toContain('secret')
  })

  it('never restores joined media intent from a voice destination', () => {
    let state = emptyMeshNavigation('local')
    state = navigateMesh(state, { kind: 'voice', communityId: 'guild', roomId: 'studio' })
    const restored = restoreMeshNavigation(serializeMeshNavigation(state), 'local')

    expect(currentMeshRoute(restored)).toEqual({
      kind: 'voice',
      communityId: 'guild',
      roomId: 'studio',
    })
    expect(JSON.stringify(restored)).not.toMatch(/microphone|camera|joined/i)
  })
})
