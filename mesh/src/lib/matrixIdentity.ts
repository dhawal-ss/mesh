import type { Identity } from '../types/ipc'
import type { MatrixProfile } from './bridge'

const MATRIX_AVATAR_COLORS = [
  'var(--avatar-blue)',
  'var(--avatar-green)',
  'var(--avatar-orange)',
  'var(--avatar-violet)',
  'var(--avatar-pink)',
  'var(--avatar-cyan)',
] as const

function colorIndex(value: string): number {
  let hash = 0
  for (const character of value) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  }
  return Math.abs(hash) % MATRIX_AVATAR_COLORS.length
}

export function matrixDisplayName(userId: string): string {
  const normalized = userId.trim()
  if (!normalized) return 'Signed-in user'

  const localpart = normalized.startsWith('@')
    ? normalized.slice(1).split(':', 1)[0]
    : normalized.split(':', 1)[0]

  return localpart?.trim() || normalized
}

export function matrixIdentity(userId: string | null | undefined): Identity | null {
  const normalized = userId?.trim()
  if (!normalized) return null

  return {
    publicKey: normalized,
    displayName: matrixDisplayName(normalized),
    avatarColor: MATRIX_AVATAR_COLORS[colorIndex(normalized)] ?? MATRIX_AVATAR_COLORS[0],
  }
}

export function matrixProfileIdentity(profile: MatrixProfile): Identity {
  const fallback = matrixIdentity(profile.userId)
  return {
    publicKey: profile.userId,
    displayName: profile.displayName?.trim() || fallback?.displayName || 'Signed-in user',
    avatarColor: fallback?.avatarColor ?? MATRIX_AVATAR_COLORS[0],
    avatarUrl: profile.avatarUrl,
  }
}

export function resolveSenderIdentity(
  identity: Identity | null,
  matrixUserId: string | null,
): Identity {
  const normalizedMatrixUserId = matrixUserId?.trim() || null
  if (identity && (!normalizedMatrixUserId || identity.publicKey === normalizedMatrixUserId)) {
    return identity
  }

  return matrixIdentity(normalizedMatrixUserId) ?? identity ?? {
    publicKey: '',
    displayName: 'You',
    avatarColor: MATRIX_AVATAR_COLORS[0],
  }
}
