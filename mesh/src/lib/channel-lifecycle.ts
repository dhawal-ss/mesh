export type ChannelLifetimeMode =
  | 'persistent'
  | 'archive-when-empty'
  | 'restart-scoped'

export type ChannelLifecycleState = 'active' | 'grace' | 'archived' | 'tombstoned'

export interface ChannelLifetimePolicy {
  schemaVersion: 1
  mode: ChannelLifetimeMode
  parentRoomId: string
  emptyGraceMs: number
  retentionMaxLifetimeMs: number | null
  allowOwnerRecovery: boolean
}

export interface ChannelLifecycleSnapshot {
  roomId: string
  state: ChannelLifecycleState
  occupiedMemberCount: number
  becameEmptyAt: string | null
  replacementRoomId: string | null
  federated: boolean
}

export interface ChannelLifecycleDecision {
  action: 'none' | 'start-grace' | 'archive' | 'recover' | 'reject'
  nextState: ChannelLifecycleState
  dueAt: string | null
  reason: string
  deletionGuaranteed: false
}

export interface TemporaryChannelCreationRequest {
  actorUserId: string
  parentRoomId: string
  requestedCreatorPower: number
  auditId: string
}

export interface TemporaryChannelCreationAuthority {
  designatedParentRoomId: string
  actorPower: number
  canCreateChild: boolean
  maximumChildCreatorPower: number
  creationsInWindow: number
  creationLimit: number
}

function validDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 365 * 24 * 60 * 60 * 1000
}

export function validateChannelLifetimePolicy(policy: ChannelLifetimePolicy): boolean {
  return policy.schemaVersion === 1
    && policy.parentRoomId.length > 0
    && validDuration(policy.emptyGraceMs)
    && (
      policy.retentionMaxLifetimeMs == null
      || validDuration(policy.retentionMaxLifetimeMs)
    )
}

/**
 * Matrix rooms are archived or replaced, never described as globally deleted.
 * Remote servers and clients may retain history according to their own lawful
 * and interoperable policies.
 */
export function evaluateChannelLifecycle({
  policy,
  snapshot,
  now,
  recover = false,
  actorIsOwner = false,
}: {
  policy: ChannelLifetimePolicy
  snapshot: ChannelLifecycleSnapshot
  now: Date
  recover?: boolean
  actorIsOwner?: boolean
}): ChannelLifecycleDecision {
  const base = {
    dueAt: null,
    deletionGuaranteed: false as const,
  }
  if (!validateChannelLifetimePolicy(policy)) {
    return {
      ...base,
      action: 'reject',
      nextState: snapshot.state,
      reason: 'The channel lifetime policy is unsupported.',
    }
  }
  if (policy.mode === 'restart-scoped') {
    return {
      ...base,
      action: 'reject',
      nextState: snapshot.state,
      reason: 'Server restart has no stable meaning for a federated community.',
    }
  }
  if (
    recover
    && snapshot.state === 'archived'
    && actorIsOwner
    && policy.allowOwnerRecovery
  ) {
    return {
      ...base,
      action: 'recover',
      nextState: 'active',
      reason: 'An owner may restore this archived room while its Matrix state remains available.',
    }
  }
  if (policy.mode === 'persistent') {
    return {
      ...base,
      action: 'none',
      nextState: snapshot.state,
      reason: 'Persistent rooms do not change state when empty.',
    }
  }
  if (snapshot.occupiedMemberCount > 0) {
    return {
      ...base,
      action: snapshot.state === 'grace' ? 'recover' : 'none',
      nextState: 'active',
      reason: 'The room is occupied.',
    }
  }
  if (snapshot.state === 'archived' || snapshot.state === 'tombstoned') {
    return {
      ...base,
      action: 'none',
      nextState: snapshot.state,
      reason: 'The room already has a non-active lifecycle state.',
    }
  }

  const emptyAt = snapshot.becameEmptyAt ? Date.parse(snapshot.becameEmptyAt) : Number.NaN
  if (!Number.isFinite(emptyAt)) {
    return {
      ...base,
      action: 'start-grace',
      nextState: 'grace',
      dueAt: new Date(now.getTime() + policy.emptyGraceMs).toISOString(),
      reason: 'The empty grace period starts after authoritative occupancy reaches zero.',
    }
  }
  const dueAt = emptyAt + policy.emptyGraceMs
  if (now.getTime() < dueAt) {
    return {
      ...base,
      action: 'none',
      nextState: 'grace',
      dueAt: new Date(dueAt).toISOString(),
      reason: 'The empty grace period is still active.',
    }
  }
  return {
    ...base,
    action: 'archive',
    nextState: 'archived',
    reason: snapshot.federated
      ? 'Archive the room and publish interoperable replacement state; federated history is not guaranteed deleted.'
      : 'Archive the room; history deletion is not guaranteed.',
  }
}

export function evaluateTemporaryChannelCreation(
  request: TemporaryChannelCreationRequest,
  authority: TemporaryChannelCreationAuthority,
): { allowed: boolean; reason: string | null } {
  if (
    !request.actorUserId
    || !request.auditId
    || request.parentRoomId !== authority.designatedParentRoomId
  ) {
    return { allowed: false, reason: 'The request is not scoped to the designated parent.' }
  }
  if (!authority.canCreateChild) {
    return { allowed: false, reason: 'The current Matrix authority does not allow child creation.' }
  }
  if (authority.creationsInWindow >= authority.creationLimit) {
    return { allowed: false, reason: 'The temporary-room creation limit was reached.' }
  }
  if (
    !Number.isSafeInteger(request.requestedCreatorPower)
    || request.requestedCreatorPower > authority.actorPower
    || request.requestedCreatorPower > authority.maximumChildCreatorPower
  ) {
    return { allowed: false, reason: 'Creating this room would grant extra power.' }
  }
  return { allowed: true, reason: null }
}
