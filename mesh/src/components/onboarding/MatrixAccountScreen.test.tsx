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
    vi.useRealTimers()
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(false)
    vi.mocked(bridge.matrixAccounts).mockResolvedValue([])
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

  it('requires an available username, a strong password, and matching confirmation', async () => {
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
    expect(register).toHaveBeenCalledWith('newfriend', 'correct horse battery staple')
    expect(onNext).toHaveBeenCalledWith('registered')
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
    onMatrixRegisterAccount?: (username: string, password: string) => Promise<void>
    onMatrixLogin?: (request: {
      homeserver: string
      username: string
      password: string
      deviceName?: string
    }) => Promise<void>
    onNext?: () => void
  } = {}) {
    await act(async () => {
      root.render(
        <MatrixAccountScreen
          onMatrixCheckUsernameAvailable={overrides.onMatrixCheckUsernameAvailable ?? vi.fn(async () => true)}
          onMatrixRegisterAccount={overrides.onMatrixRegisterAccount ?? vi.fn(async () => {})}
          onMatrixLogin={overrides.onMatrixLogin ?? vi.fn(async () => {})}
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
