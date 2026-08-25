export function describeJoinRule(joinRule: string | null | undefined): string {
  switch (joinRule) {
    case 'public':
      return 'Anyone can join'
    case 'knock':
    case 'knock_restricted':
      return 'Administrator approval required'
    case 'invite':
      return 'Invite only'
    case 'restricted':
      return 'Members only'
    default:
      return 'Access will be checked after you confirm'
  }
}

export function joinRuleRequiresApproval(joinRule: string | null | undefined): boolean {
  return joinRule === 'knock' || joinRule === 'knock_restricted'
}
