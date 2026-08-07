import type {
  CommunityPermissionAggregate,
  CommunityPermissionAggregateStatus,
  CommunityPermissionId,
  CommunityPermissionProjection,
  MatrixRoomPermissionProjection,
  MatrixRoomPowerLevelProjection,
} from '../types/ipc'

export type {
  CommunityPermissionAggregate,
  CommunityPermissionAggregateStatus,
  CommunityPermissionId,
  CommunityPermissionProjection,
  MatrixPermissionRoomStatus,
  MatrixRoomPermissionProjection,
  MatrixRoomPowerLevelProjection,
} from '../types/ipc'

export type CommunityRole = 'owner' | 'admin' | 'member'

export interface MatrixCommunityPermissionPolicy {
  eventsDefault: number
  invite: number
  redact: number
  kick: number
  ban: number
  stateDefault: number
  powerLevelsEvent: number
}

export interface CommunityRoleTemplate {
  id: CommunityRole
  label: string
  summary: string
  powerLevel: number
  assignable: boolean
}

export interface EffectiveCommunityPermission {
  id: CommunityPermissionId
  label: string
  description: string
  scope: 'conversation' | 'members' | 'rooms' | 'security'
  requiredPowerLevel: number
  granted: boolean
  enforcement: 'matrix-room-state'
}

export interface RoleAssignmentDecision {
  allowed: boolean
  reason: string | null
}

export const MATRIX_COMMUNITY_PERMISSION_POLICY_V1: Readonly<MatrixCommunityPermissionPolicy> = {
  eventsDefault: 0,
  invite: 0,
  redact: 50,
  kick: 50,
  ban: 50,
  stateDefault: 50,
  powerLevelsEvent: 100,
}

export const COMMUNITY_ROLE_TEMPLATES: Readonly<Record<CommunityRole, CommunityRoleTemplate>> = {
  owner: {
    id: 'owner',
    label: 'Owner',
    summary: 'Controls roles and the community security policy.',
    powerLevel: 100,
    assignable: false,
  },
  admin: {
    id: 'admin',
    label: 'Administrator',
    summary: 'Moderates members and manages rooms without controlling ownership.',
    powerLevel: 50,
    assignable: true,
  },
  member: {
    id: 'member',
    label: 'Member',
    summary: 'Participates in conversations and can invite people under the default policy.',
    powerLevel: 0,
    assignable: true,
  },
}

type PermissionDefinition = Omit<
  EffectiveCommunityPermission,
  'requiredPowerLevel' | 'granted' | 'enforcement'
> & {
  policyKey: keyof MatrixCommunityPermissionPolicy
}

const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  {
    id: 'participate',
    label: 'Participate in conversations',
    description: 'Send standard messages and reactions where the room permits them.',
    scope: 'conversation',
    policyKey: 'eventsDefault',
  },
  {
    id: 'invite',
    label: 'Invite people',
    description: 'Invite an existing compatible-service account to a room.',
    scope: 'members',
    policyKey: 'invite',
  },
  {
    id: 'redact',
    label: 'Moderate messages',
    description: 'Remove another member’s event when the room accepts the moderation action.',
    scope: 'conversation',
    policyKey: 'redact',
  },
  {
    id: 'remove',
    label: 'Remove members',
    description: 'Remove a member from the community rooms Mesh can reach.',
    scope: 'members',
    policyKey: 'kick',
  },
  {
    id: 'ban',
    label: 'Ban members',
    description: 'Prevent a member from rejoining until a permitted moderator reverses the ban.',
    scope: 'members',
    policyKey: 'ban',
  },
  {
    id: 'roomState',
    label: 'Manage rooms',
    description: 'Change room details and interoperable community structure.',
    scope: 'rooms',
    policyKey: 'stateDefault',
  },
  {
    id: 'roles',
    label: 'Manage roles and security',
    description: 'Change member power levels and the permission policy itself.',
    scope: 'security',
    policyKey: 'powerLevelsEvent',
  },
]

export function getCommunityPermissionMetadata(permissionId: CommunityPermissionId) {
  const { policyKey: _policyKey, ...metadata } = PERMISSION_DEFINITIONS.find(
    (permission) => permission.id === permissionId,
  )!
  return metadata
}

export function getEffectiveCommunityPermissions(
  role: CommunityRole,
  policy: Readonly<MatrixCommunityPermissionPolicy>,
): EffectiveCommunityPermission[] {
  const rolePowerLevel = COMMUNITY_ROLE_TEMPLATES[role].powerLevel
  return PERMISSION_DEFINITIONS.map(({ policyKey, ...permission }) => {
    const requiredPowerLevel = policy[policyKey]
    return {
      ...permission,
      requiredPowerLevel,
      granted: rolePowerLevel >= requiredPowerLevel,
      enforcement: 'matrix-room-state' as const,
    }
  })
}

export function compareCommunityRolePermissions(
  previousRole: CommunityRole,
  nextRole: CommunityRole,
  policy: Readonly<MatrixCommunityPermissionPolicy>,
) {
  const previous = new Map(
    getEffectiveCommunityPermissions(previousRole, policy)
      .map((permission) => [permission.id, permission]),
  )
  const next = getEffectiveCommunityPermissions(nextRole, policy)

  return {
    gained: next.filter((permission) => permission.granted && !previous.get(permission.id)?.granted),
    lost: next.filter((permission) => !permission.granted && previous.get(permission.id)?.granted),
    effective: next,
  }
}

export function evaluateCommunityRoleAssignment({
  actorRole,
  targetRole,
  nextRole,
  isSelf = false,
  effectiveOwnerCount = 1,
}: {
  actorRole: CommunityRole
  targetRole: CommunityRole
  nextRole: CommunityRole
  isSelf?: boolean
  effectiveOwnerCount?: number
}): RoleAssignmentDecision {
  if (actorRole !== 'owner') {
    return {
      allowed: false,
      reason: 'Only the community owner can change member roles.',
    }
  }
  if (isSelf) {
    return {
      allowed: false,
      reason: 'You cannot change your own role.',
    }
  }
  if (targetRole === 'owner') {
    return {
      allowed: false,
      reason: effectiveOwnerCount <= 1
        ? 'The final owner is the community recovery path and cannot be removed.'
        : 'Ownership changes require the separate ownership-transfer flow.',
    }
  }
  if (nextRole === 'owner') {
    return {
      allowed: false,
      reason: 'Ownership changes require the separate ownership-transfer flow.',
    }
  }
  if (targetRole === nextRole) {
    return {
      allowed: false,
      reason: 'This member already has that role.',
    }
  }
  return { allowed: true, reason: null }
}

export type CommunityPermissionTarget =
  | { kind: 'current-user'; userId: string }
  | { kind: 'proposed-role'; userId: string; role: CommunityRole }

export function aggregateCommunityPermissionProjection(
  projection: Pick<CommunityPermissionProjection, 'rooms' | 'discoveryComplete'>,
  target: CommunityPermissionTarget,
): CommunityPermissionAggregate[] {
  const hasUnknownRoom = !projection.discoveryComplete || projection.rooms.some(
    (room) =>
      (room.status !== 'loaded' && room.status !== 'matrix-default')
      || room.policy == null,
  )
  const verifiedRooms = projection.rooms.filter(
    (room): room is MatrixRoomPermissionProjection & { policy: MatrixRoomPowerLevelProjection } =>
      (room.status === 'loaded' || room.status === 'matrix-default') && room.policy != null,
  )

  return PERMISSION_DEFINITIONS.map((definition) => {
    const grantedRoomCount = verifiedRooms.filter((room) => {
      const level = permissionTargetLevel(room.policy, target)
      return level >= permissionThreshold(room.policy, definition.id)
    }).length
    const status: CommunityPermissionAggregateStatus = hasUnknownRoom
      ? 'unknown'
      : grantedRoomCount === verifiedRooms.length && verifiedRooms.length > 0
        ? 'granted-everywhere'
        : grantedRoomCount > 0
          ? 'granted-some-rooms'
          : 'not-granted'
    return {
      permissionId: definition.id,
      status,
      grantedRoomCount,
      verifiedRoomCount: verifiedRooms.length,
      totalRoomCount: projection.rooms.length,
    }
  })
}

export function evaluateAuthoritativeCommunityRoleAssignment({
  projection,
  actorUserId,
  targetUserId,
  nextRole,
}: {
  projection: Pick<CommunityPermissionProjection, 'rooms' | 'discoveryComplete'>
  actorUserId: string
  targetUserId: string
  nextRole: Extract<CommunityRole, 'admin' | 'member'>
}): RoleAssignmentDecision {
  if (actorUserId === targetUserId) {
    return { allowed: false, reason: 'You cannot change your own role.' }
  }

  const actorPermissions = aggregateCommunityPermissionProjection(projection, {
    kind: 'current-user',
    userId: actorUserId,
  })
  const rolePermission = actorPermissions.find((permission) => permission.permissionId === 'roles')
  if (!rolePermission || rolePermission.status === 'unknown') {
    return {
      allowed: false,
      reason: 'Unable to verify role-management permission in every room.',
    }
  }
  if (rolePermission.status !== 'granted-everywhere') {
    return {
      allowed: false,
      reason: 'Your account cannot manage roles in every community room.',
    }
  }

  const nextLevel = COMMUNITY_ROLE_TEMPLATES[nextRole].powerLevel
  for (const room of projection.rooms) {
    if (
      (room.status !== 'loaded' && room.status !== 'matrix-default')
      || room.policy == null
    ) {
      return {
        allowed: false,
        reason: 'Unable to verify the final owner because one or more rooms could not be read.',
      }
    }
    if (room.policy.privilegedCreatorUserIds.includes(targetUserId)) {
      return {
        allowed: false,
        reason: 'A protected room creator cannot be assigned a lower role.',
      }
    }

    const resultingRoleThreshold = Math.max(
      100,
      permissionThreshold(room.policy, 'roles'),
    )
    // The projection describes rooms joined by the authenticated actor, and
    // self-targeting is rejected above. Requiring that actor to retain the
    // resulting role-management authority proves recovery without requesting
    // or returning the complete joined-member roster.
    const resultingActorLevel = actorUserId === targetUserId
      ? nextLevel
      : permissionTargetLevel(
          room.policy,
          { kind: 'current-user', userId: actorUserId },
        )
    const recoveryPathExists = resultingActorLevel >= resultingRoleThreshold
    if (!recoveryPathExists) {
      return {
        allowed: false,
        reason: `${room.roomName} would have no effective owner or recovery path.`,
      }
    }
  }

  return { allowed: true, reason: null }
}

function permissionTargetLevel(
  policy: MatrixRoomPowerLevelProjection,
  target: CommunityPermissionTarget,
): number {
  if (policy.privilegedCreatorUserIds.includes(target.userId)) {
    return Number.POSITIVE_INFINITY
  }
  if (target.kind === 'proposed-role') {
    return COMMUNITY_ROLE_TEMPLATES[target.role].powerLevel
  }
  return policy.users[target.userId] ?? policy.usersDefault
}

function permissionThreshold(
  policy: MatrixRoomPowerLevelProjection,
  permissionId: CommunityPermissionId,
): number {
  switch (permissionId) {
    case 'participate':
      return policy.events['m.room.message'] ?? policy.eventsDefault
    case 'invite':
      return policy.invite
    case 'redact':
      return Math.max(
        policy.redact,
        policy.events['m.room.redaction'] ?? policy.eventsDefault,
      )
    case 'remove':
      return policy.kick
    case 'ban':
      return policy.ban
    case 'roomState':
      return policy.stateDefault
    case 'roles':
      return policy.events['m.room.power_levels'] ?? policy.stateDefault
  }
}
