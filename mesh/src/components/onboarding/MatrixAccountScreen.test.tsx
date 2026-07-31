import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MatrixAccountScreen } from './MatrixAccountScreen'
import * as bridge from '../../lib/bridge'
import type { MatrixCommunityAdmission, PendingInvitationMetadata } from '../../types/ipc'
import {
  REGISTRATION_CONTINUATION_STORAGE_KEY,
  REGISTRATION_CONTINUATION_TTL_MS,
  createRegistrationContinuation,
} from '../../lib/registration-continuation'
import { useDraftStore } from '../../store/drafts'

vi.mock('../../lib/bridge', () => ({
  getMatrixUserPreferences: vi.fn(async () => null),
  isMatrixBackend: vi.fn(() => true),
  isTauriRuntime: vi.fn(() => false),
  matrixAccounts: vi.fn(async () => []),
  matrixServiceCapabilities: vi.fn(),
  matrixOidcStatus: vi.fn(),
  matrixCancelLogin: vi.fn(async () => {}),
  resolveCommunityInvite: vi.fn(),
  setKv: vi.fn(async () => {}),
  updateMatrixUserPreferences: vi.fn(async () => {}),
}))

describe('MatrixAccountScreen', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(false)
    vi.mocked(bridge.matrixAccounts).mockResolvedValue([])
    window.localStorage.clear()
    useDraftStore.setState({ drafts: {} })
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
    expect(container.textContent).toContain('opens this service in your browser')
    expect(container.textContent).toContain('Return to Mesh afterward')
    // Public services now expose registration and sign-in as equal, explicit choices.
    expect(findLink('Create account').getAttribute('href')).toMatch(/^https:\/\//)
    expect(findLink('Terms').getAttribute('href')).toMatch(/^https:\/\//)
    expect(findLink('Privacy').getAttribute('href')).toMatch(/^https:\/\//)
    expect(findButton('Sign in')).toBeTruthy()
    expect(findButton('More public services')).toBeTruthy()
    expect(findButton('Use another service')).toBeTruthy()
    expect(container.querySelector('form')).toBeNull()
  })

  it('shows a plain community passport before account-service selection', async () => {
    await renderScreen({ initialPendingInvitation: pendingInvitationMetadata() })

    expect(container.querySelector('[aria-label="Community invitation"]')).not.toBeNull()
    expect(container.textContent).toContain('Garden Club')
    expect(container.textContent).toContain('Invited by Maya')
    expect(container.textContent).toContain('Community service')
    expect(container.textContent).toContain('Community route')
    expect(container.textContent).toContain('Invitation only')
    expect(container.textContent).toContain('Choose where your account lives below')
    expect(container.textContent).not.toContain('!garden:community.example')
    expect(container.textContent).not.toContain('registration-token')
  })

  it('keeps an expired prominent service visible but unavailable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    await renderScreen()

    expect(container.textContent).toContain('Matrix.org')
    expect(container.textContent).toContain('Review expired')
    expect(findButton('Create account').disabled).toBe(true)
    expect(findButton('Sign in').disabled).toBe(true)
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

  it('survives a Matrix.org registration round trip and app restart', async () => {
    const pendingInvitation = pendingInvitationMetadata()
    const login = vi.fn(async () => {})
    const onNext = vi.fn()
    await renderScreen({
      initialPendingInvitation: pendingInvitation,
      onMatrixLogin: login,
      onNext,
    })

    await act(async () => clickLink(findLink('Create account')))
    expect(container.textContent).toContain('Finish with Matrix.org')
    expect(container.textContent).toContain('saved your place for two hours')
    expect(container.textContent).toContain('invitation remains protected')
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY))
      .not.toContain('!garden:community.example')

    act(() => root.unmount())
    root = createRoot(container)
    await renderScreen({
      initialPendingInvitation: pendingInvitation,
      onMatrixLogin: login,
      onNext,
    })

    expect(container.textContent).toContain('Finish with Matrix.org')
    await act(async () => findButton('I created my account — sign in').click())
    expect(container.textContent).toContain('Sign in to Matrix.org')
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).not.toBeNull()

    await act(async () => {
      setInputValue(findInput('username'), 'alice')
      setInputValue(findInput('password'), 'correct horse battery staple')
      submitForm()
      await Promise.resolve()
    })

    expect(login).toHaveBeenCalledOnce()
    expect(onNext).toHaveBeenCalledWith('signed-in')
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBeNull()
  })

  it('retains the invitation and selected service after a failed login and restart', async () => {
    const pendingInvitation = pendingInvitationMetadata()
    const failedLogin = vi.fn(async () => {
      throw new Error('offline')
    })
    await renderScreen({
      initialPendingInvitation: pendingInvitation,
      onMatrixLogin: failedLogin,
    })

    await act(async () => clickLink(findLink('Create account')))
    await act(async () => findButton('I created my account — sign in').click())
    await act(async () => {
      setInputValue(findInput('username'), 'alice')
      setInputValue(findInput('password'), 'correct horse battery staple')
      submitForm()
      await Promise.resolve()
    })

    expect(failedLogin).toHaveBeenCalledOnce()
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY))
      .toContain('"accountServiceId":"matrix-org"')

    act(() => root.unmount())
    root = createRoot(container)
    await renderScreen({ initialPendingInvitation: pendingInvitation })

    expect(container.textContent).toContain('Finish with Matrix.org')
    expect(container.textContent).toContain('invitation remains protected')
  })

  it('uses the same registration continuation for another reviewed public service', async () => {
    await renderScreen({ initialPendingInvitation: pendingInvitationMetadata() })
    await act(async () => findButton('More public services').click())

    const createLink = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="Create account with tchncs.de"]',
    )
    expect(createLink).not.toBeNull()
    await act(async () => clickLink(createLink!))

    expect(container.textContent).toContain('Finish with tchncs.de')
    expect(container.textContent).toContain('provider credentials')
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY))
      .toContain('"accountServiceId":"tchncs-de"')
  })

  it('cancels external registration without discarding the invitation', async () => {
    const pendingInvitation = pendingInvitationMetadata()
    const discardPending = vi.fn(async () => {})
    await renderScreen({
      initialPendingInvitation: pendingInvitation,
      onDiscardPendingInvitation: discardPending,
    })

    await act(async () => clickLink(findLink('Create account')))
    await act(async () => findButton('Cancel').click())

    expect(container.textContent).toContain('invitation is still saved')
    expect(container.textContent).toContain('used after you sign in')
    expect(discardPending).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBeNull()
  })

  it('fails closed with a recovery action when saved registration state expires', async () => {
    createRegistrationContinuation({
      invitationTarget: null,
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    }, Date.now() - REGISTRATION_CONTINUATION_TTL_MS - 1)

    await renderScreen()

    expect(container.textContent).toContain('saved registration return expired')
    expect(findButton('Sign in')).toBeTruthy()
    expect(findButton('Use another service')).toBeTruthy()
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBeNull()
  })

  it('rejects a registration return for a replaced invitation', async () => {
    createRegistrationContinuation({
      invitationTarget: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    })

    await renderScreen({ initialPendingInvitation: pendingInvitationMetadata() })
    await act(async () => findButton('I created my account — sign in').click())

    expect(container.textContent).toContain('saved invitation is missing or expired')
    expect(container.textContent).toContain('Choose your account service')
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBeNull()
  })

  it('does not discard a continuation while the native invitation is still loading', async () => {
    createRegistrationContinuation({
      invitationTarget: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    })

    await renderScreen()
    await act(async () => findButton('I created my account — sign in').click())

    expect(container.textContent).toContain('could not find the saved community invitation yet')
    expect(container.textContent).toContain('Finish with Matrix.org')
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).not.toBeNull()
  })

  it('uses the explicitly selected Matrix.org service without coupling it to a community', async () => {
    const login = vi.fn(async () => {})
    const onNext = vi.fn()
    await renderScreen({ onMatrixLogin: login, onNext })

    await act(async () => findButton('Sign in').click())
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
      findButton('Sign in').click()
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
      findButton('Sign in').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Direct account creation is closed')
    expect(findLink('Create a Matrix.org account in your browser')).toBeTruthy()
  })

  it('clears the prior provider before checking a custom service', async () => {
    await renderScreen()
    await act(async () => {
      findButton('Sign in').click()
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
      communityServiceDisplayName: 'Friends Account Service',
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
    expect(findButton('Sign in')).toBeTruthy()
    // The invitation-backed service still owns only account creation; public registration is a link.
    expect(findButton('Create account')).toBeTruthy()
    expect(container.textContent).toContain('Friends Account Service')
    expect(container.textContent).toContain('community.example')

    await act(async () => findButton('Create account').click())
    expect(container.textContent).toContain('Create your account with Friends Account Service')
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
    expect(findButton('Create account')).toBeTruthy()

    await act(async () => findButton('Create account').click())
    expect(container.textContent).toContain('Invitation saved securely on this device')
    expect(container.textContent).not.toContain('!garden:community.example')
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

  it('clears previous-account renderer data after a saved-account switch succeeds', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixAccounts).mockResolvedValue([
      {
        profileId: 'profile-2',
        userId: '@bob:friends.example',
        homeserver: 'https://friends.example',
        deviceId: 'DEVICE',
        lastUsedAt: '2026-07-25T00:00:00Z',
        current: false,
      },
    ])
    useDraftStore.setState({ drafts: { '!shared:example.org': 'Alice private draft' } })
    const switchAccount = vi.fn(async () => {})
    let resolveNext!: () => void
    const nextCalled = new Promise<void>((resolve) => {
      resolveNext = resolve
    })
    const onNext = vi.fn(() => resolveNext())
    await renderScreen({ onMatrixSwitchAccount: switchAccount, onNext })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(container.textContent).toContain('bob')
    const continueButton = container.querySelector<HTMLButtonElement>(
      'section[aria-label="Saved accounts"] button',
    )
    expect(continueButton).not.toBeNull()
    await act(async () => {
      continueButton!.click()
      await nextCalled
    })

    expect(switchAccount).toHaveBeenCalledWith('profile-2')
    expect(useDraftStore.getState().drafts).toEqual({})
    expect(onNext).toHaveBeenCalledWith('signed-in')
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
    onMatrixSwitchAccount?: (profileId: string) => Promise<void>
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
          onMatrixSwitchAccount={overrides.onMatrixSwitchAccount}
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

  function clickLink(link: HTMLAnchorElement) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    event.preventDefault()
    link.dispatchEvent(event)
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

function pendingInvitationMetadata(): PendingInvitationMetadata {
  return {
    handle: 'd283967b-e094-460c-bf06-fbe068c21d5b',
    roomOrAlias: '!garden:community.example',
    via: ['community.example'],
    service: 'community.example',
    admissionService: null,
    communityName: 'Garden Club',
    inviterDisplayName: 'Maya',
    communityServiceDisplayName: 'Garden community service',
    joinRule: 'invite',
    storedAt: 1_786_000_000_000,
    expiresAt: 1_788_592_000_000,
  }
}
