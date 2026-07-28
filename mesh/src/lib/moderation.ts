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
  const auditWarning = result.auditRecorded
    ? ''
    : ' The audit record could not be saved; try again after checking your connection.'

  if (failures.length === 0 && result.auditRecorded) {
    return {
      message: successMessage,
      tone: 'success',
      serverSucceeded,
      fullySucceeded: true,
    }
  }

  if (failures.length === 0) {
    return {
      message: `${successMessage}.${auditWarning.trimEnd()}`,
      tone: 'warning',
      serverSucceeded,
      fullySucceeded: false,
    }
  }

  const succeeded = result.audit.roomOutcomes.length - failures.length
  const failedNames = failures
    .slice(0, 3)
    .map((outcome) => outcome.roomName)
    .join(', ')
  const remaining = failures.length - Math.min(failures.length, 3)
  const namedFailures = remaining > 0 ? `${failedNames}, and ${remaining} more` : failedNames
  return {
    message:
      `Applied in ${succeeded} of ${result.audit.roomOutcomes.length} places. ` +
      `${namedFailures} could not apply the change. Try the failed places again.` +
      auditWarning,
    tone: succeeded > 0 ? 'warning' : 'danger',
    serverSucceeded,
    fullySucceeded: false,
  }
}
