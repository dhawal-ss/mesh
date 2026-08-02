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
      'Applied in 1 of 2 places. general could not apply the change. Try the failed places again.',
    )
    expect(summary.message).not.toContain('!channel')
    expect(summary.tone).toBe('warning')
    expect(summary.serverSucceeded).toBe(true)
  })

  it('surfaces an audit write failure after successful moderation', () => {
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

    expect(summary.tone).toBe('warning')
    expect(summary.fullySucceeded).toBe(false)
    expect(summary.message).toContain('audit record could not be saved')
  })
})
