import { describe, expect, it } from 'vitest'

import {
  eventTrust,
  serverName,
  serverReach,
  serverRelation,
  trustBadgeLabel,
  type TrustableEvent,
} from './trust'

describe('serverName', () => {
  it('reads the homeserver out of a Matrix user id', () => {
    expect(serverName('@taylor:lantern.dev')).toBe('lantern.dev')
  })

  it('lowercases the domain so two spellings of one server compare equal', () => {
    expect(serverName('@taylor:Lantern.DEV')).toBe('lantern.dev')
  })

  it('keeps a port, because a homeserver on a port is a different homeserver', () => {
    expect(serverName('@taylor:lantern.dev:8448')).toBe('lantern.dev:8448')
  })

  it('returns null for an id carrying no domain at all', () => {
    expect(serverName('taylor')).toBeNull()
    expect(serverName('@taylor:')).toBeNull()
    expect(serverName('')).toBeNull()
  })
})

describe('serverRelation', () => {
  it('calls a sender on your own homeserver local', () => {
    expect(serverRelation('@devon:lantern.dev', '@taylor:lantern.dev')).toBe('local')
  })

  it('ignores case when comparing domains', () => {
    expect(serverRelation('@devon:LANTERN.dev', '@taylor:lantern.DEV')).toBe('local')
  })

  it('calls a sender on another homeserver remote', () => {
    expect(serverRelation('@rohan:nine.chat', '@taylor:lantern.dev')).toBe('remote')
  })

  /*
    Failing closed matters here. A ring that is missing says "this person is on
    your server", which is a claim; a ring that is present says "look closer",
    which is only ever a prompt. So an id we cannot parse is remote.
  */
  it('fails closed to remote when either id cannot be parsed', () => {
    expect(serverRelation('devon', '@taylor:lantern.dev')).toBe('remote')
    expect(serverRelation('@devon:lantern.dev', 'taylor')).toBe('remote')
    expect(serverRelation('@devon:lantern.dev', null)).toBe('remote')
  })
})

describe('eventTrust', () => {
  const local = (extra: Partial<TrustableEvent> = {}): TrustableEvent => ({
    sender: '@devon:lantern.dev',
    ...extra,
  })

  it('is ok for a decrypted event from your own server on a verified device', () => {
    expect(eventTrust(local({ deviceVerified: true }), '@taylor:lantern.dev')).toBe('ok')
  })

  it('is ok when device verification is simply unknown', () => {
    expect(eventTrust(local(), '@taylor:lantern.dev')).toBe('ok')
  })

  it('is remote for a clean event whose sender is on another homeserver', () => {
    expect(eventTrust({ sender: '@rohan:nine.chat' }, '@taylor:lantern.dev')).toBe('remote')
  })

  /*
    Suspicion outranks origin. An undecryptable event from your own homeserver is
    still the more urgent of the two facts, so it takes the rail rather than
    losing it to a domain comparison that happened to match.
  */
  it('is suspect for an undecryptable event even on your own server', () => {
    expect(eventTrust(local({ undecryptable: true }), '@taylor:lantern.dev')).toBe('suspect')
  })

  it('is suspect for an undecryptable event from another server', () => {
    expect(eventTrust({ sender: '@rohan:nine.chat', undecryptable: true }, '@taylor:lantern.dev'))
      .toBe('suspect')
  })

  it('is suspect when the sending device is known to be unverified', () => {
    expect(eventTrust(local({ deviceVerified: false }), '@taylor:lantern.dev')).toBe('suspect')
  })

  it('is remote when the viewer has no account id to compare against', () => {
    expect(eventTrust(local(), null)).toBe('remote')
  })
})

describe('trustBadgeLabel', () => {
  /*
    Colour is never the only channel. Every rail carries this sentence as its
    accessible name, so the three states are distinguishable without seeing
    green, chrome or vermilion.
  */
  it('names each state in words', () => {
    expect(trustBadgeLabel('ok', 'lantern.dev')).toBe('Encrypted, from lantern.dev, verified device')
    expect(trustBadgeLabel('remote', 'nine.chat')).toBe('From another server, nine.chat')
    expect(trustBadgeLabel('suspect', 'nine.chat')).toBe('Could not verify this message')
  })

  it('drops the server clause when the server is unknown', () => {
    expect(trustBadgeLabel('ok', null)).toBe('Encrypted, verified device')
    expect(trustBadgeLabel('remote', null)).toBe('From another server')
  })
})

describe('serverReach', () => {
  /*
    The conversation's ambient caption counts servers, not people, so it does
    not change every time somebody joins from a server already in the room.
  */
  it('counts distinct homeservers', () => {
    expect(serverReach([
      '@taylor:lantern.dev',
      '@devon:lantern.dev',
      '@rohan:nine.chat',
      '@ada:mesh.example',
    ])).toBe(3)
  })

  it('treats two spellings of one server as one server', () => {
    expect(serverReach(['@taylor:Lantern.dev', '@devon:lantern.DEV'])).toBe(1)
  })

  it('ignores ids it cannot parse rather than counting them as a server', () => {
    expect(serverReach(['@taylor:lantern.dev', 'taylor', null, undefined, ''])).toBe(1)
  })
})
