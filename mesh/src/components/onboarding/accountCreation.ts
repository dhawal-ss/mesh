import { parseAdmissionCommunityInvite } from '../../lib/community-invites'
import { describeError, normalizeError } from '../../lib/errors'

export type PasswordStrength = {
  score: number
  label: 'Weak' | 'Fair' | 'Strong'
  strongEnough: boolean
}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/
const INVITATION_CODE_PATTERN = /^[A-Za-z0-9._~-]{1,64}$/

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase()
}

export function invitationCodeFromInput(value: string): string | null {
  const input = value.trim()
  if (!input) return null
  // Community admission links contain a capability, not a Synapse
  // registration token. The native backend validates and resolves that
  // capability; this parser must never submit the public code directly.
  if (parseAdmissionCommunityInvite(input)) return null
  if (INVITATION_CODE_PATTERN.test(input)) return input

  try {
    const url = new URL(input.replace(/^mesh:\/\//i, 'https://community.example/'))
    const queryCode = url.searchParams.get('registration_token')
      ?? url.searchParams.get('code')
    if (queryCode && INVITATION_CODE_PATTERN.test(queryCode)) return queryCode

    const pathMatch = url.pathname.match(/\/invite\/([A-Za-z0-9._~-]{1,64})\/?$/)
    return pathMatch?.[1] ?? null
  } catch {
    return null
  }
}

export function invitationValidationError(value: string): string | null {
  if (!value.trim()) return 'Enter the code from your Mesh invitation.'
  if (!parseAdmissionCommunityInvite(value) && !invitationCodeFromInput(value)) {
    return 'Paste a valid Mesh invitation link or code.'
  }
  return null
}

export function usernameValidationError(value: string): string | null {
  const username = normalizeUsername(value)
  if (!username) return null
  if (username.length < 3) return 'Use at least 3 characters.'
  if (username.length > 32) return 'Use no more than 32 characters.'
  if (!USERNAME_PATTERN.test(username)) {
    return 'Use lowercase letters, numbers, dots, dashes, or underscores.'
  }
  return null
}

export function passwordStrength(password: string): PasswordStrength {
  if (!password) return { score: 0, label: 'Weak', strongEnough: false }

  const characterGroups = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length

  const score = Math.min(
    4,
    Number(password.length >= 10)
      + Number(password.length >= 14)
      + Number(password.length >= 18 || characterGroups >= 2)
      + Number(characterGroups >= 3),
  )

  return {
    score,
    label: score >= 3 ? 'Strong' : score >= 2 ? 'Fair' : 'Weak',
    strongEnough: score >= 3,
  }
}

export function friendlyAccountCreationError(cause: unknown): string {
  const normalized = normalizeError(cause)
  if ([
    'community_homeserver_unconfigured',
    'username_unavailable',
    'registration_terms_required',
    'registration_additional_auth_required',
    'registration_invitation_required',
    'registration_invitation_invalid',
    'rate_limited',
    'network_unavailable',
  ].includes(normalized.code)) {
    const description = describeError(normalized, { operation: 'create your account' })
    return `${description.title}. ${description.body}`
  }

  const message = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase()
  if (message.includes('user_in_use') || message.includes('already') || message.includes('taken')) {
    return 'That username was just taken. Try another one.'
  }
  if (message.includes('password') || message.includes('weak')) {
    return 'That password was not accepted. Make it longer and try again.'
  }
  if (message.includes('network') || message.includes('offline') || message.includes('connect')) {
    return 'Mesh could not connect. Check your internet connection and try again.'
  }
  return 'Mesh could not create your account. Please try again.'
}
