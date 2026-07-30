import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  getMatrixUserPreferences: vi.fn(),
  isMatrixBackend: vi.fn(() => true),
  setKv: vi.fn(() => Promise.resolve()),
  updateMatrixUserPreferences: vi.fn(),
}))

vi.mock('../lib/bridge', () => bridge)

import {
  refreshMatrixPreferences,
  retryMatrixPreferenceSync,
  useSettingsStore,
} from './settings'

const remotePreferences = {
  schemaVersion: 4,
  notificationsEnabled: true,
  notificationSound: true,
  mutedChannels: [],
  mutedCommunities: [],
  sendReadReceipts: false,
  readReceiptMode: 'public',
  sendTypingIndicators: false,
  sharePresence: false,
  invisibleMode: false,
  updatedAt: '2026-07-27T00:00:00.000Z',
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('Matrix preference sync state', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    bridge.getMatrixUserPreferences.mockResolvedValue(remotePreferences)
    bridge.updateMatrixUserPreferences.mockResolvedValue(remotePreferences)
    useSettingsStore.setState({
      privacy: {
        readReceiptMode: 'public',
        sendTypingIndicators: false,
        sharePresence: false,
        invisibleMode: false,
      },
      matrixPreferenceSync: { status: 'idle', error: null },
    })
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('marks failed writes as unconfirmed and returns to saved after retry', async () => {
    await refreshMatrixPreferences('@alice:example.org')
    expect(useSettingsStore.getState().matrixPreferenceSync.status).toBe('saved')

    bridge.updateMatrixUserPreferences.mockRejectedValueOnce(new Error('offline'))
    useSettingsStore.getState().setSharePresence(true)
    await flushPromises()

    const failed = useSettingsStore.getState().matrixPreferenceSync
    expect(failed.status).toBe('failed')
    expect(failed.error).toBeInstanceOf(Error)

    bridge.updateMatrixUserPreferences.mockResolvedValueOnce(remotePreferences)
    await retryMatrixPreferenceSync()
    expect(useSettingsStore.getState().matrixPreferenceSync).toEqual({
      status: 'saved',
      error: null,
    })
  })

  it('surfaces preference-read failures instead of silently treating them as synced', async () => {
    bridge.getMatrixUserPreferences.mockRejectedValueOnce(new Error('offline'))

    await expect(refreshMatrixPreferences('@alice:example.org')).rejects.toThrow('offline')
    expect(useSettingsStore.getState().matrixPreferenceSync.status).toBe('failed')
  })

  it('does not route Matrix room mute state through the legacy local kv store', async () => {
    await refreshMatrixPreferences('@alice:example.org')
    useSettingsStore.getState().muteChannel('!room:example.org')
    await flushPromises()

    expect(bridge.setKv).not.toHaveBeenCalled()
  })
})
