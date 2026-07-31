import { describe, expect, it } from 'vitest'
import {
  evaluateChannelLifecycle,
  evaluateTemporaryChannelCreation,
  type ChannelLifetimePolicy,
  type ChannelLifecycleSnapshot,
} from './channel-lifecycle'

const policy: ChannelLifetimePolicy = {
  schemaVersion: 1,
  mode: 'archive-when-empty',
  parentRoomId: '!space:example.org',
  emptyGraceMs: 60_000,
  retentionMaxLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  allowOwnerRecovery: true,
}

const snapshot: ChannelLifecycleSnapshot = {
  roomId: '!temporary:example.org',
  state: 'active',
  occupiedMemberCount: 0,
  becameEmptyAt: null,
  replacementRoomId: null,
  federated: true,
}

describe('honest Matrix channel lifetime semantics', () => {
  it('starts a grace period, cancels it on occupancy, then archives without deletion claims', () => {
    const now = new Date('2026-07-31T12:00:00.000Z')
    const starting = evaluateChannelLifecycle({ policy, snapshot, now })
    expect(starting).toMatchObject({
      action: 'start-grace',
      nextState: 'grace',
      dueAt: '2026-07-31T12:01:00.000Z',
      deletionGuaranteed: false,
    })

    const occupied = evaluateChannelLifecycle({
      policy,
      snapshot: { ...snapshot, state: 'grace', occupiedMemberCount: 1 },
      now,
    })
    expect(occupied).toMatchObject({ action: 'recover', nextState: 'active' })

    const archived = evaluateChannelLifecycle({
      policy,
      snapshot: {
        ...snapshot,
        state: 'grace',
        becameEmptyAt: '2026-07-31T12:00:00.000Z',
      },
      now: new Date('2026-07-31T12:02:00.000Z'),
    })
    expect(archived).toMatchObject({
      action: 'archive',
      nextState: 'archived',
      deletionGuaranteed: false,
    })
    expect(archived.reason).toContain('not guaranteed deleted')
  })

  it('supports explicit owner recovery and treats tombstones as stable', () => {
    expect(evaluateChannelLifecycle({
      policy,
      snapshot: { ...snapshot, state: 'archived' },
      now: new Date(),
      recover: true,
      actorIsOwner: true,
    }).action).toBe('recover')
    expect(evaluateChannelLifecycle({
      policy,
      snapshot: { ...snapshot, state: 'tombstoned' },
      now: new Date(),
    }).nextState).toBe('tombstoned')
  })

  it('blocks restart-scoped lifetime because federation has no shared restart', () => {
    const result = evaluateChannelLifecycle({
      policy: { ...policy, mode: 'restart-scoped' },
      snapshot,
      now: new Date(),
    })
    expect(result).toMatchObject({ action: 'reject', deletionGuaranteed: false })
    expect(result.reason).toContain('no stable meaning')
  })

  it('scopes creation to the parent, rate limit, audit trail, and existing power', () => {
    const authority = {
      designatedParentRoomId: policy.parentRoomId,
      actorPower: 50,
      canCreateChild: true,
      maximumChildCreatorPower: 50,
      creationsInWindow: 1,
      creationLimit: 3,
    }
    const request = {
      actorUserId: '@admin:example.org',
      parentRoomId: policy.parentRoomId,
      requestedCreatorPower: 50,
      auditId: 'audit-1',
    }
    expect(evaluateTemporaryChannelCreation(request, authority)).toEqual({
      allowed: true,
      reason: null,
    })
    expect(evaluateTemporaryChannelCreation(
      { ...request, parentRoomId: '!other:example.org' },
      authority,
    ).allowed).toBe(false)
    expect(evaluateTemporaryChannelCreation(
      { ...request, requestedCreatorPower: 100 },
      authority,
    ).reason).toContain('extra power')
    expect(evaluateTemporaryChannelCreation(
      request,
      { ...authority, creationsInWindow: 3 },
    ).reason).toContain('limit')
  })

  it('is restart-stable because decisions derive from persisted timestamps', () => {
    const input = {
      policy,
      snapshot: {
        ...snapshot,
        state: 'grace' as const,
        becameEmptyAt: '2026-07-31T12:00:00.000Z',
      },
      now: new Date('2026-07-31T12:00:30.000Z'),
    }
    expect(evaluateChannelLifecycle(input)).toEqual(evaluateChannelLifecycle({
      ...structuredClone(input),
      now: new Date('2026-07-31T12:00:30.000Z'),
    }))
  })
})
