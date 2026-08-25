import { describe, expect, it } from 'vitest'
import type { CommunityModerationResult } from '../types/ipc'
import { summarizeModerationResult } from './moderation'

function result(
  outcomes: CommunityModerationResult['audit']['roomOutcomes'],
  auditRecorded = true,
): CommunityModerationResult {
  return {
    auditRecorded,
    audit: {
      id: 'audit-1',
      actorUserId: '@owner:example.org',
      actorDisplayName: 'Owner',
      targetUserId: '@member:remote.org',
      targetDisplayName: 'Member',
      action: 'Banned member',
      reason: 'Repeated abuse',
      occurredAt: '2026-07-27T12:00:00Z',
      roomOutcomes: outcomes,
    },
  }
}

describe('moderation result summaries', () => {
  it('reports complete server-wide success', () => {
    const summary = summarizeModerationResult(
      result([
        {
          roomId: '!channel:example.org',
          roomName: 'general',
          succeeded: true,
          failureReason: null,
        },
        {
          roomId: '!server:example.org',
          roomName: 'Server',
          succeeded: true,
          failureReason: null,
        },
      ]),
      'Member banned',
    )

    expect(summary).toEqual({
      message: 'Member banned',
      tone: 'success',
      serverSucceeded: true,
      fullySucceeded: true,
    })
    expect(summary.message.toLowerCase()).not.toContain('security changed')
    expect(summary.message.toLowerCase()).not.toContain('device')
    expect(summary.message.toLowerCase()).not.toContain('recovery')
  })

  it('names partial failures without exposing protocol identifiers', () => {
    const summary = summarizeModerationResult(
      result([
        {
          roomId: '!channel:example.org',
          roomName: 'general',
          succeeded: false,
          failureReason: 'This channel did not allow the moderation change.',
        },
        {
          roomId: '!server:example.org',
          roomName: 'Server',
          succeeded: true,
          failureReason: null,
        },
      ]),
      'Member banned',
    )

    expect(summary.message).toBe(
      'Applied in 1 of 2 places. general could not apply the change. Try the failed rooms again.',
    )
    expect(summary.message).not.toContain('!channel')
    expect(summary.tone).toBe('warning')
    expect(summary.serverSucceeded).toBe(true)
  })

  /*
    This used to assert that an unrecorded audit downgraded a clean run to a warning.
    The backend refuses room messages as audit evidence by design, so `auditRecorded`
    is always false and that rule turned every successful ban into an amber alarm the
    administrator could never clear. The original intent, never overstate what happened,
    survives as its mirror image: room outcomes are the only evidence that may change
    the tone.
  */
  it('reports a clean run as success even though the audit is never recorded', () => {
    const summary = summarizeModerationResult(
      result(
        [
          {
            roomId: '!server:example.org',
            roomName: 'Server',
            succeeded: true,
            failureReason: null,
          },
        ],
        false,
      ),
      'Member removed',
    )

    expect(summary).toEqual({
      message: 'Member removed',
      tone: 'success',
      serverSucceeded: true,
      fullySucceeded: true,
    })
    expect(summary.message.toLowerCase()).not.toContain('moderation history')
  })

  it('keeps naming failed rooms when the audit is not recorded', () => {
    const summary = summarizeModerationResult(
      result(
        [
          {
            roomId: '!channel:example.org',
            roomName: 'general',
            succeeded: false,
            failureReason: 'This channel did not allow the moderation change.',
          },
          {
            roomId: '!server:example.org',
            roomName: 'Server',
            succeeded: true,
            failureReason: null,
          },
        ],
        false,
      ),
      'Member banned',
    )

    expect(summary.message).toBe(
      'Applied in 1 of 2 places. general could not apply the change. Try the failed rooms again.',
    )
    expect(summary.tone).toBe('warning')
    expect(summary.fullySucceeded).toBe(false)
    // No instruction may point at a history panel that does not exist.
    expect(summary.message.toLowerCase()).not.toContain('review the result')
  })
})

describe('permanent moderation failure', () => {
  const outcome = (roomName: string, succeeded: boolean) => ({
    roomId: `!${roomName}:example.org`,
    roomName,
    succeeded,
    failureReason: succeeded ? null : 'forbidden',
  })

  it('does not advise retrying a change that applied nowhere', () => {
    /*
      Two administrators sit at the same power level and Matrix requires a
      strictly greater one, so moderating a peer fails in every room. Advising a
      retry there sends an administrator round a loop that cannot terminate.
    */
    const summary = summarizeModerationResult(
      result([outcome('general', false), outcome('lobby', false)], false),
      'Member banned',
    )
    expect(summary.message).toContain('Applied in 0 of 2 places')
    expect(summary.message).toContain('will not help')
    expect(summary.message).not.toContain('Try the failed rooms again')
    expect(summary.tone).toBe('danger')
  })

  it('still advises retrying a genuinely partial failure', () => {
    const summary = summarizeModerationResult(
      result([outcome('general', true), outcome('lobby', false)], false),
      'Member banned',
    )
    expect(summary.message).toContain('Applied in 1 of 2 places')
    expect(summary.message).toContain('Try the failed rooms again.')
    expect(summary.tone).toBe('warning')
  })
})
