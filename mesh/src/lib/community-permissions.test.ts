import { describe, expect, it } from 'vitest'
import {
  COMMUNITY_ROLE_TEMPLATES,
  aggregateCommunityPermissionProjection,
  compareCommunityRolePermissions,
  evaluateAuthoritativeCommunityRoleAssignment,
  evaluateCommunityRoleAssignment,
  explainCommunityPermissionProjection,
  getEffectiveCommunityPermissions,
  scopeCommunityPermissionProjectionToRoom,
  MATRIX_COMMUNITY_PERMISSION_POLICY_V1,
  type CommunityPermissionProjection,
  type MatrixRoomPermissionProjection,
} from './community-permissions'

describe('Matrix-backed community role templates', () => {
  it('compiles the three truthful product roles to explicit Matrix power levels', () => {
    expect(COMMUNITY_ROLE_TEMPLATES.owner.powerLevel).toBe(100)
    expect(COMMUNITY_ROLE_TEMPLATES.owner.assignable).toBe(false)
    expect(COMMUNITY_ROLE_TEMPLATES.admin.powerLevel).toBe(50)
    expect(COMMUNITY_ROLE_TEMPLATES.member.powerLevel).toBe(0)
    expect(MATRIX_COMMUNITY_PERMISSION_POLICY_V1.powerLevelsEvent).toBe(100)
  })

  it('keeps role and security changes above the administrator power level', () => {
    const permissions = getEffectiveCommunityPermissions(
      'admin',
      MATRIX_COMMUNITY_PERMISSION_POLICY_V1,
    )
    expect(permissions.find((permission) => permission.id === 'ban')?.granted).toBe(true)
    expect(permissions.find((permission) => permission.id === 'roomState')?.granted).toBe(true)
    expect(permissions.find((permission) => permission.id === 'roles')).toMatchObject({
      granted: false,
      requiredPowerLevel: 100,
      enforcement: 'matrix-room-state',
    })
  })

  it('previews the concrete permission change before an administrator is promoted or demoted', () => {
    const promoted = compareCommunityRolePermissions(
      'member',
      'admin',
      MATRIX_COMMUNITY_PERMISSION_POLICY_V1,
    )
    expect(promoted.gained.map((permission) => permission.id)).toEqual([
      'redact',
      'remove',
      'ban',
      'roomState',
    ])
    expect(promoted.lost).toEqual([])

    const demoted = compareCommunityRolePermissions(
      'admin',
      'member',
      MATRIX_COMMUNITY_PERMISSION_POLICY_V1,
    )
    expect(demoted.lost.map((permission) => permission.id)).toEqual([
      'redact',
      'remove',
      'ban',
      'roomState',
    ])
  })

  it('blocks lower-role escalation, self-assignment, and the final-owner failure path', () => {
    expect(evaluateCommunityRoleAssignment({
      actorRole: 'admin',
      targetRole: 'member',
      nextRole: 'admin',
    })).toEqual({
      allowed: false,
      reason: 'Only the community owner can change member roles.',
    })
    expect(evaluateCommunityRoleAssignment({
      actorRole: 'owner',
      targetRole: 'member',
      nextRole: 'admin',
      isSelf: true,
    }).allowed).toBe(false)
    expect(evaluateCommunityRoleAssignment({
      actorRole: 'owner',
      targetRole: 'owner',
      nextRole: 'member',
      effectiveOwnerCount: 1,
    }).reason).toContain('final owner')
    expect(evaluateCommunityRoleAssignment({
      actorRole: 'owner',
      targetRole: 'member',
      nextRole: 'admin',
    })).toEqual({ allowed: true, reason: null })
  })
})

describe('authoritative per-room community permissions', () => {
  it('distinguishes permissions granted everywhere, in some rooms, and nowhere', () => {
    const projection = communityProjection([
      loadedRoom('!space:example.org', 'Community', {
        'm.room.power_levels': 100,
      }),
      loadedRoom('!remote:elsewhere.org', 'Federated support', {
        'm.room.power_levels': 75,
      }),
    ])

    const member = aggregateCommunityPermissionProjection(projection, {
      kind: 'proposed-role',
      userId: '@member:example.org',
      role: 'member',
    })
    expect(member.find((permission) => permission.permissionId === 'participate')?.status)
      .toBe('granted-everywhere')
    expect(member.find((permission) => permission.permissionId === 'ban')?.status)
      .toBe('not-granted')

    const admin = aggregateCommunityPermissionProjection(projection, {
      kind: 'proposed-role',
      userId: '@member:example.org',
      role: 'admin',
    })
    expect(admin.find((permission) => permission.permissionId === 'roles')).toMatchObject({
      status: 'not-granted',
      verifiedRoomCount: 2,
      totalRoomCount: 2,
    })
    expect(admin.find((permission) => permission.permissionId === 'roomState')?.status)
      .toBe('granted-everywhere')
  })

  it('treats any missing, inaccessible, failed, or undiscovered room as unknown', () => {
    for (const status of ['inaccessible', 'unsupported', 'failed'] as const) {
      const projection = communityProjection([
        loadedRoom('!space:example.org', 'Community'),
        {
          roomId: '!child:remote.org',
          roomName: 'Remote room',
          roomKind: 'room',
          status,
          policy: null,
          failureReason: 'Permission state unavailable.',
        },
      ])
      expect(aggregateCommunityPermissionProjection(projection, {
        kind: 'current-user',
        userId: '@owner:example.org',
      }).every((permission) => permission.status === 'unknown')).toBe(true)
    }

    const incomplete = communityProjection(
      [loadedRoom('!space:example.org', 'Community')],
      false,
    )
    expect(aggregateCommunityPermissionProjection(incomplete, {
      kind: 'current-user',
      userId: '@owner:example.org',
    }).every((permission) => permission.status === 'unknown')).toBe(true)
  })

  it('applies Matrix defaults explicitly and reacts deterministically to remote edits', () => {
    const defaulted = loadedRoom('!space:example.org', 'Community', {})
    defaulted.status = 'matrix-default'
    const before = communityProjection([defaulted])
    expect(aggregateCommunityPermissionProjection(before, {
      kind: 'proposed-role',
      userId: '@member:example.org',
      role: 'admin',
    }).find((permission) => permission.permissionId === 'roles')?.status)
      .toBe('granted-everywhere')

    const remotelyEdited = structuredClone(before)
    remotelyEdited.rooms[0].policy!.events['m.room.power_levels'] = 100
    expect(aggregateCommunityPermissionProjection(remotelyEdited, {
      kind: 'proposed-role',
      userId: '@member:example.org',
      role: 'admin',
    }).find((permission) => permission.permissionId === 'roles')?.status)
      .toBe('not-granted')

    const afterRestart = JSON.parse(
      JSON.stringify(remotelyEdited),
    ) as CommunityPermissionProjection
    expect(aggregateCommunityPermissionProjection(afterRestart, {
      kind: 'proposed-role',
      userId: '@member:example.org',
      role: 'admin',
    })).toEqual(aggregateCommunityPermissionProjection(remotelyEdited, {
      kind: 'proposed-role',
      userId: '@member:example.org',
      role: 'admin',
    }))
  })

  it('blocks escalation and removal of the last effective owner from authoritative state', () => {
    const projection = communityProjection([
      loadedRoom('!space:example.org', 'Community'),
      loadedRoom('!child:example.org', 'General'),
    ])
    expect(evaluateAuthoritativeCommunityRoleAssignment({
      projection,
      actorUserId: '@admin:example.org',
      targetUserId: '@member:example.org',
      nextRole: 'admin',
    }).allowed).toBe(false)

    expect(evaluateAuthoritativeCommunityRoleAssignment({
      projection,
      actorUserId: '@owner:example.org',
      targetUserId: '@owner:example.org',
      nextRole: 'member',
    }).allowed).toBe(false)

    const ownerChangingAnotherOwner = communityProjection([
      loadedRoom('!space:example.org', 'Community', undefined, {
        '@owner:example.org': 100,
        '@backup:example.org': 100,
      }),
    ])
    expect(evaluateAuthoritativeCommunityRoleAssignment({
      projection: ownerChangingAnotherOwner,
      actorUserId: '@owner:example.org',
      targetUserId: '@backup:example.org',
      nextRole: 'member',
    })).toEqual({ allowed: true, reason: null })

    const noRecoveryAfterHardening = communityProjection([
      loadedRoom(
        '!space:example.org',
        'Community',
        { 'm.room.power_levels': 50 },
        {
          '@owner:example.org': 50,
          '@member:example.org': 0,
        },
      ),
    ])
    expect(evaluateAuthoritativeCommunityRoleAssignment({
      projection: noRecoveryAfterHardening,
      actorUserId: '@owner:example.org',
      targetUserId: '@member:example.org',
      nextRole: 'admin',
    }).reason).toContain('no effective owner')
  })
})

describe('explaining which rooms are behind a permission verdict', () => {
  const splitProjection = () => communityProjection([
    loadedRoom('!general:example.org', 'General', undefined, { '@bob:example.org': 50 }),
    loadedRoom('!announce:example.org', 'Announcements', undefined, { '@bob:example.org': 0 }),
  ])

  it('names the rooms that grant and refuse a partially granted permission', () => {
    const explained = explainCommunityPermissionProjection(splitProjection(), {
      kind: 'current-user',
      userId: '@bob:example.org',
    })
    const redact = explained.find((permission) => permission.permissionId === 'redact')

    expect(redact).toMatchObject({
      status: 'granted-some-rooms',
      grantedRoomCount: 1,
      verifiedRoomCount: 2,
    })
    expect(redact?.grantedRooms.map((room) => room.roomName)).toEqual(['General'])
    expect(redact?.deniedRooms.map((room) => room.roomName)).toEqual(['Announcements'])
    expect(redact?.unreadableRooms).toEqual([])
  })

  it('reports a room it could not read as unreadable rather than as a refusal', () => {
    const projection = communityProjection([
      loadedRoom('!general:example.org', 'General', undefined, { '@bob:example.org': 50 }),
      {
        roomId: '!private:example.org',
        roomName: 'Private room',
        roomKind: 'room',
        status: 'inaccessible',
        failureReason: 'Mesh is not in this room.',
        policy: null,
      },
    ])

    const redact = explainCommunityPermissionProjection(projection, {
      kind: 'current-user',
      userId: '@bob:example.org',
    }).find((permission) => permission.permissionId === 'redact')

    expect(redact?.status).toBe('unknown')
    expect(redact?.unreadableRooms.map((room) => room.roomName)).toEqual(['Private room'])
    // The unreadable room must never be presented as a denial.
    expect(redact?.deniedRooms).toEqual([])
    expect(redact?.verifiedRoomCount).toBe(1)
    expect(redact?.totalRoomCount).toBe(2)
  })

  it('agrees with the aggregate it is derived from', () => {
    const projection = splitProjection()
    const target = { kind: 'current-user' as const, userId: '@bob:example.org' }
    const aggregate = aggregateCommunityPermissionProjection(projection, target)
    const explained = explainCommunityPermissionProjection(projection, target)

    expect(explained.map(({ grantedRooms: _g, deniedRooms: _d, unreadableRooms: _u, ...rest }) => rest))
      .toEqual(aggregate)
  })
})

describe('scoping a community projection to one room', () => {
  it('keeps only the requested room and re-derives discovery for that question', () => {
    const projection = communityProjection([
      loadedRoom('!general:example.org', 'General'),
      loadedRoom('!announce:example.org', 'Announcements'),
    ], false)

    const scoped = scopeCommunityPermissionProjectionToRoom(projection, '!general:example.org')

    expect(scoped?.rooms.map((room) => room.roomName)).toEqual(['General'])
    // Incomplete community discovery says nothing about a room already in hand,
    // so the scoped question is answerable even when the community one is not.
    expect(scoped?.discoveryComplete).toBe(true)
  })

  it('returns null for a room the projection does not contain', () => {
    const projection = communityProjection([loadedRoom('!general:example.org', 'General')])
    expect(scopeCommunityPermissionProjectionToRoom(projection, '!missing:example.org')).toBeNull()
  })

  it('answers a single room without inventing a partial verdict', () => {
    const projection = communityProjection([
      loadedRoom('!general:example.org', 'General', undefined, { '@bob:example.org': 50 }),
      loadedRoom('!announce:example.org', 'Announcements', undefined, { '@bob:example.org': 0 }),
    ])
    const scoped = scopeCommunityPermissionProjectionToRoom(projection, '!announce:example.org')!

    const redact = explainCommunityPermissionProjection(scoped, {
      kind: 'current-user',
      userId: '@bob:example.org',
    }).find((permission) => permission.permissionId === 'redact')

    expect(redact?.status).toBe('not-granted')
    expect(redact?.grantedRooms).toEqual([])
  })
})

function communityProjection(
  rooms: MatrixRoomPermissionProjection[],
  discoveryComplete = true,
): CommunityPermissionProjection {
  return {
    communityId: '!space:example.org',
    subjectUserId: '@owner:example.org',
    discoveryComplete,
    discoveryFailureReason: discoveryComplete ? null : 'Nested rooms could not be listed.',
    rooms,
    aggregate: [],
  }
}

function loadedRoom(
  roomId: string,
  roomName: string,
  events: Record<string, number> = { 'm.room.power_levels': 100 },
  users: Record<string, number> = {
    '@owner:example.org': 100,
    '@admin:example.org': 50,
    '@member:example.org': 0,
  },
): MatrixRoomPermissionProjection {
  return {
    roomId,
    roomName,
    roomKind: roomId.includes('space') ? 'space' : 'room',
    status: 'loaded',
    failureReason: null,
    policy: {
      users,
      usersDefault: 0,
      events,
      eventsDefault: 0,
      stateDefault: 50,
      ban: 50,
      kick: 50,
      invite: 0,
      redact: 50,
      notifications: { room: 50 },
      creatorUserIds: ['@owner:example.org'],
      privilegedCreatorUserIds: [],
    },
  }
}
