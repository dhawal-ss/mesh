import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../store/settings'
import { UserSettingsPanel } from './UserSettingsPanel'

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
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows the authenticated Matrix account and opens security controls', async () => {
    const openSecurity = vi.fn()
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{ publicKey: '@alice:example.org', displayName: 'alice', avatarColor: '#5865f2' }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={openSecurity}
        />,
      )
    })

    expect(document.body.textContent).toContain('alice')
    expect(document.body.textContent).toContain('Mesh account')
    expect(document.body.textContent).not.toContain('@alice:example.org')
    const securityButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Open your devices'))
    expect(securityButton).toBeDefined()
    expect(document.body.textContent).toContain('Your devices')
    expect(document.body.textContent).not.toContain('Security & Devices')
    expect(document.body.textContent).toContain('Call privacy')
    expect(document.body.textContent).toContain(
      'The service can see who connects, network addresses, call timing, and traffic volume.',
    )
    expect(document.body.textContent).toContain(
      'your microphone, camera, screen, and incoming media stay off',
    )

    await act(async () => securityButton?.click())
    expect(openSecurity).toHaveBeenCalledOnce()
  })

  it('updates real notification preferences and disables sound with notifications', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{ publicKey: 'local', displayName: 'Local user', avatarColor: '#5865f2' }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
        />,
      )
    })

    const checkboxes = document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(4)
    expect(checkboxes[0]?.checked).toBe(true)
    expect(checkboxes[1]?.disabled).toBe(false)

    await act(async () => checkboxes[0]?.click())

    expect(useSettingsStore.getState().notifications.enabled).toBe(false)
    expect(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.disabled).toBe(true)
  })

  it('configures sound, DND, quiet hours, and sends a test notification', async () => {
    const onTestNotification = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{ publicKey: 'local', displayName: 'Local user', avatarColor: '#5865f2' }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
          onTestNotification={onTestNotification}
        />,
      )
    })

    const sound = document.body.querySelector<HTMLSelectElement>('#notification-sound')
    await act(async () => {
      if (sound) sound.value = 'pulse'
      sound?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useSettingsStore.getState().notifications.soundId).toBe('pulse')

    const checkboxes = document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    await act(async () => checkboxes[2]?.click())
    expect(useSettingsStore.getState().notifications.doNotDisturb).toBe(true)

    await act(async () => checkboxes[3]?.click())
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
          identity={{ publicKey: 'local', displayName: 'Local user', avatarColor: '#5865f2' }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
        />,
      )
    })

    const theme = document.body.querySelector<HTMLSelectElement>('#appearance-theme')
    const density = document.body.querySelector<HTMLSelectElement>('#appearance-density')
    const accent = document.body.querySelector<HTMLSelectElement>('#appearance-accent')

    expect(theme?.value).toBe('dark')
    expect(density?.selectedOptions[0]?.textContent).toBe('Cozy')
    expect(accent?.value).toBe('sand')

    await act(async () => {
      if (theme) theme.value = 'high-contrast'
      theme?.dispatchEvent(new Event('change', { bubbles: true }))
      if (density) density.value = 'compact'
      density?.dispatchEvent(new Event('change', { bubbles: true }))
      if (accent) accent.value = 'ocean'
      accent?.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(useSettingsStore.getState().appearance).toEqual({
      theme: 'high-contrast',
      density: 'compact',
      accent: 'ocean',
    })
    expect(document.documentElement.dataset.theme).toBe('high-contrast')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.documentElement.dataset.accent).toBe('ocean')
  })

  it('saves a trimmed Matrix display name and reports success', async () => {
    const updateDisplayName = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{ publicKey: '@alice:example.org', displayName: 'Alice', avatarColor: '#5865f2' }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onUpdateDisplayName={updateDisplayName}
          onOpenSecurity={() => {}}
        />,
      )
    })

    const displayNameInput = document.body.querySelector<HTMLInputElement>(
      'input[autocomplete="nickname"]',
    )
    expect(displayNameInput).not.toBeNull()

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
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
    const updateDisplayName = vi.fn().mockRejectedValue(new Error('Homeserver rejected profile update'))
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{ publicKey: '@alice:example.org', displayName: 'Alice', avatarColor: '#5865f2' }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onUpdateDisplayName={updateDisplayName}
          onOpenSecurity={() => {}}
        />,
      )
    })

    const displayNameInput = document.body.querySelector<HTMLInputElement>(
      'input[autocomplete="nickname"]',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
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
          identity={{ publicKey: '@alice:example.org', displayName: 'Alice', avatarColor: '#5865f2' }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
          onOpenDiagnostics={openDiagnostics}
          onOpenImport={openImport}
        />,
      )
    })

    expect(document.body.textContent).not.toContain('System diagnostics')
    const version = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Mesh version 0.1.0"]',
    )
    await act(async () => {
      for (let index = 0; index < 5; index += 1) version?.click()
    })

    expect(document.body.textContent).toContain('Advanced')
    const diagnostics = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('System diagnostics'))
    const importButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Import older Mesh data'))
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
          identity={{ publicKey: '@alice:example.org', displayName: 'Alice', avatarColor: '#5865f2' }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
          backupReminderDue
          onOpenDiagnostics={() => {}}
        />,
      )
    })

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'D',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }))
    })

    expect(document.body.textContent).toContain('Advanced')
    expect(document.body.textContent).toContain('Your messages are not backed up yet.')
    expect(document.body.querySelector('[aria-label="Message backup needs attention"]')).not.toBeNull()
  })
})
