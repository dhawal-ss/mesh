export type CommunityParticipationAction =
  | 'browse'
  | 'leave'
  | 'send'
  | 'react'
  | 'join-voice'

export interface CommunityRules {
  version: string
  title: string
  body: string
  required: true
}

export interface CommunityInterestOption {
  id: string
  label: string
  channelIds: readonly string[]
}

export interface CommunityInterestQuestion {
  id: string
  label: string
  optional: boolean
  options: readonly CommunityInterestOption[]
}

export interface CommunityOnboardingDefinition {
  schemaVersion: 1
  communityId: string
  rules: CommunityRules
  defaultChannelIds: readonly string[]
  questions: readonly CommunityInterestQuestion[]
}

export interface CommunityOnboardingAnswers {
  acceptedRulesVersion: string | null
  optionIdsByQuestion: Readonly<Record<string, readonly string[]>>
}

export interface PersonalCommunitySelection {
  schemaVersion: 1
  accountId: string
  communityId: string
  acceptedRulesVersion: string | null
  channelIds: string[]
  roleTemplateIds: string[]
}

export interface ParticipationDecision {
  allowed: boolean
  reason: string | null
}

const RULES_RESTRICTED_ACTIONS = new Set<CommunityParticipationAction>([
  'send',
  'react',
  'join-voice',
])

export function evaluateCommunityRulesGate(
  action: CommunityParticipationAction,
  currentRulesVersion: string,
  acceptedRulesVersion: string | null,
): ParticipationDecision {
  if (
    RULES_RESTRICTED_ACTIONS.has(action)
    && acceptedRulesVersion !== currentRulesVersion
  ) {
    return {
      allowed: false,
      reason: 'Review and accept the current community rules before participating.',
    }
  }
  return { allowed: true, reason: null }
}

/**
 * Projects answers into a personal navigation selection only. Room membership
 * and visibility remain server-owned and are intentionally absent from the
 * return value.
 *
 * Role grants come from `projectedRoleGrants`, an authoritative permission
 * projection supplied by the control plane. An answer payload cannot name or
 * mint a role on its own.
 */
export function derivePersonalCommunitySelection({
  accountId,
  definition,
  answers,
  joinedChannelIds,
  projectedRoleGrants,
}: {
  accountId: string
  definition: CommunityOnboardingDefinition
  answers: CommunityOnboardingAnswers
  joinedChannelIds: ReadonlySet<string>
  projectedRoleGrants: Readonly<Record<string, readonly string[]>>
}): PersonalCommunitySelection {
  const knownQuestions = new Map(
    definition.questions.map((question) => [question.id, question]),
  )
  const chosenOptions = new Map<string, CommunityInterestOption>()

  for (const [questionId, optionIds] of Object.entries(answers.optionIdsByQuestion)) {
    const question = knownQuestions.get(questionId)
    if (!question) continue
    const options = new Map(question.options.map((option) => [option.id, option]))
    for (const optionId of optionIds) {
      const option = options.get(optionId)
      if (option) chosenOptions.set(option.id, option)
    }
  }

  const channelIds = new Set(
    definition.defaultChannelIds.filter((channelId) => joinedChannelIds.has(channelId)),
  )
  const roleTemplateIds = new Set<string>()
  for (const option of chosenOptions.values()) {
    for (const channelId of option.channelIds) {
      if (joinedChannelIds.has(channelId)) channelIds.add(channelId)
    }
    for (const roleTemplateId of projectedRoleGrants[option.id] ?? []) {
      roleTemplateIds.add(roleTemplateId)
    }
  }

  return {
    schemaVersion: 1,
    accountId,
    communityId: definition.communityId,
    acceptedRulesVersion:
      answers.acceptedRulesVersion === definition.rules.version
        ? answers.acceptedRulesVersion
        : null,
    channelIds: [...channelIds].sort(),
    roleTemplateIds: [...roleTemplateIds].sort(),
  }
}

export function reconcilePersonalCommunitySelection({
  selection,
  joinedChannelIds,
  upgradedRoomIds = {},
}: {
  selection: PersonalCommunitySelection
  joinedChannelIds: ReadonlySet<string>
  upgradedRoomIds?: Readonly<Record<string, string>>
}): PersonalCommunitySelection {
  const reconciled = new Set<string>()
  for (const previousId of selection.channelIds) {
    const currentId = upgradedRoomIds[previousId] ?? previousId
    if (joinedChannelIds.has(currentId)) reconciled.add(currentId)
  }
  return { ...selection, channelIds: [...reconciled].sort() }
}

export function communitySelectionScopeKey(accountId: string, communityId: string): string {
  return `${encodeURIComponent(accountId)}::${encodeURIComponent(communityId)}`
}
