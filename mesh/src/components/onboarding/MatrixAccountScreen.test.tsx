import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MatrixAccountScreen } from './MatrixAccountScreen'
import * as bridge from '../../lib/bridge'

vi.mock('../../lib/bridge', () => ({
  isTauriRuntime: vi.fn(() => false),
  matrixAccounts: vi.fn(async () => []),
  matrixOidcStatus: vi.fn(),
  matrixStartOidcLogin: vi.fn(),
  matrixCancelLogin: vi.fn(async () => {}),
}))

describe('MatrixAccountScreen', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(false)
    vi.mocked(bridge.matrixAccounts).mockResolvedValue([])
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('opens directly on the managed browser sign-in path', async () => {
    await act(async () => {
      root.render(
        <MatrixAccountScreen
          onMatrixLogin={vi.fn()}
          onNext={() => {}}
          recommendedService="https://managed.mesh.test"
          recommendedServiceName="Mesh"
        />,
      )
    })

    expect(container.textContent).toContain('Welcome back')
    expect(container.textContent).toContain('Continue with Mesh')
    expect(container.textContent).toContain('Private browser sign-in')
    expect(container.textContent).toContain('authorization code')
    expect(container.textContent).toContain('S256 PKCE')
    expect(findButton('Continue with Mesh').disabled).toBe(true)
    expect(container.textContent).toContain('installed desktop app')
    expect(container.textContent).toContain('managed.mesh.test')
    expect(container.textContent).toContain('No server setup or Matrix ID is needed')
    expect(container.textContent).not.toContain('Get started')
    expect(container.querySelector('input[name="homeserver"]')).toBeNull()
    expect(container.textContent).toContain('Advanced: use an existing account password')
    expect(container.querySelector('input[autocomplete="username"]')).toBeNull()
    expect(container.querySelector('input[autocomplete="current-password"]')).toBeNull()
  })

  it('keeps password sign-in in Advanced and discovers the existing account provider', async () => {
    const login = vi.fn().mockResolvedValue(undefined)
    const onNext = vi.fn()
    await act(async () => {
      root.render(
        <MatrixAccountScreen
          onMatrixLogin={login}
          onNext={onNext}
          recommendedService="managed.mesh.test"
          recommendedServiceName="Mesh"
        />,
      )
    })
    await act(async () => {
      findButton('Advanced: use an existing account password').click()
    })

    const username = container.querySelector<HTMLInputElement>('input[autocomplete="username"]')!
    const password = container.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!
    await act(async () => {
      setInputValue(username, '@alice:friends.example')
      setInputValue(password, 'correct horse battery staple')
    })
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(login).toHaveBeenCalledWith({
      homeserver: 'friends.example',
      username: '@alice:friends.example',
      password: 'correct horse battery staple',
      deviceName: 'Mesh Desktop',
    })
    expect(onNext).toHaveBeenCalledOnce()
  })

  it('enables Continue with Mesh only after readiness and completes browser sign-in', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixOidcStatus).mockResolvedValue({
      homeserver: 'https://managed.mesh.test/',
      availability: 'supported',
      issuer: 'https://auth.mesh.test/',
      authorizationEndpoint: 'https://auth.mesh.test/authorize',
      registrationMode: 'static',
      clientIdConfigured: true,
      redirectUri: 'http://127.0.0.1:8418/oauth/callback',
      authorizationCodePkce: true,
      nativeCallbackReady: true,
      ready: true,
      reason: 'Continue with Mesh is ready for this provider',
    })
    vi.mocked(bridge.matrixStartOidcLogin).mockResolvedValue({} as bridge.BackendStatus)
    const onNext = vi.fn()

    await act(async () => {
      root.render(
        <MatrixAccountScreen
          onMatrixLogin={vi.fn()}
          onNext={onNext}
          recommendedService="https://managed.mesh.test"
          recommendedServiceName="Mesh"
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridge.matrixOidcStatus).toHaveBeenCalledWith('https://managed.mesh.test')
    expect(findButton('Continue with Mesh').disabled).toBe(false)
    await act(async () => {
      findButton('Continue with Mesh').click()
      await Promise.resolve()
    })
    expect(bridge.matrixStartOidcLogin).toHaveBeenCalledWith('https://managed.mesh.test')
    expect(onNext).toHaveBeenCalledOnce()
  })

  it('does not silently promise a public provider when no service is configured', async () => {
    await act(async () => {
      root.render(
        <MatrixAccountScreen
          onMatrixLogin={vi.fn()}
          onNext={() => {}}
          recommendedService=""
          recommendedServiceName=""
        />,
      )
    })

    expect(container.textContent).toContain('Recommended sign-in is unavailable')
    expect(container.textContent).toContain('No recommended service is configured')
    expect(container.textContent).toContain('Sign in with Matrix')
    expect(container.textContent).not.toContain('matrix.org')
    expect(container.querySelector('input[name="homeserver"]')).not.toBeNull()
    expect(() => findButton('Use recommended')).toThrow()
  })

  it('fails closed into Advanced when the configured service is insecure', async () => {
    await act(async () => {
      root.render(
        <MatrixAccountScreen
          onMatrixLogin={vi.fn()}
          onNext={() => {}}
          recommendedService="http://remote.mesh.test"
          recommendedServiceName="Mesh"
        />,
      )
    })

    expect(container.textContent).toContain('Recommended sign-in is unavailable')
    expect(container.textContent).toContain('must use HTTPS')
    expect(container.querySelector('input[name="homeserver"]')).not.toBeNull()
  })

  it('discovers a different service only after Advanced is selected', async () => {
    const login = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <MatrixAccountScreen
          onMatrixLogin={login}
          onNext={() => {}}
          recommendedService="managed.mesh.test"
          recommendedServiceName="Mesh"
        />,
      )
    })

    await act(async () => {
      findButton('Advanced: use an existing account password').click()
    })

    expect(container.querySelector('input[name="homeserver"]')).not.toBeNull()
    expect(container.textContent).toContain('Advanced connection')

    const username = container.querySelector<HTMLInputElement>('input[autocomplete="username"]')!
    const password = container.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!
    await act(async () => {
      setInputValue(username, '@alice:friends.example')
      setInputValue(password, 'correct horse battery staple')
    })
    expect(container.textContent).toContain('discover friends.example')

    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(login).toHaveBeenCalledWith(expect.objectContaining({
      homeserver: 'friends.example',
      username: '@alice:friends.example',
    }))
  })

  function findButton(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.includes(label))
    if (!button) throw new Error(`Button not found: ${label}`)
    return button
  }
})

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
