import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/bridge', () => ({
  isTauriRuntime: vi.fn(() => true),
  matrixRecoveryHealth: vi.fn(),
}))

import * as bridge from '../lib/bridge'
import { useSettingsStore } from '../store/settings'
import {
  FIRST_SESSION_RECOVERY_CHECK_DELAY_MS,
  useFirstSessionRecoveryReminder,
  type FirstSessionRecoveryReminderOptions,
} from './useFirstSessionRecoveryReminder'

function Harness(props: FirstSessionRecoveryReminderOptions) {
  const visible = useFirstSessionRecoveryReminder(props)
  return <div>{visible ? 'Reminder visible' : 'Reminder hidden'}</div>
}

function recoveryHealth(healthy: boolean) {
  return {
    recoveryState: healthy ? 'enabled' : 'disabled',
    backupState: healthy ? 'enabled' : 'unknown',
    backupExistsOnServer: healthy,
    backupEnabled: healthy,
    healthy,
    checkedAt: '2026-08-06T00:00:00.000Z',
    lastSuccessfulTestAt: healthy ? '2026-08-06T00:00:00.000Z' : null,
    secureStorageState: healthy ? 'saved' as const : 'missing' as const,
    warnings: healthy ? [] : ['Recovery has not been enabled'],
  }
}

describe('first-session recovery reminder', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useSettingsStore.setState({
      backup: { configured: false, reminderPending: false, dismissedAt: null },
      backupAccountId: null,
      backupByAccount: {},
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('waits until invitation entry is finished before checking and showing attention', async () => {
    vi.mocked(bridge.matrixRecoveryHealth).mockResolvedValue(recoveryHealth(false))
    const initial = {
      matrixMode: true,
      accountId: '@alice:example.org',
      successfulUse: true,
      invitationForegrounded: true,
    }

    await act(async () => root.render(<Harness {...initial} />))
    await act(async () => vi.advanceTimersByTimeAsync(FIRST_SESSION_RECOVERY_CHECK_DELAY_MS * 2))
    expect(bridge.matrixRecoveryHealth).not.toHaveBeenCalled()
    expect(container.textContent).toBe('Reminder hidden')

    await act(async () => root.render(
      <Harness {...initial} invitationForegrounded={false} />,
    ))
    await act(async () => vi.advanceTimersByTimeAsync(FIRST_SESSION_RECOVERY_CHECK_DELAY_MS))

    expect(bridge.matrixRecoveryHealth).toHaveBeenCalledOnce()
    expect(container.textContent).toBe('Reminder visible')
    expect(useSettingsStore.getState().backupByAccount['@alice:example.org']).toEqual({
      configured: false,
      reminderPending: true,
      dismissedAt: null,
    })
  })

  it('accepts only strict native healthy evidence for an already-protected account', async () => {
    vi.mocked(bridge.matrixRecoveryHealth).mockResolvedValue(recoveryHealth(true))
    await act(async () => root.render(
      <Harness
        matrixMode
        accountId="@healthy:example.org"
        successfulUse
        invitationForegrounded={false}
      />,
    ))
    await act(async () => vi.advanceTimersByTimeAsync(FIRST_SESSION_RECOVERY_CHECK_DELAY_MS))

    expect(container.textContent).toBe('Reminder hidden')
    expect(useSettingsStore.getState().backupByAccount['@healthy:example.org']).toEqual({
      configured: true,
      reminderPending: false,
      dismissedAt: null,
    })
  })

  it('makes no recovery claim when the health check itself fails', async () => {
    vi.mocked(bridge.matrixRecoveryHealth).mockRejectedValue(new Error('offline'))
    await act(async () => root.render(
      <Harness
        matrixMode
        accountId="@offline:example.org"
        successfulUse
        invitationForegrounded={false}
      />,
    ))
    await act(async () => vi.advanceTimersByTimeAsync(FIRST_SESSION_RECOVERY_CHECK_DELAY_MS))

    expect(container.textContent).toBe('Reminder hidden')
    expect(useSettingsStore.getState().backupByAccount['@offline:example.org']).toBeUndefined()
  })

  it('respects an account-specific dismissal when health still needs attention', async () => {
    vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'))
    useSettingsStore.setState({
      backup: {
        configured: false,
        reminderPending: true,
        dismissedAt: '2026-08-05T00:00:00.000Z',
      },
      backupAccountId: '@dismissed:example.org',
      backupByAccount: {
        '@dismissed:example.org': {
          configured: false,
          reminderPending: true,
          dismissedAt: '2026-08-05T00:00:00.000Z',
        },
      },
    })
    vi.mocked(bridge.matrixRecoveryHealth).mockResolvedValue(recoveryHealth(false))

    await act(async () => root.render(
      <Harness
        matrixMode
        accountId="@dismissed:example.org"
        successfulUse
        invitationForegrounded={false}
      />,
    ))
    await act(async () => vi.advanceTimersByTimeAsync(FIRST_SESSION_RECOVERY_CHECK_DELAY_MS))

    expect(container.textContent).toBe('Reminder hidden')
    expect(useSettingsStore.getState().backup.dismissedAt).toBe('2026-08-05T00:00:00.000Z')
  })
})
