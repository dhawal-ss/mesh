import { describe, expect, it } from 'vitest'

import {
  mentionDisplayToken,
  parseStructuredMentionDraft,
  reconcileStructuredMentions,
  retainStructuredMentionUserIds,
  serializeStructuredMentionDraft,
  structuredMentionUserIds,
  type StructuredMention,
} from './structured-mentions'

describe('structured mentions', () => {
  it('keeps the visible draft conventional while round-tripping hidden account metadata', () => {
    const body = 'Hello @Alice & @Rohan\nWelcome.'
    const mentions: StructuredMention[] = [
      { start: 6, end: 12, userId: '@alice:example.org' },
      { start: 15, end: 21, userId: '@rohan:mesh.test' },
    ]

    const formattedBody = serializeStructuredMentionDraft(body, mentions)

    expect(formattedBody).toContain('https://matrix.to/#/%40alice%3Aexample.org')
    expect(formattedBody).not.toContain('@alice:example.org')
    expect(parseStructuredMentionDraft(body, formattedBody)).toEqual(mentions)
  })

  it('drops metadata when a user edits inside a mention and shifts later mentions safely', () => {
    const body = '@Alice meet @Rohan'
    const mentions: StructuredMention[] = [
      { start: 0, end: 6, userId: '@alice:example.org' },
      { start: 12, end: 18, userId: '@rohan:example.org' },
    ]

    expect(reconcileStructuredMentions(body, '@Alicia meet @Rohan', mentions)).toEqual([
      { start: 13, end: 19, userId: '@rohan:example.org' },
    ])
  })

  it('deduplicates notification recipients without changing repeated visible mentions', () => {
    const body = '@Alice and @Alice'
    const mentions: StructuredMention[] = [
      { start: 0, end: 6, userId: '@alice:example.org' },
      { start: 11, end: 17, userId: '@alice:example.org' },
    ]

    expect(structuredMentionUserIds(body, mentions)).toEqual(['@alice:example.org'])
  })

  it('rejects mismatched or unsafe formatted draft content', () => {
    expect(parseStructuredMentionDraft(
      'Hello @Alice',
      '<p>Hello <a href="javascript:alert(1)">@Alice</a></p>',
    )).toEqual([])
    expect(parseStructuredMentionDraft(
      'Hello @Alice',
      '<p>Changed <a href="https://matrix.to/#/%40alice%3Aexample.org">@Alice</a></p>',
    )).toEqual([])
  })

  it('normalizes display names into one visible token', () => {
    expect(mentionDisplayToken('  Alice   Chen  ')).toBe('@Alice Chen')
  })

  it('keeps edit notifications only while the visible display token remains intact', () => {
    const members = [{ publicKey: '@alice:example.org', displayName: 'Alice Chen' }]

    expect(retainStructuredMentionUserIds(
      'Hello @Alice Chen.',
      ['@alice:example.org'],
      members,
    )).toEqual(['@alice:example.org'])
    expect(retainStructuredMentionUserIds(
      'Hello @Alice Cheng.',
      ['@alice:example.org'],
      members,
    )).toEqual([])
  })
})
