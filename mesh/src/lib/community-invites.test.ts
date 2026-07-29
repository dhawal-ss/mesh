import { describe, expect, it } from 'vitest'
import {
  isMeshJoinLink,
  parseCommunityInvite,
  parseManagedCommunityInvite,
  parseMatrixCommunityInvite,
} from './community-invites'

describe('Matrix community invites', () => {
  it('parses a room, federation route, and service without exposing credentials', () => {
    const link =
      'mesh://join?v=3&kind=matrix&room=!community%3Amesh.example&via=mesh.example&service=https%3A%2F%2Fmatrix.mesh.example'

    expect(parseMatrixCommunityInvite(link)).toMatchObject({
      kind: 'matrix',
      version: 3,
      roomOrAlias: '!community:mesh.example',
      via: ['mesh.example'],
      service: 'https://matrix.mesh.example',
    })
    expect(link).not.toContain('token')
    expect(link).not.toContain('password')
  })

  it.each([
    'https://mesh.example/join?v=3&kind=matrix&room=!room:mesh.example&via=mesh.example',
    'mesh://elsewhere?v=3&kind=matrix&room=!room:mesh.example&via=mesh.example',
    'mesh://user:secret@join?v=3&kind=matrix&room=!room:mesh.example&via=mesh.example',
    'mesh://join?v=3&kind=matrix&room=!room:mesh.example',
    'mesh://join?v=3&kind=matrix&room=not-a-room&via=mesh.example',
    'mesh://join?v=3&kind=matrix&room=!room:mesh.example&via=mesh.example&service=http://remote.example',
  ])('rejects unsafe or incomplete links: %s', (link) => {
    expect(parseMatrixCommunityInvite(link)).toBeNull()
  })

  it('recognizes legacy Mesh join links for deep-link routing without treating them as Matrix links', () => {
    const legacy = 'mesh://join?v=2&c=community-1&t=secret'
    expect(isMeshJoinLink(legacy)).toBe(true)
    expect(parseMatrixCommunityInvite(legacy)).toBeNull()
  })

  it('parses one-use managed HTTPS and app links without confusing them with room links', () => {
    const code = 'abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
    const publicLink = `https://mesh.example/invite/${code}`
    const deepLink =
      `mesh://join?v=4&kind=managed&code=${code}&api=https%3A%2F%2Fmesh.example`

    expect(parseManagedCommunityInvite(publicLink)).toMatchObject({
      kind: 'managed',
      version: 4,
      code,
      apiOrigin: 'https://mesh.example',
    })
    expect(parseCommunityInvite(deepLink)).toMatchObject({
      kind: 'managed',
      code,
      apiOrigin: 'https://mesh.example',
    })
    expect(parseMatrixCommunityInvite(publicLink)).toBeNull()
  })

  it.each([
    'http://mesh.example/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789',
    'https://user:secret@mesh.example/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789',
    'https://mesh.example/invite/too-short',
    'https://mesh.example/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789?next=elsewhere',
    'mesh://join?v=4&kind=managed&code=abcdefghijklmnopqrstuvwxyzABCDEFG_123456789&api=http%3A%2F%2Fremote.example',
    'mesh://join?v=4&kind=managed&code=abcdefghijklmnopqrstuvwxyzABCDEFG_123456789&api=https%3A%2F%2Fmesh.example&extra=1',
  ])('rejects unsafe managed invitation forms: %s', (link) => {
    expect(parseManagedCommunityInvite(link)).toBeNull()
  })
})
