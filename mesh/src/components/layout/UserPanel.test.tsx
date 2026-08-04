import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIdentityStore } from '../../store/identity'
import { useShellStore } from '../../store/shell'
import { UserPanel } from './UserPanel'

const bridgeMocks = vi.hoisted(() => ({
  getBackendStatus: vi.fn(),
  matrixUpdateProfileDisplayName: vi.fn(),
}))

vi.mock('../../lib/bridge', () => ({
  isMatrixBackend: () => true,
  getMatrixUserId: () => '@alice:example.org',
  getBackendStatus: bridgeMocks.getBackendStatus,
  matrixUpdateProfileDisplayName: bridgeMocks.matrixUpdateProfileDisplayName,
}))

describe('UserPanel Matrix profile editing', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    bridgeMocks.matrixUpdateProfileDisplayName.mockReset()
    bridgeMocks.getBackendStatus.mockReset().mockResolvedValue({
      kind: 'matrix',
      authenticated: false,
      capabilities: { deviceManagement: false },
      userId: null,
      deviceId: null,
    })
    useIdentityStore.setState({
      identity: {
        publicKey: '@alice:example.org',
        displayName: 'Alice',
        avatarColor: '#52b5f4',
      },
      isLoading: false,
    })
    useShellStore.setState({
      profileOpen: false,
      securityOpen: false,
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('immediately replaces the visible sidebar identity after a successful update', async () => {
    bridgeMocks.matrixUpdateProfileDisplayName.mockResolvedValue({
      userId: '@alice:example.org',
      displayName: 'Alice Cooper',
      avatarUrl: 'mxc://example.org/alice',
    })

    await act(async () => root.render(<UserPanel />))
    expect(container.textContent).toContain('Alice')

    const settingsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="User settings for Alice"]',
    )
    await act(async () => settingsButton?.click())
    await act(async () => {
      await import('../settings/UserSettingsPanel')
    })
    const profileTab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent === 'Profile')
    await act(async () => profileTab?.click())

    const input = document.body.querySelector<HTMLInputElement>('input[autocomplete="nickname"]')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setValue?.call(input, 'Alice Cooper')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save display name'),
    )
    await act(async () => {
      saveButton?.click()
      await Promise.resolve()
    })

    expect(bridgeMocks.matrixUpdateProfileDisplayName).toHaveBeenCalledWith('Alice Cooper')
    expect(useIdentityStore.getState().identity).toMatchObject({
      publicKey: '@alice:example.org',
      displayName: 'Alice Cooper',
      avatarUrl: 'mxc://example.org/alice',
    })
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="User settings for Alice Cooper"]',
      ),
    ).not.toBeNull()
  })

  it('replaces User Settings with Security and restores its persistent trigger', async () => {
    await act(async () => root.render(<UserPanel />))
    const settingsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="User settings for Alice"]',
    )
    settingsButton?.focus()
    await act(async () => {
      settingsButton?.click()
      await import('../settings/UserSettingsPanel')
    })
    const devicesTab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent === 'Safety and devices')
    await act(async () => devicesTab?.click())

    const openSecurityButton = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Open your devices',
    )
    expect(openSecurityButton).toBeDefined()
    openSecurityButton?.focus()
    await act(async () => {
      openSecurityButton?.click()
      await import('../settings/SecurityDevicesPanel')
      await Promise.resolve()
    })

    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('User Settings')
    expect(openSecurityButton?.isConnected).toBe(false)

    const closeButton = document.body.querySelector<HTMLButtonElement>(
      '[role="dialog"] button[aria-label="Close dialog"]',
    )
    await act(async () => {
      closeButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(settingsButton)
    expect(document.activeElement).not.toBe(document.body)
  })
})
