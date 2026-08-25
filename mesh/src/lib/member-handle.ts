export interface MemberIdentity {
  publicKey: string
  displayName: string
}

function localHandle(publicKey: string): string {
  const trimmed = publicKey.trim()
  const withoutPrefix = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  const separator = withoutPrefix.indexOf(':')
  const localPart = (separator >= 0 ? withoutPrefix.slice(0, separator) : withoutPrefix)
    .replace(/[^A-Za-z0-9._=-]/g, '')
    .slice(0, 24)
  return `@${localPart || 'member'}`
}

function stableTag(value: string): string {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(4, '0').slice(-4)
}

/**
 * Return a short consumer-facing handle only when duplicate display names need
 * disambiguation. Provider domains and full account addresses never escape.
 */
export function memberDisambiguationHandle(
  member: MemberIdentity,
  members: readonly MemberIdentity[],
): string | null {
  const normalizedName = member.displayName.trim().toLocaleLowerCase()
  const collisions = members.filter(
    (candidate) => candidate.displayName.trim().toLocaleLowerCase() === normalizedName,
  )
  if (collisions.length <= 1) return null

  const handle = localHandle(member.publicKey)
  const handleCollisions = collisions.filter(
    (candidate) => localHandle(candidate.publicKey).toLocaleLowerCase() === handle.toLocaleLowerCase(),
  )
  return handleCollisions.length > 1
    ? `${handle} · ${stableTag(member.publicKey)}`
    : handle
}
