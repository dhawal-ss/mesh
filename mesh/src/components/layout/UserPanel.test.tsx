import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIdentityStore } from '../../store/identity'
import { useShellStore } from '../../store/shell'
import { UserPanel } from './UserPanel'

const bridgeMocks = vi.hoisted(() => ({
  getBackendStatus: vi.fn(),
  getBackendStatusSnapshot: vi.fn(),
  matrixUpdateProfileDisplayName: vi.fn(),
}))

vi.mock('../../lib/bridge', () => ({
  isMatrixBackend: () => true,
  getMatrixUserId: () => '@alice:example.org',
  getBackendStatus: bridgeMocks.getBackendStatus,
  getBackendStatusSnapshot: bridgeMocks.getBackendStatusSnapshot,
  matrixUpdateProfileDisplayName: bridgeMocks.matrixUpdateProfileDisplayName,
}))

/** A Matrix backend that can genuinely open a call, the only state that earns voice controls. */
function callableMatrixStatus() {
  return {
    kind: 'matrix',
    capabilities: { voice: true },
    voiceService: {
      provider: 'matrix-rtc',
      availability: 'ready',
      mediaE2eeReady: true,
    },
  }
}

async function openAccountSection(label: string) {
  const accountTab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    // The settings tab's visible label carries a positional row number now, so
    // a tab is identified by its accessible name rather than by its raw text.
    .find((button) => button.getAttribute('aria-label') === 'Account')
  await act(async () => accountTab?.click())
  const sectionButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim().startsWith(label))
  expect(sectionButton).toBeDefined()
  await act(async () => sectionButton?.click())
}

describe('UserPanel Matrix profile editing', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    bridgeMocks.matrixUpdateProfileDisplayName.mockReset()
    bridgeMocks.getBackendStatusSnapshot.mockReset().mockReturnValue(null)
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
      diagnosticsOpen: false,
      feedbackOpen: false,
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  /*
    The line under your own name read "Mesh account", which is true of every
    account that has ever signed in here, so it never said which one this is.
    The address would say it, and the address is the one thing that must not go
    here: settings keeps it behind "Show account address" so it stays out of
    anything permanently on screen, and this bar is on every screenshot and
    every screen share Mesh has ever appeared in.
  */
  it('leaves the persistent bar your name, with no caption and no address', async () => {
    await act(async () => root.render(<UserPanel />))

    expect(container.textContent).toContain('Alice')
    expect(container.textContent).not.toContain('Mesh account')
    expect(container.textContent).not.toContain('@alice:example.org')
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
    await openAccountSection('Profile')

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
    await openAccountSection('Safety and devices')

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

  it('hides the call controls when this build cannot open a call', async () => {
    await act(async () => root.render(<UserPanel />))

    expect(container.querySelector('button[aria-label="Mute microphone"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Mute call audio"]')).toBeNull()
    expect(container.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe(
      'Account controls',
    )
    expect(container.querySelector('button[aria-label="Send beta feedback"]')).not.toBeNull()
  })

  it('offers the call controls once the backend can open a call', async () => {
    bridgeMocks.getBackendStatusSnapshot.mockReturnValue(callableMatrixStatus())
    await act(async () => root.render(<UserPanel />))

    const mute = container.querySelector<HTMLButtonElement>('button[aria-label="Mute microphone"]')
    expect(mute).not.toBeNull()
    expect(container.querySelector('button[aria-label="Mute call audio"]')).not.toBeNull()
    expect(container.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe(
      'Voice and account controls',
    )
    // Still inert until a call is actually joined, which is the honest state.
    expect(mute?.disabled).toBe(true)
  })

  it('opens beta feedback in one action from the persistent account bar', async () => {
    await act(async () => root.render(<UserPanel />))
    const feedbackButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send beta feedback"]',
    )

    await act(async () => {
      feedbackButton?.click()
      await import('../settings/BetaCenter')
      await Promise.resolve()
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('Send beta feedback')
    expect(dialog?.textContent).toContain('Included automatically')
    expect(dialog?.textContent).toContain('Mesh 0.2.0')
  })
})
