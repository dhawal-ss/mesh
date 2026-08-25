import { useEffect, useState } from 'react'

import * as bridge from '../lib/bridge'
import { isBackupReminderDue, useSettingsStore } from '../store/settings'

export const FIRST_SESSION_RECOVERY_CHECK_DELAY_MS = 12_000

export interface FirstSessionRecoveryReminderOptions {
  matrixMode: boolean
  accountId: string | null
  successfulUse: boolean
  invitationForegrounded: boolean
}

/**
 * Reconcile the local reminder with native recovery evidence after the shell
 * has delivered value. The check stays out of invitation entry and a failed
 * health request makes no claim about whether messages are protected.
 */
export function useFirstSessionRecoveryReminder({
  matrixMode,
  accountId,
  successfulUse,
  invitationForegrounded,
}: FirstSessionRecoveryReminderOptions): boolean {
  const backup = useSettingsStore((state) => state.backup)
  const [attentionAccountId, setAttentionAccountId] = useState<string | null>(null)

  useEffect(() => {
    if (
      !matrixMode
      || !bridge.isTauriRuntime()
      || !accountId
      || !successfulUse
      || invitationForegrounded
    ) {
      return
    }

    let active = true
    const timer = window.setTimeout(() => {
      void bridge.matrixRecoveryHealth().then((health) => {
        if (!active) return
        const settings = useSettingsStore.getState()
        settings.activateBackupAccount(accountId)
        if (health.healthy) {
          settings.setBackupConfigured(true)
          setAttentionAccountId(null)
          return
        }

        // Preserve a person's seven-day dismissal. Only create a new pending
        // reminder when this account has no existing attention state.
        if (settings.backup.configured || !settings.backup.reminderPending) {
          settings.scheduleBackupReminder()
        }
        setAttentionAccountId(accountId)
      }).catch((error) => {
        if (!active) return
        // Network/service failure is not evidence that recovery is unhealthy.
        console.warn('Could not check message backup for the first-session reminder:', error)
        setAttentionAccountId(null)
      })
    }, FIRST_SESSION_RECOVERY_CHECK_DELAY_MS)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [accountId, invitationForegrounded, matrixMode, successfulUse])

  return !invitationForegrounded
    && attentionAccountId === accountId
    && isBackupReminderDue(backup)
}
