import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIdentityStore } from '../../store/identity'
import { UserPanel } from './UserPanel'

const bridgeMocks = vi.hoisted(() => ({
  matrixUpdateProfileDisplayName: vi.fn(),
}))

vi.mock('../../lib/bridge', () => ({
  isMatrixBackend: () => true,
  getMatrixUserId: () => '@alice:example.org',
  matrixUpdateProfileDisplayName: bridgeMocks.matrixUpdateProfileDisplayName,
}))

describe('UserPanel Matrix profile editing', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    bridgeMocks.matrixUpdateProfileDisplayName.mockReset()
    useIdentityStore.setState({
      identity: {
        publicKey: '@alice:example.org',
        displayName: 'Alice',
        avatarColor: '#52b5f4',
      },
      isLoading: false,
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
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
      'button[aria-label="Open settings for Alice"]',
    )
    await act(async () => settingsButton?.click())
    await act(async () => {
      await import('../settings/UserSettingsPanel')
    })

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
        'button[aria-label="Open settings for Alice Cooper"]',
      ),
    ).not.toBeNull()
  })
})
