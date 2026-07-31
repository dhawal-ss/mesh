export const ADVANCED_PERMISSION_SCHEMA_VERSION = 1 as const

export const ADVANCED_PERMISSION_LAYER_ORDER = [
  'server-group',
  'client-override',
  'channel-group',
  'channel-override',
] as const

export type AdvancedPermissionLayer = typeof ADVANCED_PERMISSION_LAYER_ORDER[number]
export type AdvancedPermissionEffect = 'allow' | 'deny' | 'skip' | 'negate'

export interface AdvancedPermissionRule {
  id: string
  permission: string
  subjectId: string
  effect: AdvancedPermissionEffect
  authoredBy: string
  claimedAuthorPower: number
  claimedNeededPower: number
}

export interface AdvancedPermissionDocument {
  schemaVersion: typeof ADVANCED_PERMISSION_SCHEMA_VERSION
  communityId: string
  controlRoomId: string
  authorityRevision: string
  layers: Readonly<Record<AdvancedPermissionLayer, readonly AdvancedPermissionRule[]>>
}

export interface AdvancedPermissionAuthority {
  communityId: string
  controlRoomId: string
  revision: string
  neededPower: number
  powerByUserId: Readonly<Record<string, number>>
  ownerUserIds: ReadonlySet<string>
}

export interface AdvancedPermissionResolution {
  status: 'allowed' | 'denied' | 'unsupported'
  reason: string
  ruleId: string | null
  layer: AdvancedPermissionLayer | null
}

function validIntegerPower(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= -100 && Number(value) <= 1000
}

function validIdentifier(value: unknown, maximum = 255): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

export function validateAdvancedPermissionDocument(
  value: unknown,
): value is AdvancedPermissionDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as Partial<AdvancedPermissionDocument>
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'communityId',
      'controlRoomId',
      'authorityRevision',
      'layers',
    ])
    || document.schemaVersion !== ADVANCED_PERMISSION_SCHEMA_VERSION
    || !validIdentifier(document.communityId)
    || !validIdentifier(document.controlRoomId)
    || !validIdentifier(document.authorityRevision)
    || !document.layers
    || typeof document.layers !== 'object'
  ) {
    return false
  }

  if (!hasExactKeys(document.layers, ADVANCED_PERMISSION_LAYER_ORDER)) return false
  const ruleIds = new Set<string>()
  return ADVANCED_PERMISSION_LAYER_ORDER.every((layer) => {
    const rules = document.layers?.[layer]
    return Array.isArray(rules) && rules.length <= 500 && rules.every((rule) => {
      const valid = Boolean(
        rule
        && typeof rule === 'object'
        && hasExactKeys(rule, [
          'id',
          'permission',
          'subjectId',
          'effect',
          'authoredBy',
          'claimedAuthorPower',
          'claimedNeededPower',
        ])
        && validIdentifier(rule.id, 128)
        && validIdentifier(rule.permission, 128)
        && validIdentifier(rule.subjectId)
        && ['allow', 'deny', 'skip', 'negate'].includes(rule.effect)
        && validIdentifier(rule.authoredBy)
        && validIntegerPower(rule.claimedAuthorPower)
        && validIntegerPower(rule.claimedNeededPower),
      )
      if (!valid || ruleIds.has(rule.id)) return false
      ruleIds.add(rule.id)
      return true
    })
  })
}

function unsupported(reason: string): AdvancedPermissionResolution {
  return { status: 'unsupported', reason, ruleId: null, layer: null }
}

/**
 * Evaluates a proposed extension document against a fresh authoritative Matrix
 * power-level snapshot. This is a preview/audit primitive, not an enforcement
 * boundary. Until a reviewed federated event and server-side enforcement path
 * exist, product UI must treat every result as non-authoritative.
 */
export function resolveAdvancedPermission({
  document,
  authority,
  permission,
  subjectId,
}: {
  document: unknown
  authority: AdvancedPermissionAuthority
  permission: string
  subjectId: string
}): AdvancedPermissionResolution {
  if (!validateAdvancedPermissionDocument(document)) {
    return unsupported('Unsupported or malformed Advanced permission data.')
  }
  if (
    document.communityId !== authority.communityId
    || document.controlRoomId !== authority.controlRoomId
  ) {
    return unsupported('Permission data belongs to another community room or a replaced room.')
  }
  if (document.authorityRevision !== authority.revision) {
    return unsupported('Permission data was authored against stale authority.')
  }
  if (!validIntegerPower(authority.neededPower)) {
    return unsupported('The authoritative required power is unsupported.')
  }

  let decision: AdvancedPermissionResolution = {
    status: 'denied',
    reason: 'No supported rule grants this permission.',
    ruleId: null,
    layer: null,
  }
  let hasDecision = false

  for (const layer of ADVANCED_PERMISSION_LAYER_ORDER) {
    const matching = document.layers[layer]
      .filter((rule) => rule.permission === permission && rule.subjectId === subjectId)
      .sort((left, right) => left.id.localeCompare(right.id))

    for (const rule of matching) {
      const authoritativePower = authority.powerByUserId[rule.authoredBy]
      if (
        !validIntegerPower(authoritativePower)
        || rule.claimedAuthorPower !== authoritativePower
        || rule.claimedNeededPower !== authority.neededPower
        || authoritativePower < authority.neededPower
      ) {
        return unsupported('A rule has stale or insufficient Matrix authority.')
      }
      if (
        permission === 'roles'
        && authority.ownerUserIds.has(subjectId)
        && (rule.effect === 'deny' || rule.effect === 'negate')
      ) {
        return unsupported('A rule could remove the community recovery path.')
      }
      if (rule.effect === 'skip') continue
      if (rule.effect === 'negate' && !hasDecision) continue
      const allowed = rule.effect === 'negate'
        ? decision.status !== 'allowed'
        : rule.effect === 'allow'
      hasDecision = true
      decision = {
        status: allowed ? 'allowed' : 'denied',
        reason: `${layer} rule ${rule.id} ${allowed ? 'allows' : 'denies'} this action.`,
        ruleId: rule.id,
        layer,
      }
    }
  }

  return decision
}

export function explainAdvancedPermission(
  resolution: AdvancedPermissionResolution,
): string {
  if (resolution.status === 'allowed') return `Allowed: ${resolution.reason}`
  if (resolution.status === 'denied') return `Denied: ${resolution.reason}`
  return `Unavailable: ${resolution.reason}`
}
