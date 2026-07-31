import { describe, expect, it } from 'vitest'
import {
  communitySelectionScopeKey,
  derivePersonalCommunitySelection,
  evaluateCommunityRulesGate,
  reconcilePersonalCommunitySelection,
  type CommunityOnboardingDefinition,
} from './community-onboarding'

const definition: CommunityOnboardingDefinition = {
  schemaVersion: 1,
  communityId: '!garden:community.example',
  rules: {
    version: 'rules-2026-07',
    title: 'Garden rules',
    body: 'Be kind.',
    required: true,
  },
  defaultChannelIds: ['!welcome:community.example'],
  questions: [{
    id: 'interests',
    label: 'What interests you?',
    optional: true,
    options: [
      {
        id: 'plants',
        label: 'Plants',
        channelIds: ['!plants:community.example', '!not-joined:remote.example'],
      },
      {
        id: 'events',
        label: 'Events',
        channelIds: ['!events:community.example'],
      },
    ],
  }],
}

describe('community onboarding domain', () => {
  it('denies participation until the authoritative rules version is accepted', () => {
    for (const action of ['send', 'react', 'join-voice'] as const) {
      expect(evaluateCommunityRulesGate(action, definition.rules.version, null)).toEqual({
        allowed: false,
        reason: expect.stringContaining('community rules'),
      })
      expect(
        evaluateCommunityRulesGate(action, definition.rules.version, 'older-rules').allowed,
      ).toBe(false)
      expect(
        evaluateCommunityRulesGate(action, definition.rules.version, definition.rules.version)
          .allowed,
      ).toBe(true)
    }
    expect(evaluateCommunityRulesGate('browse', definition.rules.version, null).allowed).toBe(true)
    expect(evaluateCommunityRulesGate('leave', definition.rules.version, null).allowed).toBe(true)
  })

  it('adds only joined channels and only authority-projected roles', () => {
    const selection = derivePersonalCommunitySelection({
      accountId: '@alice:accounts.example',
      definition,
      answers: {
        acceptedRulesVersion: definition.rules.version,
        optionIdsByQuestion: {
          interests: ['plants'],
          injected: ['owner'],
        },
      },
      joinedChannelIds: new Set([
        '!welcome:community.example',
        '!plants:community.example',
      ]),
      projectedRoleGrants: {
        plants: ['gardener'],
        owner: ['owner'],
      },
    })

    expect(selection).toMatchObject({
      accountId: '@alice:accounts.example',
      communityId: definition.communityId,
      acceptedRulesVersion: definition.rules.version,
      channelIds: ['!plants:community.example', '!welcome:community.example'],
      roleTemplateIds: ['gardener'],
    })
  })

  it('allows optional interests to be skipped without blocking entry', () => {
    const selection = derivePersonalCommunitySelection({
      accountId: '@alice:accounts.example',
      definition,
      answers: {
        acceptedRulesVersion: definition.rules.version,
        optionIdsByQuestion: {},
      },
      joinedChannelIds: new Set(['!welcome:community.example']),
      projectedRoleGrants: {},
    })

    expect(selection.channelIds).toEqual(['!welcome:community.example'])
    expect(selection.roleTemplateIds).toEqual([])
  })

  it('reconciles rejoin and room upgrades without leaking another account scope', () => {
    const previous = derivePersonalCommunitySelection({
      accountId: '@alice:accounts.example',
      definition,
      answers: {
        acceptedRulesVersion: definition.rules.version,
        optionIdsByQuestion: { interests: ['plants', 'events'] },
      },
      joinedChannelIds: new Set([
        '!welcome:community.example',
        '!plants:community.example',
        '!events:community.example',
      ]),
      projectedRoleGrants: {},
    })
    const reconciled = reconcilePersonalCommunitySelection({
      selection: previous,
      joinedChannelIds: new Set([
        '!welcome-v2:community.example',
        '!plants:community.example',
      ]),
      upgradedRoomIds: {
        '!welcome:community.example': '!welcome-v2:community.example',
      },
    })

    expect(reconciled.channelIds).toEqual([
      '!plants:community.example',
      '!welcome-v2:community.example',
    ])
    expect(communitySelectionScopeKey(previous.accountId, previous.communityId))
      .not.toBe(communitySelectionScopeKey('@bob:elsewhere.example', previous.communityId))
  })
})
