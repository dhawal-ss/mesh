import { describe, expect, it } from 'vitest'
import {
  friendlyAccountCreationError,
  normalizeUsername,
  passwordStrength,
  usernameValidationError,
} from './accountCreation'

describe('account creation helpers', () => {
  it('normalizes and validates the public username without qualifying it', () => {
    expect(normalizeUsername('  Ashvin_  ')).toBe('ashvin_')
    expect(usernameValidationError('ashvin_')).toBeNull()
    expect(usernameValidationError('@ashvin:example.org')).toContain('lowercase letters')
    expect(usernameValidationError('ab')).toContain('at least 3')
  })

  it('accepts either a varied password or a long passphrase as strong', () => {
    expect(passwordStrength('short').strongEnough).toBe(false)
    expect(passwordStrength('Mesh-Account-2026').strongEnough).toBe(true)
    expect(passwordStrength('correct horse battery staple').strongEnough).toBe(true)
  })

  it('turns registration failures into protocol-free guidance', () => {
    expect(friendlyAccountCreationError(new Error('M_USER_IN_USE'))).toContain('just taken')
    expect(friendlyAccountCreationError(new Error('network unavailable'))).toContain('connection')
    expect(friendlyAccountCreationError(new Error('internal registration failure'))).not.toContain('registration')
  })

  it('preserves typed registration guidance from the Rust boundary', () => {
    expect(friendlyAccountCreationError({
      code: 'community_homeserver_unconfigured',
      detail: 'community-hosted service is not configured',
      retryable: false,
    })).toContain('does not have an optional account service configured')
    expect(friendlyAccountCreationError({
      code: 'registration_terms_required',
      detail: 'terms required',
      retryable: false,
    })).toContain('Terms acceptance required')
    expect(friendlyAccountCreationError({
      code: 'registration_additional_auth_required',
      detail: 'more auth required',
      retryable: false,
    })).toContain('Additional verification required')
    expect(friendlyAccountCreationError({
      code: 'registration_invitation_invalid',
      detail: 'invite already used',
      retryable: false,
    })).toContain('Invitation unavailable')
  })
})
