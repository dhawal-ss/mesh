import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MatrixAccountScreen } from './MatrixAccountScreen'
import * as bridge from '../../lib/bridge'
import type { MatrixCommunityAdmission, PendingInvitationMetadata } from '../../types/ipc'

vi.mock('../../lib/bridge', () => ({
  isTauriRuntime: vi.fn(() => false),
  matrixAccounts: vi.fn(async () => []),
  matrixServiceCapabilities: vi.fn(),
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
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('requires an explicit account-service choice', async () => {
    await renderScreen()

    expect(container.textContent).toContain('Choose your account service')
    expect(container.textContent).toContain('Matrix.org')
    expect(container.textContent).toContain('independently')
    expect(findButton('Choose Matrix.org')).toBeTruthy()
    expect(findButton('More public services')).toBeTruthy()
    expect(findButton('Use another service')).toBeTruthy()
    expect(container.querySelector('form')).toBeNull()
  })

  it('shows only the reviewed public-service catalog and its disclosures', async () => {
    await renderScreen()

    await act(async () => findButton('More public services').click())

    expect(container.textContent).toContain('manually reviewed')
    expect(container.textContent).toContain('tchncs.de')
    expect(container.textContent).toContain('quassel.io')
    expect(findLink('Terms').getAttribute('href')).toMatch(/^https:\/\//)
    expect(container.textContent).not.toContain('server directory')
  })

  it('uses the explicitly selected Matrix.org service without coupling it to a community', async () => {
    const login = vi.fn(async () => {})
    const onNext = vi.fn()
    await renderScreen({ onMatrixLogin: login, onNext })

    await act(async () => findButton('Choose Matrix.org').click())
    expect(container.textContent).toContain('Sign in to Matrix.org')
    expect(container.textContent).toContain('10 MB')
    expect(container.textContent).toContain('100 MB')

    await act(async () => {
      setInputValue(findInput('username'), 'Dhawal')
      setInputValue(findInput('password'), 'correct horse battery staple')
      submitForm()
      await Promise.resolve()
    })

    expect(login).toHaveBeenCalledWith({
      homeserver: 'matrix.org',
      username: 'dhawal',
      password: 'correct horse battery staple',
      deviceName: 'Mesh Desktop',
    })
    expect(onNext).toHaveBeenCalledWith('signed-in')
  })

  it('checks a custom service before signing in with a full Matrix ID', async () => {
    const login = vi.fn(async () => {})
    await renderScreen({ onMatrixLogin: login })

    await act(async () => findButton('Use another service').click())
    await act(async () => {
      setInputValue(findInput('username'), '@alice:friends.example')
      findButton('Check service').click()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Service reached')

    await act(async () => {
      setInputValue(findInput('password'), 'correct horse battery staple')
      submitForm()
      await Promise.resolve()
    })

    expect(login).toHaveBeenCalledWith(expect.objectContaining({
      homeserver: 'friends.example',
      username: '@alice:friends.example',
    }))
  })

  it('rejects credential-bearing and insecure custom-service addresses before probing', async () => {
    await renderScreen()
    await act(async () => findButton('Use another service').click())

    await act(async () => {
      setInputValue(
        findInput('homeserver'),
        ['https', '://', 'alice', ':', 'secret', '@', 'friends.example'].join(''),
      )
      findButton('Check service').click()
    })
    expect(container.textContent).toContain('must not contain credentials')

    await act(async () => {
      setInputValue(findInput('homeserver'), 'http://friends.example')
      findButton('Check service').click()
    })
    expect(container.textContent).toContain('must use HTTPS')
    expect(bridge.matrixServiceCapabilities).not.toHaveBeenCalled()
  })

  it('explains when the selected service is offline', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixServiceCapabilities).mockRejectedValue(new Error('offline'))
    await renderScreen()

    await act(async () => {
      findButton('Choose Matrix.org').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain(
      "Mesh couldn't reach that account service. Check your connection or choose another service, then try again.",
    )
    expect(container.textContent).toContain('Technical details')
    expect(container.textContent).toContain('[network_unavailable] offline')
    expect(container.querySelector('details[open]')).toBeNull()
    expect(findButton('Back to service choices')).toBeTruthy()
  })

  it('keeps external registration visible when direct registration is closed', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixServiceCapabilities).mockResolvedValue(capabilities({
      homeserver: 'matrix.org',
      registration: 'closed',
    }))
    await renderScreen()

    await act(async () => {
      findButton('Choose Matrix.org').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Direct account creation is closed')
    expect(findLink('Create a Matrix.org account in your browser')).toBeTruthy()
  })

  it('clears the prior provider before checking a custom service', async () => {
    await renderScreen()
    await act(async () => {
      findButton('Choose Matrix.org').click()
      await Promise.resolve()
    })
    expect(container.querySelector('[aria-label="Matrix.org service details"]')).not.toBeNull()

    await act(async () => findButton('Back to service choices').click())
    await act(async () => findButton('Use another service').click())

    expect(container.querySelector('[aria-label="Matrix.org service details"]')).toBeNull()
    expect(findButton('Check service')).toBeTruthy()
  })

  it('keeps community-hosted account creation optional and bound to its invitation', async () => {
    vi.useFakeTimers()
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.resolveCommunityInvite).mockResolvedValue({
      registrationToken: 'derived-registration-token',
      roomId: '!friends:community.example',
      service: 'community.example',
      via: ['community.example'],
      expiresAt: 1_785_283_200_000,
    })
    vi.mocked(bridge.matrixServiceCapabilities).mockResolvedValue(capabilities({
      homeserver: 'community.example',
      registration: 'open',
    }))
    const checkUsername = vi.fn(async () => true)
    const register = vi.fn(async () => {})
    const link = 'https://mesh.test/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
    await renderScreen({
      initialInvitation: link,
      onMatrixCheckUsernameAvailable: checkUsername,
      onMatrixRegisterAccount: register,
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(findButton('Choose Matrix.org')).toBeTruthy()
    expect(findButton('Choose community-hosted service')).toBeTruthy()

    await act(async () => findButton('Choose community-hosted service').click())
    await act(async () => {
      setInputValue(findInput('username'), 'NewFriend')
      setInputValue(findInput('password'), 'correct horse battery staple')
      setInputValue(findInput('password-confirmation'), 'correct horse battery staple')
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(checkUsername).toHaveBeenCalledWith('community.example', 'newfriend')
    expect(findButton('Create account').disabled).toBe(false)

    await act(async () => {
      submitForm()
      await Promise.resolve()
    })
    expect(register).toHaveBeenCalledWith({
      homeserver: 'community.example',
      username: 'newfriend',
      password: 'correct horse battery staple',
      registrationToken: 'derived-registration-token',
      deviceName: 'Mesh Desktop',
    })
  })

  it('resolves native pending-invitation metadata and discards it explicitly', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixServiceCapabilities).mockResolvedValue(capabilities({
      homeserver: 'community.example',
      registration: 'open',
    }))
    const pendingInvitation: PendingInvitationMetadata = {
      handle: 'd283967b-e094-460c-bf06-fbe068c21d5b',
      roomOrAlias: '!garden:community.example',
      via: ['community.example'],
      service: 'community.example',
      admissionService: 'https://invites.community.example',
      storedAt: 1_752_000_000_000,
      expiresAt: 1_754_592_000_000,
    }
    const resolvePending = vi.fn(async (): Promise<MatrixCommunityAdmission> => ({
      registrationToken: 'native-only-registration-token',
      roomId: '!garden:community.example',
      service: 'community.example',
      via: ['community.example'],
      expiresAt: 1_754_592_000_000,
    }))
    const discardPending = vi.fn(async () => {})

    await renderScreen({
      initialPendingInvitation: pendingInvitation,
      onResolvePendingInvitation: resolvePending,
      onDiscardPendingInvitation: discardPending,
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(resolvePending).toHaveBeenCalledTimes(1)
    expect(findButton('Choose community-hosted service')).toBeTruthy()

    await act(async () => findButton('Choose community-hosted service').click())
    expect(container.textContent).toContain('Invitation saved securely on this device')
    expect(container.textContent).toContain('!garden:community.example')
    expect(container.textContent).not.toContain('native-only-registration-token')

    await act(async () => {
      findButton('Discard invitation').click()
      await Promise.resolve()
    })
    expect(discardPending).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Invitation saved securely on this device')
  })

  it('offers browser sign-in only after the selected custom service advertises it', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixServiceCapabilities).mockResolvedValue(capabilities({
      homeserver: 'friends.example',
      browserLogin: true,
    }))
    vi.mocked(bridge.matrixOidcStatus).mockResolvedValue({
      homeserver: 'friends.example',
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
    await renderScreen({ onMatrixOidcLogin: oidcLogin })

    await act(async () => findButton('Use another service').click())
    await act(async () => {
      setInputValue(findInput('homeserver'), 'friends.example')
      findButton('Check service').click()
      await Promise.resolve()
    })
    await act(async () => {
      findButton('Use browser sign-in').click()
      await Promise.resolve()
    })
    await act(async () => {
      findButton('Continue in browser').click()
      await Promise.resolve()
    })

    expect(bridge.matrixOidcStatus).toHaveBeenCalledWith('friends.example')
    expect(oidcLogin).toHaveBeenCalledWith('friends.example')
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
    })

    expect(container.textContent).toContain('alice')
    expect(container.textContent).not.toContain('@alice:friends.example')
    expect(container.textContent).not.toContain('friends.example')
  })

  async function renderScreen(overrides: {
    onMatrixCheckUsernameAvailable?: (homeserver: string, username: string) => Promise<boolean>
    onMatrixRegisterAccount?: (request: {
      homeserver: string
      username: string
      password: string
      registrationToken?: string
      deviceName?: string
    }) => Promise<void>
    onMatrixLogin?: (request: {
      homeserver: string
      username: string
      password: string
      deviceName?: string
    }) => Promise<void>
    onMatrixOidcLogin?: (homeserver: string) => Promise<void>
    initialInvitation?: string
    initialPendingInvitation?: PendingInvitationMetadata
    onResolvePendingInvitation?: () => Promise<MatrixCommunityAdmission | null>
    onDiscardPendingInvitation?: () => Promise<void>
    onNext?: (outcome: 'registered' | 'signed-in') => void
  } = {}) {
    await act(async () => {
      root.render(
        <MatrixAccountScreen
          onMatrixCheckUsernameAvailable={
            overrides.onMatrixCheckUsernameAvailable ?? vi.fn(async () => true)
          }
          onMatrixRegisterAccount={
            overrides.onMatrixRegisterAccount ?? vi.fn(async () => {})
          }
          onMatrixLogin={overrides.onMatrixLogin ?? vi.fn(async () => {})}
          onMatrixOidcLogin={overrides.onMatrixOidcLogin ?? vi.fn(async () => {})}
          initialInvitation={overrides.initialInvitation}
          initialPendingInvitation={overrides.initialPendingInvitation}
          onResolvePendingInvitation={overrides.onResolvePendingInvitation}
          onDiscardPendingInvitation={overrides.onDiscardPendingInvitation}
          onNext={overrides.onNext ?? (() => {})}
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

  function findLink(label: string): HTMLAnchorElement {
    const link = [...container.querySelectorAll<HTMLAnchorElement>('a')]
      .find((candidate) => candidate.textContent?.trim() === label)
    if (!link) throw new Error(`Link not found: ${label}`)
    return link
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

function capabilities(
  overrides: Partial<bridge.MatrixServiceCapabilities> = {},
): bridge.MatrixServiceCapabilities {
  return {
    homeserver: 'matrix.example',
    serverVersions: ['v1.11'],
    passwordLogin: true,
    browserLogin: false,
    registration: 'unknown',
    maxUploadBytes: null,
    ...overrides,
  }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
