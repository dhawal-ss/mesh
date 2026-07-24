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
        mutedChannels: [],
        mutedCommunities: [],
      },
    }))
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

    expect(container.textContent).toContain('alice')
    expect(container.textContent).toContain('@alice:example.org')
    const securityButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Open Security & Devices'))
    expect(securityButton).toBeDefined()

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

    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(2)
    expect(checkboxes[0]?.checked).toBe(true)
    expect(checkboxes[1]?.disabled).toBe(false)

    await act(async () => checkboxes[0]?.click())

    expect(useSettingsStore.getState().notifications.enabled).toBe(false)
    expect(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.disabled).toBe(true)
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

    const displayNameInput = container.querySelector<HTMLInputElement>(
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

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save display name'),
    )
    await act(async () => {
      saveButton?.click()
      await Promise.resolve()
    })

    expect(updateDisplayName).toHaveBeenCalledWith('Alice Cooper')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Profile updated')
    expect(container.textContent).toContain('will not upload an avatar')
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

    const displayNameInput = container.querySelector<HTMLInputElement>(
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

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save display name'),
    )
    await act(async () => {
      saveButton?.click()
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Homeserver rejected profile update',
    )
  })
})
