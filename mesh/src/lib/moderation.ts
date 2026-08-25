import type { CommunityModerationResult } from '../types/ipc'

export interface ModerationSummary {
  message: string
  tone: 'success' | 'warning' | 'danger'
  serverSucceeded: boolean
  fullySucceeded: boolean
}

export function summarizeModerationResult(
  result: CommunityModerationResult | null,
  successMessage: string,
): ModerationSummary {
  if (result == null) {
    return {
      message: successMessage,
      tone: 'success',
      serverSucceeded: true,
      fullySucceeded: true,
    }
  }

  const failures = result.audit.roomOutcomes.filter((outcome) => !outcome.succeeded)
  const serverSucceeded = result.audit.roomOutcomes.some(
    (outcome) => outcome.roomName === 'Server' && outcome.succeeded,
  )
  /*
    The backend refuses to treat a room message as audit evidence, because it can be
    forged, replayed, copied or redacted, so `auditRecorded` is never true and there is
    no history surface to send anyone to. Room outcomes are the only real evidence, so
    an action that applied everywhere is reported as the plain success it is.
  */
  if (failures.length === 0) {
    return {
      message: successMessage,
      tone: 'success',
      serverSucceeded,
      fullySucceeded: true,
    }
  }

  const succeeded = result.audit.roomOutcomes.length - failures.length
  const failedNames = failures
    .slice(0, 3)
    .map((outcome) => outcome.roomName)
    .join(', ')
  const remaining = failures.length - Math.min(failures.length, 3)
  const namedFailures = remaining > 0 ? `${failedNames}, and ${remaining} more` : failedNames
  /*
    Only suggest retrying when retrying can plausibly help.

    A change that applied nowhere is usually not a transient failure: the
    commonest cause is the account service refusing it outright, and telling
    someone to try again then sends them round a loop that cannot terminate.
  */
  const advice = succeeded > 0
    ? 'Try the failed rooms again.'
    : 'The account service refused the change, so trying again will not help.'
  return {
    message:
      `Applied in ${succeeded} of ${result.audit.roomOutcomes.length} places. ` +
      `${namedFailures} could not apply the change. ${advice}`,
    tone: succeeded > 0 ? 'warning' : 'danger',
    serverSucceeded,
    fullySucceeded: false,
  }
}
