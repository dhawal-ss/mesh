import { describe, expect, it } from 'vitest'
import {
  completeStepsFromFacts,
  completedStepCount,
  deriveOnboardingSteps,
  emptyOnboardingChecklist,
  onboardingChecklistStorageKey,
  restoreOnboardingChecklist,
  serializeOnboardingChecklist,
  ONBOARDING_STEP_IDS,
  type OnboardingChecklistFacts,
} from './onboarding-checklist'

const nothingDone: OnboardingChecklistFacts = {
  signedIn: false,
  joinedCommunity: false,
  openedRoom: false,
  startedMessage: false,
  hasProfilePicture: false,
}

const everythingDone: OnboardingChecklistFacts = {
  signedIn: true,
  joinedCommunity: true,
  openedRoom: true,
  startedMessage: true,
  hasProfilePicture: true,
}

describe('onboarding checklist steps', () => {
  it('suggests only the first incomplete step', () => {
    const steps = deriveOnboardingSteps(
      { ...nothingDone, signedIn: true, joinedCommunity: true },
      [],
    )
    expect(steps.filter((step) => step.next).map((step) => step.id)).toEqual(['room'])
    expect(steps.find((step) => step.id === 'room')?.action).toBe('Open a room')
    // A later incomplete step carries neither an action nor a hint, so the
    // section only ever presents one thing to do.
    const message = steps.find((step) => step.id === 'message')
    expect(message?.complete).toBe(false)
    expect(message?.action).toBeNull()
    expect(message?.hint).toBeNull()
  })

  it('offers a hint instead of an action when Mesh cannot take the person there', () => {
    const steps = deriveOnboardingSteps(
      { ...everythingDone, startedMessage: false, hasProfilePicture: false },
      [],
    )
    const message = steps.find((step) => step.id === 'message')
    expect(message?.next).toBe(true)
    expect(message?.action).toBeNull()
    expect(message?.hint).toBe('The message box is at the bottom.')
  })

  /*
   * The arrival that has no invitation to resolve. Creating a community rather
   * than accepting an invitation must still leave a list that can be finished,
   * which is why membership is one step instead of two.
   */
  it('can be completed by an account that created its own community', () => {
    const steps = deriveOnboardingSteps(everythingDone, [])
    expect(steps.every((step) => step.complete)).toBe(true)
    expect(steps.some((step) => step.next)).toBe(false)
    expect(completedStepCount(steps)).toBe(ONBOARDING_STEP_IDS.length)
  })

  it('keeps a step complete after the fact behind it goes away', () => {
    // A draft is cleared the moment it is sent and an open room closes on
    // restart. Neither undoes the step.
    const steps = deriveOnboardingSteps(nothingDone, ['room', 'message'])
    expect(steps.find((step) => step.id === 'room')?.complete).toBe(true)
    expect(steps.find((step) => step.id === 'message')?.complete).toBe(true)
    expect(steps.filter((step) => step.next).map((step) => step.id)).toEqual(['account'])
  })

  it('reads completion only from the facts it is given', () => {
    expect(completeStepsFromFacts(nothingDone)).toEqual([])
    expect(completeStepsFromFacts(everythingDone)).toEqual([...ONBOARDING_STEP_IDS])
    expect(completeStepsFromFacts({ ...nothingDone, hasProfilePicture: true })).toEqual(['picture'])
  })
})

describe('onboarding checklist persistence', () => {
  it('scopes storage to one account', () => {
    expect(onboardingChecklistStorageKey('@ada:example.org')).not.toBe(
      onboardingChecklistStorageKey('@grace:example.org'),
    )
    expect(onboardingChecklistStorageKey('a/b')).toBe('mesh-onboarding-checklist-v1:a%2Fb')
  })

  it('round-trips a snapshot', () => {
    const snapshot = {
      ...emptyOnboardingChecklist('@ada:example.org'),
      reached: ['account', 'community'] as const,
      collapsed: true,
    }
    expect(
      restoreOnboardingChecklist(serializeOnboardingChecklist({ ...snapshot, reached: [...snapshot.reached] }), '@ada:example.org'),
    ).toEqual({ ...snapshot, reached: [...snapshot.reached] })
  })

  it('refuses a snapshot belonging to another account', () => {
    const stored = serializeOnboardingChecklist({
      ...emptyOnboardingChecklist('@ada:example.org'),
      reached: ['account'],
      dismissed: true,
    })
    expect(restoreOnboardingChecklist(stored, '@grace:example.org')).toEqual(
      emptyOnboardingChecklist('@grace:example.org'),
    )
  })

  it('restores per field rather than discarding everything it cannot read', () => {
    const restored = restoreOnboardingChecklist(
      JSON.stringify({
        schemaVersion: 1,
        accountId: '@ada:example.org',
        reached: ['account', 'not-a-step'],
        dismissed: 'yes',
        collapsed: true,
      }),
      '@ada:example.org',
    )
    expect(restored.reached).toEqual([])
    expect(restored.dismissed).toBe(false)
    expect(restored.collapsed).toBe(true)
  })

  it('survives absent and unparseable storage', () => {
    const empty = emptyOnboardingChecklist('@ada:example.org')
    expect(restoreOnboardingChecklist(null, '@ada:example.org')).toEqual(empty)
    expect(restoreOnboardingChecklist('{', '@ada:example.org')).toEqual(empty)
    expect(restoreOnboardingChecklist('null', '@ada:example.org')).toEqual(empty)
  })
})
