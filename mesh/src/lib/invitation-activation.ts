export const INVITATION_ACTIVATION_EVENT = 'mesh:invitation-activation-timing'

export type InvitationActivationMilestone =
  | 'activated'
  | 'destination-visible'
  | 'service-selected'
  | 'account-handoff-started'
  | 'account-ready'
  | 'join-started'
  | 'community-ready'

export type InvitationActivationSegment =
  | 'activation-to-destination'
  | 'destination-to-service-choice'
  | 'service-choice-to-handoff'
  | 'handoff-to-account-ready'
  | 'account-ready-to-join'
  | 'join-to-community-ready'
  | 'activation-to-community-ready'

export interface InvitationActivationMeasurement {
  segment: InvitationActivationSegment
  durationMs: number
}

interface InvitationActivationTimeline {
  handle: string
  milestones: Partial<Record<InvitationActivationMilestone, number>>
}

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const MAX_ACTIVE_TIMELINES = 8
const timelines = new Map<string, InvitationActivationTimeline>()

const SEGMENTS: ReadonlyArray<{
  segment: InvitationActivationSegment
  start: InvitationActivationMilestone
  end: InvitationActivationMilestone
}> = [
  {
    segment: 'activation-to-destination',
    start: 'activated',
    end: 'destination-visible',
  },
  {
    segment: 'destination-to-service-choice',
    start: 'destination-visible',
    end: 'service-selected',
  },
  {
    segment: 'service-choice-to-handoff',
    start: 'service-selected',
    end: 'account-handoff-started',
  },
  {
    segment: 'handoff-to-account-ready',
    start: 'account-handoff-started',
    end: 'account-ready',
  },
  {
    segment: 'account-ready-to-join',
    start: 'account-ready',
    end: 'join-started',
  },
  {
    segment: 'join-to-community-ready',
    start: 'join-started',
    end: 'community-ready',
  },
  {
    segment: 'activation-to-community-ready',
    start: 'activated',
    end: 'community-ready',
  },
]

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function timelineFor(handle: string): InvitationActivationTimeline | null {
  if (!HANDLE_PATTERN.test(handle)) return null
  const existing = timelines.get(handle)
  if (existing) return existing

  const timeline: InvitationActivationTimeline = { handle, milestones: {} }
  timelines.set(handle, timeline)
  while (timelines.size > MAX_ACTIVE_TIMELINES) {
    const oldest = timelines.keys().next().value
    if (typeof oldest !== 'string') break
    timelines.delete(oldest)
  }
  return timeline
}

export function beginInvitationActivation(
  handle: string,
  activatedAt = Date.now(),
): InvitationActivationMeasurement[] {
  return recordInvitationMilestone(handle, 'activated', activatedAt)
}

export function recordInvitationMilestone(
  handle: string,
  milestone: InvitationActivationMilestone,
  occurredAt = Date.now(),
): InvitationActivationMeasurement[] {
  const timeline = timelineFor(handle)
  if (!timeline || !validTimestamp(occurredAt)) return []

  const current = timeline.milestones[milestone]
  let updated = false
  if (current === undefined || occurredAt < current) {
    timeline.milestones[milestone] = occurredAt
    updated = true
  }

  const measurements = invitationActivationReport(handle)
  if (!updated) return measurements
  const endingSegments = SEGMENTS
    .filter((definition) => definition.end === milestone)
    .map((definition) => measurements.find((entry) => entry.segment === definition.segment))
    .filter((entry): entry is InvitationActivationMeasurement => entry !== undefined)

  for (const measurement of endingSegments) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(INVITATION_ACTIVATION_EVENT, {
        detail: measurement,
      }))
    }
  }

  return measurements
}

export function invitationActivationReport(
  handle: string,
): InvitationActivationMeasurement[] {
  const timeline = timelines.get(handle)
  if (!timeline) return []

  return SEGMENTS.flatMap(({ segment, start, end }) => {
    const startAt = timeline.milestones[start]
    const endAt = timeline.milestones[end]
    if (startAt === undefined || endAt === undefined || endAt < startAt) return []
    return [{ segment, durationMs: endAt - startAt }]
  })
}

export function clearInvitationActivation(handle: string): void {
  if (HANDLE_PATTERN.test(handle)) timelines.delete(handle)
}

export function resetInvitationActivationForTest(): void {
  timelines.clear()
}
