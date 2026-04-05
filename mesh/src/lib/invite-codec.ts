export interface ParsedInvite {
  version: 1 | 2
  communityId: string
  ownerPublicKey?: string
  bootstrapHints: string[]
  // v1 only (deprecated — transition period)
  groupKey?: string
  relayHint?: string
  // v2 only
  inviteSecret?: string
}

/**
 * Generate a v2 invite link.
 *
 * v2 links do NOT contain the group key. The joiner proves possession
 * of the invite secret; the owner/admin returns the current group key
 * encrypted to the joiner's identity key.
 *
 * Format: mesh://join?v=2&c=<communityId>&o=<ownerPublicKey>&b=<bootstrapHints>&t=<inviteSecret>
 */
export function generateInviteLink(
  communityId: string,
  options: {
    ownerPublicKey?: string
    bootstrapHints?: string[]
    inviteSecret?: string
    // Deprecated v1 params — only used for backward compat
    groupKey?: string
    relayHint?: string
    version?: 1 | 2
  } = {}
): string {
  const { ownerPublicKey, bootstrapHints, inviteSecret, groupKey, relayHint, version = 2 } =
    options

  if (version === 1) {
    // Legacy v1 format (deprecated)
    const params = new URLSearchParams({
      c: communityId,
      ...(groupKey ? { k: groupKey } : {}),
      ...(relayHint ? { r: relayHint } : {}),
      ...(bootstrapHints?.length ? { b: bootstrapHints.join(',') } : {}),
      ...(ownerPublicKey ? { o: ownerPublicKey } : {}),
    })
    return `mesh://join?${params.toString()}`
  }

  // v2 format — no group key in URL
  const params = new URLSearchParams({
    v: '2',
    c: communityId,
    ...(ownerPublicKey ? { o: ownerPublicKey } : {}),
    ...(bootstrapHints?.length ? { b: bootstrapHints.join(',') } : {}),
    ...(inviteSecret ? { t: inviteSecret } : {}),
  })
  return `mesh://join?${params.toString()}`
}

/**
 * Parse an invite link. Supports both v1 and v2 formats.
 *
 * v1: mesh://join?c=<communityId>&k=<groupKey>&o=<ownerPublicKey>&b=<bootstrapHints>
 * v2: mesh://join?v=2&c=<communityId>&o=<ownerPublicKey>&b=<bootstrapHints>&t=<inviteSecret>
 */
export function parseInviteLink(link: string): ParsedInvite {
  // Handle both mesh:// links and https://mesh.app/join?... web fallback
  const url = link.startsWith('mesh://')
    ? new URL(link.replace('mesh://', 'https://mesh.app/'))
    : new URL(link)

  const communityId = url.searchParams.get('c')
  if (!communityId) throw new Error('Invalid invite link: missing community ID')

  const versionParam = url.searchParams.get('v')
  const ownerPublicKey =
    url.searchParams.get('o') ??
    url.searchParams.get('owner') ??
    url.searchParams.get('pk') ??
    undefined
  const bootstrapParam =
    url.searchParams.get('b') ?? url.searchParams.get('peers') ?? ''
  const bootstrapHints = bootstrapParam.split(',').filter(Boolean)

  if (versionParam === '2') {
    // v2 invite
    const inviteSecret = url.searchParams.get('t') ?? undefined
    return {
      version: 2,
      communityId,
      ownerPublicKey,
      bootstrapHints,
      inviteSecret,
    }
  }

  // v1 invite (backward compat)
  const groupKey = url.searchParams.get('k') ?? undefined
  const relayHint = url.searchParams.get('r') ?? undefined

  return {
    version: 1,
    communityId,
    groupKey,
    relayHint,
    bootstrapHints,
    ownerPublicKey,
  }
}

/**
 * Check if an invite is v2 format.
 */
export function isV2Invite(invite: ParsedInvite): boolean {
  return invite.version === 2
}
