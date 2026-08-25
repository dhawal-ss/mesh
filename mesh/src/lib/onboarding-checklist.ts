/**
 * The newcomer checklist: a local, reversible list of first steps built only
 * from facts Mesh already knows.
 *
 * Nothing here is Matrix state. No custom event is written, no completion is
 * shared with a room or a community, and an admin cannot author a step. That
 * boundary is deliberate: a shared or admin-authored checklist needs an owner
 * decision on step vocabulary, authorship, privacy and retention, and this is
 * the local presentation-only half that does not.
 *
 * Two design decisions worth keeping:
 *
 * The backlog names "invitation resolved" as one of the facts. It is not a step
 * here, because a person who creates their own community never resolves an
 * invitation, so that row could never complete for them. A checklist row that
 * cannot be completed is a dead end dressed up as a task. Joining is the
 * outcome either arrival produces, so one membership step covers both, and the
 * freed row went to a profile picture: a fact Mesh already reads, useful to
 * everyone in a conversation, and completable by anybody.
 *
 * Completion latches. A step recorded as reached stays reached, because every
 * fact behind it is transient in a way the achievement is not: a draft is
 * cleared when it is sent, an open room closes when the app restarts. Latching
 * only ever preserves a step that was observed complete, so it cannot mark one
 * complete speculatively. That is also why the facts themselves are read from
 * confirmed state (an authenticated session, projected membership, a stored
 * profile) and never from an optimistic local action.
 */

export const ONBOARDING_CHECKLIST_SCHEMA_VERSION = 1

export type OnboardingStepId = 'account' | 'community' | 'room' | 'message' | 'picture'

/** Presentation order. The first incomplete step is the one Mesh suggests. */
export const ONBOARDING_STEP_IDS: readonly OnboardingStepId[] = [
  'account',
  'community',
  'room',
  'message',
  'picture',
]

/**
 * What Mesh currently knows. Every field is read from state the backend has
 * already confirmed or from local interface state, never from a request in
 * flight.
 */
export interface OnboardingChecklistFacts {
  /** An authenticated account is present. */
  signedIn: boolean
  /** This account is a member of at least one community. */
  joinedCommunity: boolean
  /** A room is open. */
  openedRoom: boolean
  /**
   * A message has been started: either a draft with content, or a message this
   * account authored. "Started" and not "sent" on purpose, so an offline person
   * gets credit for the part that is theirs.
   */
  startedMessage: boolean
  /** The account's profile carries a picture. */
  hasProfilePicture: boolean
}

export interface OnboardingChecklistSnapshot {
  schemaVersion: typeof ONBOARDING_CHECKLIST_SCHEMA_VERSION
  accountId: string
  /** Steps observed complete at least once on this device. */
  reached: OnboardingStepId[]
  /** Hidden by the person. Reversible from appearance settings. */
  dismissed: boolean
  /** Showing the count only, with the steps folded away. */
  collapsed: boolean
}

export interface OnboardingChecklistStep {
  id: OnboardingStepId
  label: string
  complete: boolean
  /** The first incomplete step, and only that one. */
  next: boolean
  /** Shown on the suggested step when it has no action of its own. */
  hint: string | null
  /** Shown on the suggested step when Mesh can take the person there. */
  action: string | null
}

/*
 * Each step is written as something a person does, not as a system state that
 * has been satisfied. "Your account is ready" reports on the software;
 * "You’re in" says the thing the person actually cares about.
 */
const STEP_LABELS: Record<OnboardingStepId, string> = {
  account: 'You’re in',
  community: 'Find your people',
  room: 'Have a look around',
  message: 'Say something',
  picture: 'Pick your look',
}

/*
 * A suggested step either offers one action or explains where to look. It never
 * does both, so there is exactly one obvious thing to do next.
 */
const STEP_ACTIONS: Record<OnboardingStepId, string | null> = {
  account: null,
  community: null,
  room: 'Open a room',
  message: null,
  picture: 'Open your profile',
}

const STEP_HINTS: Record<OnboardingStepId, string | null> = {
  account: null,
  community: 'Join one with an invite, or make your own.',
  room: null,
  message: 'The message box is at the bottom.',
  picture: null,
}

export function onboardingChecklistStorageKey(accountId: string): string {
  return `mesh-onboarding-checklist-v1:${encodeURIComponent(accountId)}`
}

export function emptyOnboardingChecklist(accountId: string): OnboardingChecklistSnapshot {
  return {
    schemaVersion: ONBOARDING_CHECKLIST_SCHEMA_VERSION,
    accountId,
    reached: [],
    dismissed: false,
    collapsed: false,
  }
}

export function serializeOnboardingChecklist(state: OnboardingChecklistSnapshot): string {
  return JSON.stringify(state)
}

function isStepIdArray(value: unknown): value is OnboardingStepId[] {
  const known = new Set<string>(ONBOARDING_STEP_IDS)
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && known.has(entry))
}

/**
 * Restores per-field, like `restoreRoomOrganization`: a field that fails to
 * parse falls back to its own default rather than discarding the snapshot, so
 * an additive change later cannot cost someone a checklist they already
 * finished and hid.
 */
export function restoreOnboardingChecklist(
  serialized: string | null,
  accountId: string,
): OnboardingChecklistSnapshot {
  const empty = emptyOnboardingChecklist(accountId)
  if (!serialized) return empty
  try {
    const value = JSON.parse(serialized) as Partial<OnboardingChecklistSnapshot> | null
    if (!value || typeof value !== 'object' || value.accountId !== accountId) return empty
    return {
      schemaVersion: ONBOARDING_CHECKLIST_SCHEMA_VERSION,
      accountId,
      reached: isStepIdArray(value.reached) ? value.reached : empty.reached,
      dismissed: typeof value.dismissed === 'boolean' ? value.dismissed : empty.dismissed,
      collapsed: typeof value.collapsed === 'boolean' ? value.collapsed : empty.collapsed,
    }
  } catch {
    return empty
  }
}

/** Which steps the current facts say are complete, in presentation order. */
export function completeStepsFromFacts(
  facts: OnboardingChecklistFacts,
): OnboardingStepId[] {
  const complete: OnboardingStepId[] = []
  if (facts.signedIn) complete.push('account')
  if (facts.joinedCommunity) complete.push('community')
  if (facts.openedRoom) complete.push('room')
  if (facts.startedMessage) complete.push('message')
  if (facts.hasProfilePicture) complete.push('picture')
  return complete
}

export function deriveOnboardingSteps(
  facts: OnboardingChecklistFacts,
  reached: readonly OnboardingStepId[],
): OnboardingChecklistStep[] {
  const complete = new Set<OnboardingStepId>([...reached, ...completeStepsFromFacts(facts)])
  let suggested: OnboardingStepId | null = null
  for (const id of ONBOARDING_STEP_IDS) {
    if (!complete.has(id)) {
      suggested = id
      break
    }
  }
  return ONBOARDING_STEP_IDS.map((id) => ({
    id,
    label: STEP_LABELS[id],
    complete: complete.has(id),
    next: id === suggested,
    hint: id === suggested ? STEP_HINTS[id] : null,
    action: id === suggested ? STEP_ACTIONS[id] : null,
  }))
}

export function completedStepCount(steps: readonly OnboardingChecklistStep[]): number {
  return steps.filter((step) => step.complete).length
}
