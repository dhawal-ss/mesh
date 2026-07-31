import { describe, expect, it } from 'vitest'
import {
  ADVANCED_PERMISSION_LAYER_ORDER,
  explainAdvancedPermission,
  resolveAdvancedPermission,
  validateAdvancedPermissionDocument,
  type AdvancedPermissionAuthority,
  type AdvancedPermissionDocument,
  type AdvancedPermissionEffect,
  type AdvancedPermissionLayer,
  type AdvancedPermissionRule,
} from './advanced-permissions'

const authority: AdvancedPermissionAuthority = {
  communityId: '!space:example.org',
  controlRoomId: '!space:example.org',
  revision: '$power-levels-v4',
  neededPower: 50,
  powerByUserId: {
    '@owner:example.org': 100,
    '@admin:example.org': 50,
    '@member:example.org': 0,
  },
  ownerUserIds: new Set(['@owner:example.org']),
}

function rule(
  id: string,
  effect: AdvancedPermissionEffect,
  author = '@admin:example.org',
): AdvancedPermissionRule {
  return {
    id,
    permission: 'send',
    subjectId: '@member:example.org',
    effect,
    authoredBy: author,
    claimedAuthorPower: authority.powerByUserId[author] ?? 0,
    claimedNeededPower: authority.neededPower,
  }
}

function documentWith(
  rules: Partial<Record<AdvancedPermissionLayer, AdvancedPermissionRule[]>>,
): AdvancedPermissionDocument {
  return {
    schemaVersion: 1,
    communityId: authority.communityId,
    controlRoomId: authority.controlRoomId,
    authorityRevision: authority.revision,
    layers: Object.fromEntries(
      ADVANCED_PERMISSION_LAYER_ORDER.map((layer) => [layer, rules[layer] ?? []]),
    ) as Record<AdvancedPermissionLayer, AdvancedPermissionRule[]>,
  }
}

describe('Advanced permission schema and resolution', () => {
  it('uses fixed specificity ordering and deterministic id ordering for ties', () => {
    const document = documentWith({
      'server-group': [rule('server', 'allow')],
      'channel-group': [rule('channel', 'deny')],
      'channel-override': [rule('z-last', 'allow'), rule('a-first', 'deny')],
    })
    const result = resolveAdvancedPermission({
      document,
      authority,
      permission: 'send',
      subjectId: '@member:example.org',
    })
    expect(result).toMatchObject({
      status: 'allowed',
      layer: 'channel-override',
      ruleId: 'z-last',
    })
  })

  it('defines skip as no decision and negate as inversion of the prior decision', () => {
    expect(resolveAdvancedPermission({
      document: documentWith({
        'server-group': [rule('allow', 'allow')],
        'client-override': [rule('skip', 'skip')],
        'channel-override': [rule('negate', 'negate')],
      }),
      authority,
      permission: 'send',
      subjectId: '@member:example.org',
    }).status).toBe('denied')

    expect(resolveAdvancedPermission({
      document: documentWith({
        'channel-override': [rule('negate-without-grant', 'negate')],
      }),
      authority,
      permission: 'send',
      subjectId: '@member:example.org',
    }).status).toBe('denied')
  })

  it('fails closed for stale authority, insufficient power, and room upgrades', () => {
    const baseline = documentWith({ 'server-group': [rule('allow', 'allow')] })
    for (const changed of [
      { ...authority, revision: '$new-revision' },
      { ...authority, controlRoomId: '!replacement:example.org' },
      {
        ...authority,
        powerByUserId: { ...authority.powerByUserId, '@admin:example.org': 0 },
      },
    ]) {
      expect(resolveAdvancedPermission({
        document: baseline,
        authority: changed,
        permission: 'send',
        subjectId: '@member:example.org',
      }).status).toBe('unsupported')
    }
  })

  it('fails closed for malicious shapes and values', () => {
    const baseline = documentWith({ 'server-group': [rule('allow', 'allow')] })
    const corruptions: unknown[] = [
      { ...baseline, schemaVersion: 2 },
      { ...baseline, layers: { ...baseline.layers, 'server-group': 'allow' } },
      documentWith({
        'server-group': [{ ...rule('nan', 'allow'), claimedAuthorPower: Number.NaN }],
      }),
      documentWith({
        'server-group': [{ ...rule('huge', 'allow'), claimedNeededPower: 10_000 }],
      }),
      documentWith({
        'server-group': [{ ...rule('unknown', 'allow'), effect: 'inherit' as 'allow' }],
      }),
    ]
    for (const malformed of corruptions) {
      expect(validateAdvancedPermissionDocument(malformed)).toBe(false)
      expect(resolveAdvancedPermission({
        document: malformed,
        authority,
        permission: 'send',
        subjectId: '@member:example.org',
      }).status).toBe('unsupported')
    }
  })

  it('protects owners and provides a plain why explanation', () => {
    const ownerRule = {
      ...rule('remove-owner', 'deny', '@owner:example.org'),
      permission: 'roles',
      subjectId: '@owner:example.org',
    }
    const result = resolveAdvancedPermission({
      document: documentWith({ 'channel-override': [ownerRule] }),
      authority,
      permission: 'roles',
      subjectId: '@owner:example.org',
    })
    expect(result.status).toBe('unsupported')
    expect(explainAdvancedPermission(result)).toContain('recovery path')
  })

  it('remains deterministic across generated layer/effect combinations', () => {
    const effects: AdvancedPermissionEffect[] = ['allow', 'deny', 'skip', 'negate']
    for (let seed = 0; seed < 128; seed += 1) {
      const layers: Partial<Record<AdvancedPermissionLayer, AdvancedPermissionRule[]>> = {}
      ADVANCED_PERMISSION_LAYER_ORDER.forEach((layer, index) => {
        layers[layer] = [rule(`${seed}-${index}`, effects[(seed + index) % effects.length])]
      })
      const document = documentWith(layers)
      const first = resolveAdvancedPermission({
        document,
        authority,
        permission: 'send',
        subjectId: '@member:example.org',
      })
      const second = resolveAdvancedPermission({
        document: structuredClone(document),
        authority,
        permission: 'send',
        subjectId: '@member:example.org',
      })
      expect(second).toEqual(first)
    }
  })
})
