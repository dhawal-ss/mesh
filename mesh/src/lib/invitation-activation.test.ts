import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INVITATION_ACTIVATION_EVENT,
  beginInvitationActivation,
  invitationActivationReport,
  recordInvitationMilestone,
  resetInvitationActivationForTest,
} from './invitation-activation'

describe('invitation activation timing', () => {
  beforeEach(() => {
    resetInvitationActivationForTest()
    vi.restoreAllMocks()
  })

  it('reports each available segment without exposing an invitation handle', () => {
    const events: unknown[] = []
    window.addEventListener(INVITATION_ACTIVATION_EVENT, ((event: CustomEvent) => {
      events.push(event.detail)
    }) as EventListener)

    const handle = 'opaque-native-handle'
    beginInvitationActivation(handle, 1_000)
    recordInvitationMilestone(handle, 'destination-visible', 1_120)
    recordInvitationMilestone(handle, 'service-selected', 2_000)
    recordInvitationMilestone(handle, 'account-handoff-started', 2_050)
    recordInvitationMilestone(handle, 'account-ready', 3_000)
    recordInvitationMilestone(handle, 'join-started', 3_250)
    recordInvitationMilestone(handle, 'community-ready', 4_000)

    expect(invitationActivationReport(handle)).toEqual([
      { segment: 'activation-to-destination', durationMs: 120 },
      { segment: 'destination-to-service-choice', durationMs: 880 },
      { segment: 'service-choice-to-handoff', durationMs: 50 },
      { segment: 'handoff-to-account-ready', durationMs: 950 },
      { segment: 'account-ready-to-join', durationMs: 250 },
      { segment: 'join-to-community-ready', durationMs: 750 },
      { segment: 'activation-to-community-ready', durationMs: 3_000 },
    ])
    expect(JSON.stringify(events)).not.toContain(handle)
  })

  it('reconstructs activation time from native metadata after a restart', () => {
    beginInvitationActivation('restart-safe-handle', 10_000)
    recordInvitationMilestone('restart-safe-handle', 'destination-visible', 10_450)

    expect(invitationActivationReport('restart-safe-handle')).toEqual([
      { segment: 'activation-to-destination', durationMs: 450 },
    ])
  })

  it('rejects secret-shaped handles and impossible ordering', () => {
    beginInvitationActivation('mesh://join?code=secret', 1_000)
    recordInvitationMilestone('mesh://join?code=secret', 'community-ready', 2_000)
    expect(invitationActivationReport('mesh://join?code=secret')).toEqual([])

    beginInvitationActivation('bounded-handle', 2_000)
    recordInvitationMilestone('bounded-handle', 'destination-visible', 1_000)
    expect(invitationActivationReport('bounded-handle')).toEqual([])
  })
})
