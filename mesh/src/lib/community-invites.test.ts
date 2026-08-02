import { describe, expect, it } from 'vitest'
import {
  isMeshJoinLink,
  parseCommunityInvite,
  parseCommunityInviteV5,
  parseAdmissionCommunityInvite,
  parseMatrixCommunityInvite,
} from './community-invites'
import corpus from './community-invite-corpus.json'

describe('shared community invite corpus', () => {
  for (const fixture of corpus) {
    it(`${fixture.accept ? 'accepts' : 'rejects'} ${fixture.name}`, () => {
      const parsed = parseCommunityInviteV5(fixture.url)
      if (!fixture.accept) {
        expect(parsed).toBeNull()
        return
      }
      expect(parsed).toMatchObject({
        via: fixture.via,
        viaTruncated: fixture.viaTruncated,
      })
    })
  }
})

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
    `mesh://${['user', 'secret'].join(':')}@join?v=3&kind=matrix&room=!room:mesh.example&via=mesh.example`,
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

  it('parses legacy one-use admission links without confusing them with room links', () => {
    const code = 'abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
    const publicLink = `https://mesh.example/invite/${code}`
    const deepLink =
      `mesh://join?v=4&kind=managed&code=${code}&api=https%3A%2F%2Fmesh.example`

    expect(parseAdmissionCommunityInvite(publicLink)).toMatchObject({
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

  it('parses the versioned account-independent community contract', () => {
    const code = 'abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
    const link =
      `mesh://join?v=5&kind=community&room=!garden%3Acommunity.example`
      + `&via=community.example&community_service=https%3A%2F%2Fmatrix.community.example`
      + `&admission=https%3A%2F%2Finvites.community.example&code=${code}`
      + `&resume=https%3A%2F%2Finvites.community.example%2Finvite%2F${code}`

    expect(parseCommunityInviteV5(link)).toMatchObject({
      kind: 'community',
      version: 5,
      roomOrAlias: '!garden:community.example',
      via: ['community.example'],
      communityService: 'https://matrix.community.example',
      admissionOrigin: 'https://invites.community.example',
      admissionCode: code,
    })
    expect(parseAdmissionCommunityInvite(link)).not.toBeNull()
    expect(parseMatrixCommunityInvite(link)).not.toBeNull()
  })

  it('supports a version 5 federated room without an account-registration offer', () => {
    const link =
      'mesh://join?v=5&kind=community&room=!garden%3Acommunity.example'
      + '&via=community.example&community_service=https%3A%2F%2Fmatrix.community.example'

    expect(parseCommunityInvite(link)).toMatchObject({
      kind: 'community',
      admissionOrigin: null,
      admissionCode: null,
    })
    expect(parseAdmissionCommunityInvite(link)).toBeNull()
  })

  it.each([
    ['live occupancy', 'occupancy=7'],
    ['member identities', 'members=alice%2Cbob'],
    ['access token', 'access_token=fixture-token'],
    ['recovery material', 'recovery_key=fixture-recovery'],
    ['raw device key', 'device_key=fixture-device-key'],
    ['voice credential', 'turn_password=fixture-voice-credential'],
    ['private history', 'history=fixture-private-history'],
  ])('rejects version 5 metadata that could leak %s', (_label, field) => {
    const link =
      'mesh://join?v=5&kind=community&room=!garden%3Acommunity.example'
      + `&via=community.example&${field}`

    expect(parseCommunityInviteV5(link)).toBeNull()
  })

  it.each([
    'http://mesh.example/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789',
    `https://${['user', 'secret'].join(':')}@mesh.example/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789`,
    'https://mesh.example/invite/too-short',
    'https://mesh.example/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789?next=elsewhere',
    'mesh://join?v=4&kind=managed&code=abcdefghijklmnopqrstuvwxyzABCDEFG_123456789&api=http%3A%2F%2Fremote.example',
    'mesh://join?v=4&kind=managed&code=abcdefghijklmnopqrstuvwxyzABCDEFG_123456789&api=https%3A%2F%2Fmesh.example&extra=1',
    'mesh://join?v=5&kind=community&room=!room%3Amesh.example&via=mesh.example&admission=https%3A%2F%2Finvites.example',
    'mesh://join?v=5&kind=community&room=!room%3Amesh.example&via=mesh.example&code=abcdefghijklmnopqrstuvwxyzABCDEFG_123456789',
  ])('rejects unsafe legacy admission invitation forms: %s', (link) => {
    expect(parseAdmissionCommunityInvite(link)).toBeNull()
  })
})
