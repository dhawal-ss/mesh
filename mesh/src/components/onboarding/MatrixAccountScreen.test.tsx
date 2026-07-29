import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MESH_SERVICE, MatrixAccountScreen } from './MatrixAccountScreen'
import * as bridge from '../../lib/bridge'

vi.mock('../../lib/bridge', () => ({
  isTauriRuntime: vi.fn(() => false),
  matrixAccounts: vi.fn(async () => []),
  matrixOidcStatus: vi.fn(),
  matrixCancelLogin: vi.fn(async () => {}),
  resolveCommunityInvite: vi.fn(),
}))

describe('MatrixAccountScreen', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(false)
    vi.mocked(bridge.matrixAccounts).mockResolvedValue([])
    vi.mocked(bridge.resolveCommunityInvite).mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('opens on a zero-jargon account creation form', async () => {
    await renderScreen()

    expect(container.textContent).toContain('Create your account')
    expect(container.textContent).toContain('No email needed.')
    expect(findButton('Create account').disabled).toBe(true)
    expect(findButton('Sign in')).toBeTruthy()
    expect(container.querySelector('input[name="username"]')?.getAttribute('placeholder')).toBe('ashvin')
    expect(container.querySelectorAll('input[autocomplete="new-password"]')).toHaveLength(2)
    expect(container.querySelector('input[name="invitation"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Matrix')
    expect(container.textContent).not.toContain('Service address')
    expect(container.textContent).not.toMatch(/@[a-z0-9._-]+:/i)
  })

  it('checks username availability only after a 300ms debounce', async () => {
    vi.useFakeTimers()
    const checkUsername = vi.fn(async () => true)
    await renderScreen({ onMatrixCheckUsernameAvailable: checkUsername })

    await act(async () => {
      setInputValue(findInput('username'), 'Ashvin_')
    })
    expect(checkUsername).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Checking availability')

    await act(async () => {
      vi.advanceTimersByTime(299)
      await Promise.resolve()
    })
    expect(checkUsername).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(checkUsername).toHaveBeenCalledOnce()
    expect(checkUsername).toHaveBeenCalledWith('ashvin_')
    expect(container.textContent).toContain('ashvin_ is available')
  })

  it('requires an available username, strong matching passwords, and an invitation', async () => {
    vi.useFakeTimers()
    const register = vi.fn(async () => {})
    const onNext = vi.fn()
    await renderScreen({
      onMatrixCheckUsernameAvailable: vi.fn(async () => true),
      onMatrixRegisterAccount: register,
      onNext,
    })

    await act(async () => {
      setInputValue(findInput('username'), 'NewFriend')
      vi.advanceTimersByTime(300)
      await Promise.resolve()
      setInputValue(findInput('password'), 'correct horse battery staple')
      setInputValue(findInput('password-confirmation'), 'not the same')
      setInputValue(
        findInput('invitation'),
        'https://mesh.dhawal.org/invite?registration_token=aB3xK9',
      )
    })
    expect(container.textContent).toContain('Strong password')
    expect(container.textContent).toContain('Passwords do not match')
    expect(findButton('Create account').disabled).toBe(true)

    await act(async () => {
      setInputValue(findInput('password-confirmation'), 'correct horse battery staple')
    })
    expect(findButton('Create account').disabled).toBe(false)

    await act(async () => {
      submitForm()
      await Promise.resolve()
    })
    expect(register).toHaveBeenCalledWith(
      'newfriend',
      'correct horse battery staple',
      'aB3xK9',
    )
    expect(onNext).toHaveBeenCalledWith('registered')
  })

  it('resolves an initial managed invitation and uses its bounded registration admission', async () => {
    vi.useFakeTimers()
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.resolveCommunityInvite).mockResolvedValue({
      registrationToken: 'derived-registration-token',
      roomId: '!friends:mesh.test',
      service: 'https://managed.mesh.test',
      via: ['mesh.test'],
      expiresAt: 1_785_283_200_000,
    })
    const register = vi.fn(async () => {})
    const link =
      'https://mesh.test/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
    await renderScreen({
      initialInvitation: link,
      onMatrixCheckUsernameAvailable: vi.fn(async () => true),
      onMatrixRegisterAccount: register,
    })

    await act(async () => {
      await Promise.resolve()
      setInputValue(findInput('username'), 'NewFriend')
      vi.advanceTimersByTime(300)
      await Promise.resolve()
      setInputValue(findInput('password'), 'correct horse battery staple')
      setInputValue(findInput('password-confirmation'), 'correct horse battery staple')
    })
    expect(bridge.resolveCommunityInvite).toHaveBeenCalledWith(link)
    expect(findInput('invitation').value).toBe(link)
    expect(findButton('Create account').disabled).toBe(false)

    await act(async () => {
      submitForm()
      await Promise.resolve()
    })
    expect(register).toHaveBeenCalledWith(
      'newfriend',
      'correct horse battery staple',
      'derived-registration-token',
    )
  })

  it('keeps the managed sign-in path secondary and username-only', async () => {
    const login = vi.fn(async () => {})
    const onNext = vi.fn()
    await renderScreen({ onMatrixLogin: login, onNext })

    await act(async () => {
      findButton('Sign in').click()
    })
    expect(container.textContent).toContain('Welcome back')
    expect(container.textContent).toContain('I have an account somewhere else')
    expect(container.textContent).not.toContain('Service address')

    await act(async () => {
      setInputValue(findInput('username'), 'Alice')
      setInputValue(findInput('password'), 'correct horse battery staple')
      submitForm()
      await Promise.resolve()
    })

    expect(login).toHaveBeenCalledWith({
      homeserver: 'https://managed.mesh.test',
      username: 'alice',
      password: 'correct horse battery staple',
      deviceName: 'Mesh Desktop',
    })
    expect(onNext).toHaveBeenCalledWith('signed-in')
  })

  it('uses the production Mesh service when the build has no environment override', async () => {
    const login = vi.fn(async () => {})

    await act(async () => {
      root.render(
        <MatrixAccountScreen
          onMatrixCheckUsernameAvailable={vi.fn(async () => true)}
          onMatrixRegisterAccount={vi.fn(async () => {})}
          onMatrixLogin={login}
          onNext={() => {}}
        />,
      )
    })

    await act(async () => {
      findButton('Sign in').click()
      setInputValue(findInput('username'), 'Dhawal')
      setInputValue(findInput('password'), 'correct horse battery staple')
      submitForm()
      await Promise.resolve()
    })

    expect(DEFAULT_MESH_SERVICE).toBe('https://matrix.mesh.dhawal.org')
    expect(login).toHaveBeenCalledWith(expect.objectContaining({
      homeserver: 'https://matrix.mesh.dhawal.org',
      username: 'dhawal',
    }))
  })

  it('reveals infrastructure only in the tertiary advanced form', async () => {
    const login = vi.fn(async () => {})
    await renderScreen({ onMatrixLogin: login })

    await act(async () => {
      findButton('Sign in').click()
    })
    await act(async () => {
      findButton('I have an account somewhere else').click()
    })

    expect(container.textContent).toContain('Sign in somewhere else')
    expect(container.textContent?.match(/service/gi)).toHaveLength(1)
    expect(container.textContent).toContain('Service address')
    expect(findInput('username').getAttribute('placeholder')).toBe('ashvin')
    expect(container.textContent).not.toMatch(/@[a-z0-9._-]+:/i)

    await act(async () => {
      setInputValue(findInput('username'), 'alice')
      setInputValue(findInput('password'), 'correct horse battery staple')
      setInputValue(findInput('homeserver'), 'friends.example')
      submitForm()
      await Promise.resolve()
    })

    expect(login).toHaveBeenCalledWith(expect.objectContaining({
      homeserver: 'friends.example',
      username: 'alice',
    }))
  })

  it('returns browser sign-in through the app authentication handler', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixOidcStatus).mockResolvedValue({
      homeserver: 'https://friends.example',
      availability: 'supported',
      issuer: 'https://auth.friends.example',
      ready: true,
      authorizationCodePkce: true,
      clientIdConfigured: true,
      redirectUri: 'http://127.0.0.1:8418/oauth/callback',
      authorizationEndpoint: 'https://auth.friends.example/authorize',
      registrationMode: 'static',
      nativeCallbackReady: true,
      reason: '',
    })
    const oidcLogin = vi.fn(async () => {})
    const onNext = vi.fn()
    await renderScreen({ onMatrixOidcLogin: oidcLogin, onNext })

    await act(async () => {
      findButton('Sign in').click()
    })
    await act(async () => {
      findButton('I have an account somewhere else').click()
    })
    await act(async () => {
      setInputValue(findInput('homeserver'), 'friends.example')
      findButton('Check browser sign-in').click()
      await Promise.resolve()
    })

    await act(async () => {
      findButton('Continue in browser').click()
      await Promise.resolve()
    })

    expect(oidcLogin).toHaveBeenCalledWith('friends.example')
    expect(onNext).toHaveBeenCalledWith('signed-in')
  })

  it('never reveals the qualified identifier for a saved account', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixAccounts).mockResolvedValue([
      {
        profileId: 'profile-1',
        userId: '@alice:friends.example',
        homeserver: 'https://friends.example',
        deviceId: 'DEVICE',
        lastUsedAt: '2026-07-25T00:00:00Z',
        current: false,
      },
    ])
    await renderScreen()
    await act(async () => {
      await Promise.resolve()
      findButton('Sign in').click()
    })

    expect(container.textContent).toContain('alice')
    expect(container.textContent).not.toContain('@alice:friends.example')
    expect(container.textContent).not.toContain('friends.example')
  })

  async function renderScreen(overrides: {
    onMatrixCheckUsernameAvailable?: (username: string) => Promise<boolean>
    onMatrixRegisterAccount?: (
      username: string,
      password: string,
      registrationToken: string,
    ) => Promise<void>
    onMatrixLogin?: (request: {
      homeserver: string
      username: string
      password: string
      deviceName?: string
    }) => Promise<void>
    onMatrixOidcLogin?: (homeserver: string) => Promise<void>
    initialInvitation?: string
    onNext?: () => void
  } = {}) {
    await act(async () => {
      root.render(
        <MatrixAccountScreen
          onMatrixCheckUsernameAvailable={overrides.onMatrixCheckUsernameAvailable ?? vi.fn(async () => true)}
          onMatrixRegisterAccount={overrides.onMatrixRegisterAccount ?? vi.fn(async () => {})}
          onMatrixLogin={overrides.onMatrixLogin ?? vi.fn(async () => {})}
          onMatrixOidcLogin={overrides.onMatrixOidcLogin ?? vi.fn(async () => {})}
          initialInvitation={overrides.initialInvitation}
          onNext={overrides.onNext ?? (() => {})}
          recommendedService="https://managed.mesh.test"
        />,
      )
    })
  }

  function findButton(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === label)
    if (!button) throw new Error(`Button not found: ${label}`)
    return button
  }

  function findInput(name: string): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)
    if (!input) throw new Error(`Input not found: ${name}`)
    return input
  }

  function submitForm() {
    container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
  }
})

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
