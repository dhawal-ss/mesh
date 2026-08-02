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
  resetMatrixAccountPreferences,
  retryMatrixPreferenceSync,
  useSettingsStore,
} from './settings'

const remotePreferences = {
  schemaVersion: 6,
  notificationsEnabled: true,
  notificationSound: true,
  showNotificationContent: false,
  mutedChannels: [] as string[],
  mutedCommunities: [] as string[],
  sendReadReceipts: false,
  readReceiptMode: 'public',
  sendTypingIndicators: false,
  conversationPrivacy: {
    '!remote:example.org': {
      readReceiptMode: 'private',
      sendTypingIndicators: true,
    },
  },
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
    resetMatrixAccountPreferences()
    useSettingsStore.setState({
      privacy: {
        readReceiptMode: 'public',
        sendTypingIndicators: false,
        conversationPrivacy: {},
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

  it('saves bounded per-conversation privacy choices through account data', async () => {
    await refreshMatrixPreferences('@alice:example.org')
    expect(useSettingsStore.getState().privacy.conversationPrivacy).toEqual(
      remotePreferences.conversationPrivacy,
    )

    useSettingsStore.getState().setConversationReadReceiptMode('!private:example.org', 'off')
    await flushPromises()

    expect(bridge.updateMatrixUserPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({
        schemaVersion: 6,
        conversationPrivacy: {
          ...remotePreferences.conversationPrivacy,
          '!private:example.org': { readReceiptMode: 'off' },
        },
      }),
    )
  })

  it('rejects an old account read after reset and accepts the next account', async () => {
    let resolveOldRead!: (value: typeof remotePreferences) => void
    bridge.getMatrixUserPreferences.mockImplementationOnce(
      () =>
        new Promise<typeof remotePreferences>((resolve) => {
          resolveOldRead = resolve
        }),
    )

    const oldRead = refreshMatrixPreferences('@alice:example.org')
    await flushPromises()
    resetMatrixAccountPreferences()
    expect(useSettingsStore.getState().privacy.readReceiptMode).toBe('off')
    expect(useSettingsStore.getState().privacy.conversationPrivacy).toEqual({})
    expect(useSettingsStore.getState().notifications.showMessageContent).toBe(false)

    resolveOldRead({
      ...remotePreferences,
      readReceiptMode: 'public',
      showNotificationContent: true,
      mutedChannels: ['!alice-private:example.org'],
    })
    await oldRead

    expect(useSettingsStore.getState().privacy.readReceiptMode).toBe('off')
    expect(useSettingsStore.getState().privacy.conversationPrivacy).toEqual({})
    expect(useSettingsStore.getState().notifications.showMessageContent).toBe(false)
    expect(useSettingsStore.getState().notifications.mutedChannels).toEqual([])

    bridge.getMatrixUserPreferences.mockResolvedValueOnce({
      ...remotePreferences,
      readReceiptMode: 'private',
      showNotificationContent: true,
      mutedChannels: ['!bob:example.org'],
    })
    await refreshMatrixPreferences('@bob:example.org')

    expect(useSettingsStore.getState().privacy.readReceiptMode).toBe('private')
    expect(useSettingsStore.getState().notifications.showMessageContent).toBe(true)
    expect(useSettingsStore.getState().notifications.mutedChannels).toEqual(['!bob:example.org'])
  })
})
