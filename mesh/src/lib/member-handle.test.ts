import { describe, expect, it } from 'vitest'
import { memberDisambiguationHandle } from './member-handle'

describe('memberDisambiguationHandle', () => {
  it('stays absent for a unique display name', () => {
    const member = { publicKey: '@maya:example.org', displayName: 'Maya' }
    expect(memberDisambiguationHandle(member, [member])).toBeNull()
  })

  it('uses only the short local handle for duplicate names', () => {
    const members = [
      { publicKey: '@maya:example.org', displayName: 'Maya' },
      { publicKey: '@maya.chen:another.example', displayName: 'Maya' },
    ]
    const handle = memberDisambiguationHandle(members[0], members)
    expect(handle).toBe('@maya')
    expect(handle).not.toContain(':')
    expect(handle).not.toContain('example.org')
  })

  it('adds a stable non-protocol tag when local handles also collide', () => {
    const members = [
      { publicKey: '@maya:first.example', displayName: 'Maya' },
      { publicKey: '@maya:second.example', displayName: 'Maya' },
    ]
    const first = memberDisambiguationHandle(members[0], members)
    const second = memberDisambiguationHandle(members[1], members)
    expect(first).toMatch(/^@maya · [A-Z0-9]{4}$/)
    expect(second).toMatch(/^@maya · [A-Z0-9]{4}$/)
    expect(first).not.toBe(second)
    expect(`${first}${second}`).not.toContain('example')
  })
})
