import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../store/settings'
import { UserSettingsPanel } from './UserSettingsPanel'

async function openSettingsTab(label: string) {
  const tab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (button) => button.textContent === label,
  )
  expect(tab).toBeDefined()
  await act(async () => tab?.click())
}

describe('UserSettingsPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useSettingsStore.setState((state) => ({
      notifications: {
        ...state.notifications,
        enabled: true,
        sound: true,
        soundId: 'mesh',
        showMessageContent: false,
        doNotDisturb: false,
        quietHours: {
          enabled: false,
          start: '22:00',
          end: '08:00',
        },
        mutedChannels: [],
        mutedCommunities: [],
        channelMuteUntil: {},
        communityMuteUntil: {},
        channelNotificationLevels: {},
      },
    }))
    useSettingsStore.getState().setAppearanceTheme('dark')
    useSettingsStore.getState().setAppearanceDensity('default')
    useSettingsStore.getState().setAppearanceAccent('sand')
    useSettingsStore.setState({
      privacy: {
        readReceiptMode: 'public',
        sendTypingIndicators: true,
        conversationPrivacy: {},
        sharePresence: true,
        invisibleMode: false,
      },
      matrixPreferenceSync: { status: 'idle', error: null },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('implements roving keyboard tabs with complete panel relationships', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
        />,
      )
    })

    const tabs = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1)
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls')
      expect(panelId).toBeTruthy()
      expect(document.getElementById(panelId!)).not.toBeNull()
    }

    const appearance = tabs.find((tab) => tab.textContent === 'Appearance')!
    await act(async () => {
      appearance.focus()
      appearance.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    const notifications = tabs.find((tab) => tab.textContent === 'Notifications')!
    expect(notifications.getAttribute('aria-selected')).toBe('true')
    expect(notifications.tabIndex).toBe(0)
    expect(document.activeElement).toBe(notifications)

    await act(async () => {
      notifications.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    const devices = tabs.find((tab) => tab.textContent === 'Devices')!
    expect(devices.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(devices)
  })

  it('shows the authenticated Matrix account and opens security controls', async () => {
    const openSecurity = vi.fn()
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={openSecurity}
        />,
      )
    })

    await openSettingsTab('Account')
    expect(document.body.textContent).toContain('alice')
    expect(document.body.textContent).toContain('Mesh account')
    expect(document.body.textContent).not.toContain('@alice:example.org')
    await openSettingsTab('Devices')
    const securityButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Open your devices'),
    )
    expect(securityButton).toBeDefined()
    expect(document.body.textContent).toContain('Your devices')
    expect(document.body.textContent).not.toContain('Security & Devices')
    await act(async () => securityButton?.click())
    expect(openSecurity).toHaveBeenCalledOnce()
    await openSettingsTab('Privacy')
    expect(document.body.textContent).toContain('Call privacy')
    expect(document.body.textContent).toContain(
      'The service can see who connects, network addresses, call timing, and traffic volume.',
    )
    expect(document.body.textContent).toContain(
      'your microphone, camera, screen, and incoming media stay off',
    )
  })

  it('updates real notification preferences and disables sound with notifications', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
        />,
      )
    })

    await openSettingsTab('Notifications')
    const checkboxes = document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(5)
    expect(checkboxes[0]?.checked).toBe(true)
    expect(checkboxes[1]?.disabled).toBe(false)

    await act(async () => checkboxes[0]?.click())

    expect(useSettingsStore.getState().notifications.enabled).toBe(false)
    expect(
      document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.disabled,
    ).toBe(true)
  })

  it('explains service visibility and updates every privacy control', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          activeConversationId="!room:example.org"
          activeConversationName="General"
          onOpenSecurity={() => {}}
        />,
      )
    })

    await openSettingsTab('Privacy')
    expect(document.body.textContent).toContain('Privacy Center')
    expect(document.body.textContent).toContain('What your service can see')
    expect(document.body.textContent).toContain('Message and file content')
    expect(document.body.textContent).toContain('Network address')
    expect(document.body.textContent).toContain('Unlike standard Discord messages')
    expect(document.body.textContent).toContain(
      'Each conversation header checks its current protection',
    )

    const toggle = (label: string) =>
      Array.from(document.body.querySelectorAll('label'))
        .find((candidate) => candidate.textContent?.includes(label))
        ?.querySelector<HTMLInputElement>('input[type="checkbox"]')

    const readReceipts = document.querySelector<HTMLSelectElement>('#read-receipts')
    expect(document.querySelector('label[for="read-receipts"]')?.textContent).toBe('Read receipts')
    expect(readReceipts?.getAttribute('aria-describedby')).toBe('read-receipts-description')
    expect(document.querySelector('#read-receipts-description')?.textContent).toContain(
      'people in a conversation',
    )
    await act(async () => {
      if (readReceipts) readReceipts.value = 'private'
      readReceipts?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => toggle('Show when I am typing')?.click())
    await act(async () => toggle('Share my online status')?.click())
    await act(async () => toggle('Invisible mode')?.click())

    expect(useSettingsStore.getState().privacy).toEqual({
      readReceiptMode: 'private',
      sendTypingIndicators: false,
      conversationPrivacy: {},
      sharePresence: false,
      invisibleMode: true,
    })
    expect(document.body.textContent).toContain('No, disabled now')

    const conversationReceipts = document.querySelector<HTMLSelectElement>(
      '#conversation-read-receipts',
    )
    const conversationTyping = document.querySelector<HTMLSelectElement>('#conversation-typing')
    expect(document.body.textContent).toContain('This conversation: General')
    expect(document.body.textContent).toContain('Other compatible apps may publish')
    await act(async () => {
      if (conversationReceipts) conversationReceipts.value = 'public'
      conversationReceipts?.dispatchEvent(new Event('change', { bubbles: true }))
      if (conversationTyping) conversationTyping.value = 'on'
      conversationTyping?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useSettingsStore.getState().privacy.conversationPrivacy).toEqual({
      '!room:example.org': {
        readReceiptMode: 'public',
        sendTypingIndicators: true,
      },
    })
  })

  it('shows when privacy settings are not confirmed and offers a retry', async () => {
    useSettingsStore.setState({
      matrixPreferenceSync: {
        status: 'failed',
        error: new Error('offline'),
      },
    })
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
        />,
      )
    })

    await openSettingsTab('Privacy')
    expect(document.body.textContent).toContain('could not confirm them on your account')
    expect(
      Array.from(document.body.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Retry saving privacy settings'),
      ),
    ).toBe(true)
  })

  it('configures sound, DND, quiet hours, and sends a test notification', async () => {
    const onTestNotification = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
          onTestNotification={onTestNotification}
        />,
      )
    })

    await openSettingsTab('Notifications')
    const sound = document.body.querySelector<HTMLSelectElement>('#notification-sound')
    await act(async () => {
      if (sound) sound.value = 'pulse'
      sound?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useSettingsStore.getState().notifications.soundId).toBe('pulse')

    const previewToggle = Array.from(
      document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    )[2]
    expect(document.body.textContent).toContain('lock screens, mirrored displays')
    await act(async () => previewToggle?.click())
    expect(useSettingsStore.getState().notifications.showMessageContent).toBe(true)

    const checkboxes = document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    await act(async () => checkboxes[3]?.click())
    expect(useSettingsStore.getState().notifications.doNotDisturb).toBe(true)

    await act(async () => checkboxes[4]?.click())
    expect(document.body.querySelector('#quiet-hours-start')).not.toBeNull()
    const start = document.body.querySelector<HTMLInputElement>('#quiet-hours-start')
    const end = document.body.querySelector<HTMLInputElement>('#quiet-hours-end')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(start, '21:30')
      start?.dispatchEvent(new Event('input', { bubbles: true }))
      setValue?.call(end, '07:15')
      end?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useSettingsStore.getState().notifications.quietHours).toEqual({
      enabled: true,
      start: '21:30',
      end: '07:15',
    })

    const testButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Test notification'),
    )
    await act(async () => {
      testButton?.click()
      await Promise.resolve()
    })
    expect(onTestNotification).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
      'Test notification sent',
    )
  })

  it('updates appearance preferences and the document theme attributes', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
        />,
      )
    })

    const darkTheme = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-theme"][value="dark"]',
    )
    const highContrastTheme = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-theme"][value="high-contrast"]',
    )
    const cozyDensity = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-density"][value="default"]',
    )
    const compactDensity = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-density"][value="compact"]',
    )
    const sandAccent = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-accent"][value="sand"]',
    )
    const oceanAccent = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-accent"][value="ocean"]',
    )
    const subtleTransparency = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-transparency"][value="readable"]',
    )
    const opaqueTransparency = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-transparency"][value="opaque"]',
    )

    expect(darkTheme?.checked).toBe(true)
    expect(cozyDensity?.checked).toBe(true)
    expect(sandAccent?.checked).toBe(true)
    expect(subtleTransparency?.checked).toBe(true)

    await act(async () => {
      highContrastTheme?.click()
      compactDensity?.click()
      oceanAccent?.click()
      opaqueTransparency?.click()
    })

    expect(useSettingsStore.getState().appearance).toEqual({
      theme: 'high-contrast',
      density: 'compact',
      accent: 'ocean',
      transparency: 'opaque',
    })
    expect(document.documentElement.dataset.theme).toBe('high-contrast')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.documentElement.dataset.accent).toBe('ocean')
    expect(document.documentElement.dataset.transparency).toBe('opaque')
  })

  it('saves a trimmed Matrix display name and reports success', async () => {
    const updateDisplayName = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onUpdateDisplayName={updateDisplayName}
          onOpenSecurity={() => {}}
        />,
      )
    })

    await openSettingsTab('Account')
    const displayNameInput = document.body.querySelector<HTMLInputElement>(
      'input[autocomplete="nickname"]',
    )
    expect(displayNameInput).not.toBeNull()

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(displayNameInput, '  Alice Cooper  ')
      displayNameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save display name'),
    )
    await act(async () => {
      saveButton?.click()
      await Promise.resolve()
    })

    expect(updateDisplayName).toHaveBeenCalledWith('Alice Cooper')
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('Profile updated')
    expect(document.body.textContent).toContain('will not upload one without explaining that first')
  })

  it('surfaces Matrix profile update errors without changing the shown identity', async () => {
    const updateDisplayName = vi
      .fn()
      .mockRejectedValue(new Error('Homeserver rejected profile update'))
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onUpdateDisplayName={updateDisplayName}
          onOpenSecurity={() => {}}
        />,
      )
    })

    await openSettingsTab('Account')
    const displayNameInput = document.body.querySelector<HTMLInputElement>(
      'input[autocomplete="nickname"]',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(displayNameInput, 'Rejected')
      displayNameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save display name'),
    )
    await act(async () => {
      saveButton?.click()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Homeserver rejected profile update',
    )
  })

  it('reveals operator tools only after the version easter egg', async () => {
    const openDiagnostics = vi.fn()
    const openImport = vi.fn()
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
          onOpenDiagnostics={openDiagnostics}
          onOpenImport={openImport}
        />,
      )
    })

    await openSettingsTab('Devices')
    expect(document.body.textContent).not.toContain('System diagnostics')
    const version = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Mesh version 0.1.0"]',
    )
    await act(async () => {
      for (let index = 0; index < 5; index += 1) version?.click()
    })

    expect(document.body.textContent).toContain('Advanced')
    const diagnostics = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('System diagnostics'),
    )
    const importButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Import older Mesh data'),
    )
    await act(async () => diagnostics?.click())
    await act(async () => importButton?.click())
    expect(openDiagnostics).toHaveBeenCalledOnce()
    expect(openImport).toHaveBeenCalledOnce()
  })

  it('also unlocks Advanced with Ctrl+Shift+D and shows the backup warning dot', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
          backupReminderDue
          onOpenDiagnostics={() => {}}
        />,
      )
    })

    await openSettingsTab('Devices')
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'D',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      )
    })

    expect(document.body.textContent).toContain('Advanced')
    expect(document.body.textContent).toContain('Your messages are not backed up yet.')
    expect(
      document.body.querySelector('[aria-label="Message backup needs attention"]'),
    ).not.toBeNull()
  })
})
