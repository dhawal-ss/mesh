import { describe, expect, it } from 'vitest'
import {
  displayServiceAddress,
  friendlySignInError,
  normalizeServiceAddress,
  recommendedServiceConfigError,
  resolveServiceAddress,
  serviceFromUsername,
} from './matrixSignIn'

describe('consumer Matrix sign-in helpers', () => {
  it('keeps remote domains scheme-less for automatic discovery', () => {
    expect(normalizeServiceAddress(' chat.example.com/ ')).toBe('chat.example.com')
    expect(normalizeServiceAddress('https://matrix.example.com/')).toBe('https://matrix.example.com')
  })

  it('turns common loopback host and port inputs into working development URLs', () => {
    expect(normalizeServiceAddress('localhost:8008')).toBe('http://localhost:8008')
    expect(normalizeServiceAddress('127.0.0.1:8009')).toBe('http://127.0.0.1:8009')
    expect(normalizeServiceAddress('[::1]:8010')).toBe('http://[::1]:8010')
  })

  it('keeps the recommended path pinned to the configured service', () => {
    expect(resolveServiceAddress('recommended', '@alice:friends.example', '', 'mesh.example'))
      .toBe('mesh.example')
    expect(resolveServiceAddress('recommended', 'alice', 'other.example', 'mesh.example'))
      .toBe('mesh.example')
  })

  it('discovers or accepts a homeserver only on the advanced path', () => {
    expect(serviceFromUsername('@alice:friends.example')).toBe('friends.example')
    expect(resolveServiceAddress('advanced', '@alice:friends.example', '', 'mesh.example'))
      .toBe('friends.example')
    expect(resolveServiceAddress('advanced', '@alice:friends.example', 'chat.example', 'mesh.example'))
      .toBe('chat.example')
    expect(resolveServiceAddress('advanced', 'alice', '', 'mesh.example')).toBe('')
  })

  it('shows a human-readable host without changing the connection value', () => {
    expect(displayServiceAddress('https://chat.example.com/')).toBe('chat.example.com')
    expect(displayServiceAddress('http://localhost:8008')).toBe('localhost:8008')
  })

  it('fails closed when the recommended build service is absent or unsafe', () => {
    const credentialedService = ['https://alice:', 'secret', '@remote.example'].join('')

    expect(recommendedServiceConfigError('')).toContain('configured')
    expect(recommendedServiceConfigError('http://remote.example')).toContain('HTTPS')
    expect(recommendedServiceConfigError(credentialedService)).toContain('credentials')
    expect(recommendedServiceConfigError('mesh.example')).toBeNull()
    expect(recommendedServiceConfigError('https://matrix.mesh.example')).toBeNull()
    expect(recommendedServiceConfigError('localhost:8008')).toBeNull()
  })

  it('keeps protocol errors away from nontechnical users', () => {
    expect(friendlySignInError('M_FORBIDDEN: invalid password')).toContain('username or password')
    expect(friendlySignInError('DNS discovery request failed')).toContain('could not reach')
    expect(friendlySignInError('Matrix sign-in was cancelled')).toContain('cancelled')
    expect(friendlySignInError('Matrix sign-in timed out after 45 seconds')).toContain('took too long')
    expect(friendlySignInError({ code: 'login_cancelled', detail: 'callback closed' })).toContain('cancelled')
    expect(friendlySignInError({ code: 'login_timed_out', detail: 'callback timeout' })).toContain('took too long')
  })
})
