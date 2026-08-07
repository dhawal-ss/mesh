import { beforeEach, describe, expect, it } from 'vitest'
import { useMembershipStore, type MemberRecord } from './membership'

function member(publicKey: string, displayName = publicKey): MemberRecord {
  return {
    publicKey,
    displayName,
    avatarColor: '#607080',
    role: 'member',
    joinStatus: 'joined',
    banStatus: 'none',
    lastSeen: null,
    online: false,
  }
}

describe('bounded membership pages', () => {
  beforeEach(() => {
    useMembershipStore.setState({
      memberEntities: {},
      memberOrder: {},
      members: {},
      rosterNextCursor: {},
      rosterStateComplete: {},
    })
  })

  it('replaces the initial page and appends later pages without duplicates', () => {
    const first = member('@a:mesh.test', 'A')
    const second = member('@b:mesh.test', 'B')
    useMembershipStore.getState().setRosterPage(
      '!community:mesh.test',
      [first],
      '@a:mesh.test',
      false,
      false,
    )
    useMembershipStore.getState().setRosterPage(
      '!community:mesh.test',
      [first, second],
      null,
      true,
      true,
    )

    const state = useMembershipStore.getState()
    expect(state.memberOrder['!community:mesh.test']).toEqual([
      '@a:mesh.test',
      '@b:mesh.test',
    ])
    expect(state.members['!community:mesh.test']).toHaveLength(2)
    expect(state.memberEntities['!community:mesh.test']['@a:mesh.test']).toBe(first)
    expect(state.rosterNextCursor['!community:mesh.test']).toBeNull()
    expect(state.rosterStateComplete['!community:mesh.test']).toBe(true)
  })

  it('drops stale members when an event-driven first page refresh replaces the snapshot', () => {
    useMembershipStore.getState().setRosterPage(
      '!community:mesh.test',
      [member('@old:mesh.test')],
      '@old:mesh.test',
      true,
      false,
    )
    useMembershipStore.getState().setRosterPage(
      '!community:mesh.test',
      [member('@new:mesh.test')],
      null,
      false,
      false,
    )

    const state = useMembershipStore.getState()
    expect(state.memberOrder['!community:mesh.test']).toEqual(['@new:mesh.test'])
    expect(state.memberEntities['!community:mesh.test']['@old:mesh.test']).toBeUndefined()
    expect(state.rosterStateComplete['!community:mesh.test']).toBe(false)
  })

  it('keeps moderation states internally but excludes non-current people from consumer getters', () => {
    const invited = { ...member('@invited:mesh.test'), joinStatus: 'invited' as const }
    const left = { ...member('@left:mesh.test'), joinStatus: 'left' as const }
    const banned = {
      ...member('@banned:mesh.test'),
      joinStatus: 'left' as const,
      banStatus: 'banned' as const,
    }
    useMembershipStore.getState().setRosterPage(
      '!community:mesh.test',
      [member('@joined:mesh.test'), invited, left, banned],
      null,
      true,
      false,
    )

    const state = useMembershipStore.getState()
    expect(state.members['!community:mesh.test']).toHaveLength(4)
    expect(state.memberEntities['!community:mesh.test']['@banned:mesh.test']).toEqual(banned)
    expect(state.getMembersForCommunity('!community:mesh.test').map((entry) => entry.publicKey))
      .toEqual(['@joined:mesh.test'])
    expect(state.getActiveMembersForCommunity('!community:mesh.test').map((entry) => entry.publicKey))
      .toEqual(['@joined:mesh.test'])
    expect(state.getMemberCount('!community:mesh.test')).toBe(1)
  })

  it('clears page cursors and completeness with the community roster', () => {
    useMembershipStore.getState().setRosterPage(
      '!community:mesh.test',
      [member('@a:mesh.test')],
      '@a:mesh.test',
      false,
      false,
    )
    useMembershipStore.getState().clearCommunity('!community:mesh.test')

    const state = useMembershipStore.getState()
    expect(state.members['!community:mesh.test']).toBeUndefined()
    expect('!community:mesh.test' in state.rosterNextCursor).toBe(false)
    expect('!community:mesh.test' in state.rosterStateComplete).toBe(false)
  })
})
