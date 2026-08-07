import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../store/settings'
import { UserSettingsPanel } from './UserSettingsPanel'
import { DEFAULT_INTERFACE_SOUND_EVENTS } from '../../lib/interface-sound-contract'

const interfaceSoundMocks = vi.hoisted(() => ({
  play: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('../../lib/interface-sounds', () => ({
  playInterfaceSound: interfaceSoundMocks.play,
}))

vi.mock('./SecurityDevicesPanel', () => ({
  SecurityDevicesPanel: ({ embedded, onClose }: { embedded?: boolean; onClose: () => void }) => (
    <section aria-label="Inline safety and devices">
      <span>{embedded ? 'Embedded device controls' : 'Device controls'}</span>
      <button type="button" onClick={onClose}>Close devices</button>
    </section>
  ),
}))

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
    interfaceSoundMocks.play.mockClear()
    useSettingsStore.setState((state) => ({
      notifications: {
        ...state.notifications,
        enabled: true,
        sound: true,
        soundId: 'mesh',
        soundVolume: 0.6,
        soundEvents: { ...DEFAULT_INTERFACE_SOUND_EVENTS },
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
    useSettingsStore.getState().setAppearanceTransparency('opaque')
    useSettingsStore.getState().setReduceMotion(false)
    useSettingsStore.setState({
      privacy: {
        readReceiptMode: 'public',
        sendTypingIndicators: true,
        conversationPrivacy: {},
        sharePresence: true,
        invisibleMode: false,
      },
      matrixPreferenceSync: { status: 'idle', error: null },
      signalCheckEnabled: false,
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
    const advanced = tabs.find((tab) => tab.textContent === 'Advanced')!
    expect(advanced.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(advanced)
  })

  it('renders route-owned You content without nesting a settings dialog', async () => {
    const openSecurity = vi.fn()
    await act(async () => {
      root.render(
        <UserSettingsPanel
          embedded
          open
          activeSection="account"
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:accounts.example"
          matrixMode
          onOpenSecurity={openSecurity}
        />,
      )
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.querySelector('[role="tablist"]')).toBeNull()
    expect(document.body.querySelector('[role="tabpanel"]')).toBeNull()
    expect(document.body.textContent).toContain('Current account service')
    expect(document.body.textContent).toContain('accounts.example')
    expect(document.body.textContent).toContain('hosted independently from Mesh')
    expect(document.body.textContent).not.toContain('@alice:accounts.example')
    const reveal = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Show account address'),
    )
    await act(async () => reveal?.click())
    expect(document.body.textContent).toContain('@alice:accounts.example')
    const useAnotherService = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Use another service'),
    )
    expect(useAnotherService?.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      useAnotherService?.click()
      await import('./SecurityDevicesPanel')
      await Promise.resolve()
    })
    expect(openSecurity).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Embedded device controls')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
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

    await openSettingsTab('Profile')
    expect(document.body.textContent).toContain('alice')
    expect(document.body.textContent).toContain('Mesh account')
    expect(document.body.textContent).not.toContain('@alice:example.org')
    await openSettingsTab('Safety and devices')
    const securityButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Open your devices'),
    )
    expect(securityButton).toBeDefined()
    expect(document.body.textContent).toContain('Your devices')
    expect(document.body.textContent).not.toContain('Security & Devices')
    await act(async () => securityButton?.click())
    expect(openSecurity).toHaveBeenCalledOnce()
    await openSettingsTab('Privacy and voice')
    expect(document.body.textContent).toContain('Call privacy')
    expect(document.body.textContent).toContain(
      'The service can see who connects, network addresses, call timing, and traffic volume.',
    )
    expect(document.body.textContent).toContain(
      'your microphone, camera, screen, and incoming media stay off',
    )
  })

  it('keeps interface-sound controls independent from desktop notifications', async () => {
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
    expect(checkboxes).toHaveLength(13)
    expect(checkboxes[0]?.checked).toBe(true)
    expect(checkboxes[1]?.disabled).toBe(false)

    await act(async () => checkboxes[0]?.click())

    expect(useSettingsStore.getState().notifications.enabled).toBe(false)
    expect(
      document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.disabled,
    ).toBe(false)
    expect(useSettingsStore.getState().notifications.sound).toBe(true)
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

    await openSettingsTab('Privacy and voice')
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

    await openSettingsTab('Privacy and voice')
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
    expect(document.body.querySelector('#notification-sound')).toBeNull()
    const volume = document.body.querySelector<HTMLInputElement>('#interface-sound-volume')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(volume, '35')
      volume?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useSettingsStore.getState().notifications.soundVolume).toBe(0.35)

    const directPreview = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview direct-message sound"]',
    )
    const directToggle = directPreview?.parentElement?.parentElement?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    await act(async () => directToggle?.click())
    expect(useSettingsStore.getState().notifications.soundEvents['message-direct']).toBe(false)
    await act(async () => directPreview?.click())
    expect(interfaceSoundMocks.play).toHaveBeenCalledWith('message-direct', {
      preview: true,
      masterVolume: 0.35,
    })
    expect(useSettingsStore.getState().notifications.soundEvents['message-direct']).toBe(false)

    const previewToggle = Array.from(
      document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    )[10]
    expect(document.body.textContent).toContain('lock screens, mirrored displays')
    await act(async () => previewToggle?.click())
    expect(useSettingsStore.getState().notifications.showMessageContent).toBe(true)

    const checkboxes = document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    await act(async () => checkboxes[11]?.click())
    expect(useSettingsStore.getState().notifications.doNotDisturb).toBe(true)

    await act(async () => checkboxes[12]?.click())
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
    const reduceMotion = Array.from(document.body.querySelectorAll<HTMLLabelElement>('label'))
      .find((label) => label.textContent?.includes('Reduce motion'))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]')

    expect(darkTheme?.checked).toBe(true)
    expect(cozyDensity?.checked).toBe(true)
    expect(sandAccent?.checked).toBe(true)
    expect(opaqueTransparency?.checked).toBe(true)

    await act(async () => {
      highContrastTheme?.click()
      compactDensity?.click()
      oceanAccent?.click()
      subtleTransparency?.click()
      reduceMotion?.click()
    })

    expect(useSettingsStore.getState().appearance).toEqual({
      theme: 'high-contrast',
      density: 'compact',
      accent: 'ocean',
      transparency: 'readable',
      reduceMotion: true,
    })
    expect(document.documentElement.dataset.theme).toBe('high-contrast')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.documentElement.dataset.accent).toBe('ocean')
    expect(document.documentElement.dataset.transparency).toBe('readable')
    expect(document.documentElement.dataset.reduceMotion).toBe('true')
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

    await openSettingsTab('Profile')
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

    await openSettingsTab('Profile')
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

  it('uses an explicit Signal Check opt-in before diagnostics can open', async () => {
    const openDiagnostics = vi.fn()
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
        />,
      )
    })

    await openSettingsTab('Advanced')
    expect(document.body.textContent).toContain('Advanced')
    expect(document.body.textContent).toContain('Show Signal Check details')
    expect(document.body.textContent).not.toContain('Review Signal Check')
    const toggle = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')
    await act(async () => toggle?.click())
    expect(useSettingsStore.getState().signalCheckEnabled).toBe(true)
    const diagnostics = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Review Signal Check'),
    )
    await act(async () => diagnostics?.click())
    expect(openDiagnostics).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain('Import older Mesh data')
  })

  it('keeps the backup warning visible in Safety and devices', async () => {
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

    await openSettingsTab('Safety and devices')
    expect(document.body.textContent).toContain('Message backup needs attention.')
    expect(
      document.body.querySelector('[aria-label="Message backup needs attention"]'),
    ).not.toBeNull()
  })
})
