import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MatrixAccountScreen } from './MatrixAccountScreen'
import * as bridge from '../../lib/bridge'
import type { PendingInvitationMetadata } from '../../types/ipc'
import {
  REGISTRATION_CONTINUATION_STORAGE_KEY,
  REGISTRATION_CONTINUATION_TTL_MS,
  createRegistrationContinuation,
} from '../../lib/registration-continuation'
import { useDraftStore } from '../../store/drafts'
import { useSettingsStore } from '../../store/settings'

vi.mock('../../lib/bridge', () => ({
  getMatrixUserPreferences: vi.fn(async () => null),
  isMatrixBackend: vi.fn(() => true),
  isTauriRuntime: vi.fn(() => false),
  matrixAccounts: vi.fn(async () => []),
  matrixServiceCapabilities: vi.fn(),
  matrixOidcStatus: vi.fn(),
  matrixCancelLogin: vi.fn(async () => {}),
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
    useSettingsStore.setState({ signalCheckEnabled: false })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('asks whether the person is new before asking anything about services', async () => {
    await renderScreen()

    /*
      Account creation leads, because a screen whose only primary action was
      "Sign in" left a first-time user with nothing to press. Mesh cannot
      register on any reviewed service itself, so creation is an outward link
      by necessity, and it carries the primary weight rather than hiding in a
      sentence underneath.
    */
    expect(container.textContent).toContain('Welcome to Mesh')
    expect(container.textContent).not.toContain('Choose your account service')
    expect(container.textContent).not.toContain('Mesh service')
    expect(container.textContent).not.toContain('matrix.mesh.dhawal.org')
    const create = findLink('Create an account')
    const returning = findButton('I already have an account')
    expect(create.getAttribute('href')).toMatch(/^https:\/\//)
    expect(create.compareDocumentPosition(returning) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    // The browser handoff and the age requirement are stated before the exit,
    // not after somebody has already left.
    expect(container.textContent).toContain('opens Matrix.org in your browser')
    expect(container.textContent).toContain('18 or over')
    expect(container.querySelector('form')).toBeNull()
  })

  it('lists every reviewed service on one screen for a returning account holder', async () => {
    await renderScreen()
    await openServiceList()

    // One list, replacing a prominent card plus a second "More account
    // services" screen reached by one of two buttons nobody could tell apart.
    expect(container.textContent).toContain('Sign in')
    expect(findButton('Sign in with Matrix.org')).toBeTruthy()
    expect(findButton('Sign in with tchncs.de')).toBeTruthy()
    expect(findButton('Sign in with quassel.io')).toBeTruthy()
    expect(findButton('My service is not listed')).toBeTruthy()
    expect(findLink('Terms').getAttribute('href')).toMatch(/^https:\/\//)
    expect(findLink('Privacy').getAttribute('href')).toMatch(/^https:\/\//)
    expect(container.textContent).not.toContain('server directory')
    expect(container.querySelector('form')).toBeNull()
  })

  it('shows a plain community passport before account-service selection', async () => {
    await renderScreen({ initialPendingInvitation: pendingInvitationMetadata() })

    expect(container.querySelector('[aria-label="Community invitation"]')).not.toBeNull()
    expect(container.textContent).toContain('Garden Club')
    expect(container.textContent).toContain('Invited by Maya')
    expect(container.textContent).toContain('Community service')
    const serviceDetails = container.querySelector<HTMLDetailsElement>('details')
    expect(serviceDetails?.open).toBe(false)
    expect(serviceDetails?.querySelector('summary')?.textContent).toContain('Service details')
    expect(serviceDetails?.textContent).toContain('Service address')
    expect(serviceDetails?.textContent).not.toContain('Community route')
    expect(container.textContent).toContain('Invitation only')
    expect(container.textContent).toContain('Mesh uses this saved invitation after you sign in')
    expect(container.textContent).not.toContain('!garden:community.example')
    expect(container.textContent).not.toContain('registration-token')
  })

  it('does not let a configured service silently override an invitation choice', async () => {
    await renderScreen({
      initialPendingInvitation: pendingInvitationMetadata(),
      initialAccountService: 'matrix.org',
    })

    expect(container.textContent).toContain('Welcome to Mesh')
    expect(container.querySelector('form')).toBeNull()
    await openServiceList()
    expect(findButton('Sign in with Matrix.org')).toBeTruthy()
    expect(findButton('My service is not listed')).toBeTruthy()
  })

  it('does not offer a hard-coded Mesh account service without an invitation', async () => {
    await renderScreen()

    expect(container.textContent).not.toContain('Mesh service')
    expect(container.textContent).not.toContain('matrix.mesh.dhawal.org')
    await openServiceList()
    expect(findButton('Sign in with Matrix.org')).toBeTruthy()
    expect(findButton('My service is not listed')).toBeTruthy()
  })

  it('moves focus to the new heading after account-service transitions', async () => {
    await renderScreen()

    await act(async () => {
      void openServiceList()
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
    })
    expect(document.activeElement).toBe(container.querySelector('h1'))
    expect(document.activeElement?.textContent).toContain('Sign in')

    await act(async () => {
      findButton('Back').click()
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
    })
    expect(document.activeElement).toBe(container.querySelector('h1'))
    expect(document.activeElement?.textContent).toContain('Welcome to Mesh')
  })

  it('keeps an expired prominent service visible but unavailable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    await renderScreen()

    expect(container.textContent).toContain('New accounts are paused')
    expect([...container.querySelectorAll('a')]
      .some((link) => link.textContent?.trim() === 'Create an account')).toBe(false)
    await openServiceList()
    expect(container.textContent).toContain('Matrix.org')
    expect(container.textContent).toContain('Unavailable until Mesh reviews this service again.')
    expect(findButton('Sign in with Matrix.org').disabled).toBe(true)
  })

  it('keeps sign-in available while only the review has lapsed', async () => {
    // Between reviewAfter and hardExpiryAfter. Mesh withdraws its recommendation
    // and the account-creation offer, but an existing account holder must still
    // be able to reach their own account: the build has no update channel, so
    // failing closed here would strand every installed copy on one date.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-05-01T00:00:00Z'))
    await renderScreen()

    expect(container.textContent).toContain('New accounts are paused')
    // The copy that said "Signing in still works." is gone; the offer itself
    // is what has to survive a lapsed review.
    expect(findButton('I already have an account')).toBeTruthy()
    expect([...container.querySelectorAll('a')]
      .some((link) => link.textContent?.trim() === 'Create an account')).toBe(false)
    await openServiceList()
    expect(findButton('Sign in with Matrix.org').disabled).toBe(false)
  })

  it('shows only the reviewed public-service catalog and its disclosures', async () => {
    await renderScreen()

    await openServiceList()

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

    await act(async () => clickLink(findLink('Create an account')))
    expect(container.textContent).toContain('Finish with Matrix.org')
    expect(container.textContent).toContain('saved your place for two hours')
    // The return screen no longer says the invitation is still held, so the
    // return point itself has to prove it still points at that invitation.
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY))
      .toContain(pendingInvitation.handle)
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
    await act(async () => findButton('Continue to sign in').click())
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

    await act(async () => clickLink(findLink('Create an account')))
    await act(async () => findButton('Continue to sign in').click())
    await act(async () => {
      setInputValue(findInput('username'), 'alice')
      setInputValue(findInput('password'), 'correct horse battery staple')
      submitForm()
      await Promise.resolve()
    })

    expect(failedLogin).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(container.querySelector('[role="alert"]'))
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY))
      .toContain('"accountServiceId":"matrix-org"')

    act(() => root.unmount())
    root = createRoot(container)
    await renderScreen({ initialPendingInvitation: pendingInvitation })

    expect(container.textContent).toContain('Finish with Matrix.org')
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY))
      .toContain(pendingInvitation.handle)
  })

  it('uses the same registration continuation for another reviewed public service', async () => {
    await renderScreen({ initialPendingInvitation: pendingInvitationMetadata() })
    await act(async () => { findButton('Use a different service').click() })

    const createLink = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="Create account with tchncs.de"]',
    )
    expect(createLink).not.toBeNull()
    await act(async () => clickLink(createLink!))

    expect(container.textContent).toContain('Finish with tchncs.de')
    expect(container.textContent).toContain('saved your place for two hours')
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

    await act(async () => clickLink(findLink('Create an account')))
    await act(async () => findButton('Cancel').click())

    expect(container.textContent).toContain('Account creation was cancelled.')
    expect(container.textContent).toContain('uses this saved invitation after you sign in')
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

    expect(container.textContent).toContain('saved sign-up return expired')
    await openServiceList()
    expect(findButton('Sign in with Matrix.org')).toBeTruthy()
    expect(findButton('My service is not listed')).toBeTruthy()
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBeNull()
  })

  it('rejects a registration return for a replaced invitation', async () => {
    createRegistrationContinuation({
      invitationTarget: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    })

    await renderScreen({ initialPendingInvitation: pendingInvitationMetadata() })
    await act(async () => findButton('Continue to sign in').click())

    expect(container.textContent).toContain('saved invitation is missing or expired')
    // Back on the service list, which is now a heading and rows with no
    // paragraph under them.
    expect(findButton('Sign in with Matrix.org')).toBeTruthy()
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).toBeNull()
  })

  it('does not discard a continuation while the native invitation is still loading', async () => {
    createRegistrationContinuation({
      invitationTarget: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      accountServiceId: 'matrix-org',
      accountServiceAddress: 'matrix.org',
    })

    await renderScreen()
    await act(async () => findButton('Continue to sign in').click())

    expect(container.textContent).toContain('cannot find your saved invitation yet')
    expect(container.textContent).toContain('Finish with Matrix.org')
    expect(window.localStorage.getItem(REGISTRATION_CONTINUATION_STORAGE_KEY)).not.toBeNull()
  })

  it('uses the explicitly selected Matrix.org service without coupling it to a community', async () => {
    const login = vi.fn(async () => {})
    const onNext = vi.fn()
    await renderScreen({ onMatrixLogin: login, onNext })

    await chooseService('Matrix.org')
    expect(container.textContent).toContain('Sign in to Matrix.org')
    /*
      Who runs the service, and where its policies are. The upload allowance
      that used to sit here decided nothing while somebody was typing a
      password; it belongs to choosing a service, which already happened.
    */
    expect(container.textContent).toContain('Run independently by The Matrix.org Foundation C.I.C.')
    expect(container.textContent).not.toContain('10 MB')

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

  it('keeps a differently hosted community invitation separate from Matrix.org sign-in', async () => {
    const login = vi.fn(async () => {})
    await renderScreen({
      initialPendingInvitation: pendingInvitationMetadata(),
      onMatrixLogin: login,
    })

    expect(container.textContent).toContain('Garden community service')
    expect(container.textContent).toContain('Mesh uses this saved invitation after you sign in')
    await chooseService('Matrix.org')
    await act(async () => {
      setInputValue(findInput('username'), 'alice')
      setInputValue(findInput('password'), 'correct horse battery staple')
      submitForm()
      await Promise.resolve()
    })

    expect(login).toHaveBeenCalledWith(expect.objectContaining({
      homeserver: 'matrix.org',
      username: 'alice',
    }))
  })

  it('offers the invitation service for existing accounts without forcing it', async () => {
    const login = vi.fn(async () => {})
    await renderScreen({
      initialPendingInvitation: pendingInvitationMetadata(),
      onMatrixLogin: login,
    })

    await openServiceList()
    const invitationServiceButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Sign in with Garden community service"]',
    )
    expect(invitationServiceButton).toBeTruthy()
    // The suggested service is one row among the reviewed ones rather than a
    // card with its own disclosure, and it is not preselected.
    expect(invitationServiceButton?.textContent).toContain('Suggested by your invitation')
    expect(invitationServiceButton?.textContent).toContain('community.example')
    expect(findButton('Sign in with Matrix.org')).toBeTruthy()

    await act(async () => invitationServiceButton?.click())
    expect(container.textContent).toContain('Sign in to Garden community service')
    await act(async () => {
      setInputValue(findInput('username'), 'alice')
      setInputValue(findInput('password'), 'correct horse battery staple')
      submitForm()
      await Promise.resolve()
    })

    expect(login).toHaveBeenCalledWith(expect.objectContaining({
      homeserver: 'community.example',
      username: 'alice',
    }))
  })

  it('offers provider-owned password and username recovery help', async () => {
    await renderScreen()
    await chooseService('Matrix.org')

    const recoveryHelp = container.querySelector<HTMLElement>('[aria-label="Sign-in help"]')
    const submit = findButton('Sign in')
    expect(recoveryHelp).not.toBeNull()
    expect(submit.compareDocumentPosition(recoveryHelp!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(findButton('Forgot password?')).toBeTruthy()
    expect(findButton('Forgot username?')).toBeTruthy()

    await act(async () => findButton('Forgot password?').click())
    expect(container.textContent).toContain('Password recovery is handled by Matrix.org')
    expect(findLink('Open Matrix.org account help').getAttribute('href'))
      .toBe('https://app.element.io/#/login')

    await act(async () => findButton('Forgot username?').click())
    expect(container.textContent).toContain('Check the email or password manager')
    expect(findLink('Open Matrix.org account help')).toBeTruthy()
  })

  it('makes a full account ID on the wrong service actionable', async () => {
    await renderScreen()
    await chooseService('Matrix.org')
    setInputValue(findInput('username'), '@thewallran:mesh.dhawal.org')

    expect(container.textContent).toContain('This account belongs to mesh.dhawal.org')
    // Names the control that fixes it, using the label that control carries.
    expect(container.textContent).toContain('My service is not listed')
  })

  it('checks a custom service before signing in with a full Matrix ID', async () => {
    const login = vi.fn(async () => {})
    await renderScreen({ onMatrixLogin: login })

    await useAnotherService()
    await act(async () => {
      setInputValue(findInput('username'), '@alice:friends.example')
      findButton('Check service').click()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Connected. Sign in with')

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

  it('ignores a stale capability result after switching custom services', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    let resolveFirst!: (value: bridge.MatrixServiceCapabilities) => void
    let resolveSecond!: (value: bridge.MatrixServiceCapabilities) => void
    const firstResult = new Promise<bridge.MatrixServiceCapabilities>((resolve) => {
      resolveFirst = resolve
    })
    const secondResult = new Promise<bridge.MatrixServiceCapabilities>((resolve) => {
      resolveSecond = resolve
    })
    vi.mocked(bridge.matrixServiceCapabilities).mockImplementation((homeserver) => (
      homeserver === 'first.example' ? firstResult : secondResult
    ))
    await renderScreen()
    await useAnotherService()

    await act(async () => {
      setInputValue(findInput('homeserver'), 'first.example')
      findButton('Check service').click()
      await Promise.resolve()
    })
    await act(async () => {
      setInputValue(findInput('homeserver'), 'second.example')
      await Promise.resolve()
      findButton('Check service').click()
      await Promise.resolve()
    })

    await act(async () => {
      resolveFirst(capabilities({ homeserver: 'first.example', browserLogin: true }))
      await Promise.resolve()
    })
    expect(container.textContent).toMatch(/Checking/)
    expect(container.textContent).not.toContain('Connected. Sign in with')
    expect(container.textContent).not.toContain('Use browser sign-in')

    await act(async () => {
      resolveSecond(capabilities({ homeserver: 'second.example', browserLogin: false }))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Connected. Sign in with')
    expect(container.textContent).not.toContain('Use browser sign-in')
  })

  it('does not reuse browser sign-in readiness after switching custom services', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixServiceCapabilities).mockImplementation(async (homeserver) => (
      capabilities({ homeserver, browserLogin: true })
    ))
    let resolveFirst!: (value: bridge.MatrixOidcStatus) => void
    const firstStatus = new Promise<bridge.MatrixOidcStatus>((resolve) => {
      resolveFirst = resolve
    })
    vi.mocked(bridge.matrixOidcStatus).mockReturnValue(firstStatus)
    await renderScreen()
    await useAnotherService()

    await act(async () => {
      setInputValue(findInput('homeserver'), 'first.example')
      findButton('Check service').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      findButton('Use browser sign-in').click()
      await Promise.resolve()
    })

    await act(async () => {
      setInputValue(findInput('homeserver'), 'second.example')
      findButton('Check service').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      resolveFirst({
        homeserver: 'first.example',
        availability: 'supported',
        issuer: 'https://auth.first.example',
        ready: true,
        authorizationCodePkce: true,
        clientIdConfigured: true,
        redirectUri: 'http://127.0.0.1:8418/oauth/callback',
        authorizationEndpoint: 'https://auth.first.example/authorize',
        nativeCallbackReady: true,
        reason: '',
      })
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Use browser sign-in')
    expect(container.textContent).not.toContain('Continue in browser')
  })

  it('explains why browser sign-in is disabled outside the installed app', async () => {
    vi.mocked(bridge.matrixServiceCapabilities).mockResolvedValue(capabilities({
      homeserver: 'matrix.org',
      browserLogin: true,
    }))
    await renderScreen()

    await openServiceList()
    await act(async () => {
      findButton('Sign in with Matrix.org').click()
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    const browserButton = findButton('Use browser sign-in')
    const serviceDetails = container.querySelector<HTMLElement>(
      '[aria-label="Matrix.org details"]',
    )
    expect(browserButton.disabled).toBe(true)
    expect(browserButton.getAttribute('aria-describedby')).toBe('browser-sign-in-availability')
    expect(serviceDetails).not.toBeNull()
    expect(browserButton.compareDocumentPosition(serviceDetails!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(container.textContent).toContain('Browser sign-in opens from the installed Mesh app')
  })

  it('rejects credential-bearing and insecure custom-service addresses before probing', async () => {
    await renderScreen()
    await useAnotherService()

    await act(async () => {
      setInputValue(findInput('homeserver'), 'not a service')
      findButton('Check service').click()
    })
    expect(container.textContent).toContain('service address is invalid')

    await act(async () => {
      setInputValue(
        findInput('homeserver'),
        ['https', '://', 'alice', ':', 'secret', '@', 'friends.example'].join(''),
      )
      findButton('Check service').click()
    })
    expect(container.textContent).toContain('must not include sign-in details')

    await act(async () => {
      setInputValue(findInput('homeserver'), 'http://friends.example')
      findButton('Check service').click()
    })
    expect(container.textContent).toContain('secure service address')
    expect(bridge.matrixServiceCapabilities).not.toHaveBeenCalled()
  })

  it('explains when the selected service is offline', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixServiceCapabilities).mockRejectedValue(new Error('offline'))
    await renderScreen()

    await openServiceList()
    await act(async () => {
      findButton('Sign in with Matrix.org').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain(
      "Mesh couldn't reach that account service. Check your connection or choose another service, then try again.",
    )
    expect(container.textContent).not.toContain('Service details')
    expect(container.textContent).not.toContain('[network_unavailable] offline')
    expect(findButton('Back')).toBeTruthy()
  })

  it('shows sanitized provider details only after connection check is enabled', async () => {
    useSettingsStore.setState({ signalCheckEnabled: true })
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixServiceCapabilities).mockRejectedValue(new Error('offline'))
    await renderScreen()

    await openServiceList()
    await act(async () => {
      findButton('Sign in with Matrix.org').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Service details')
    expect(container.textContent).toContain('[network_unavailable] offline')
    expect(container.querySelector('details[open]')).toBeNull()
  })

  it('keeps external registration visible when direct registration is closed', async () => {
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixServiceCapabilities).mockResolvedValue(capabilities({
      homeserver: 'matrix.org',
      registration: 'closed',
    }))
    await renderScreen()

    await openServiceList()
    await act(async () => {
      findButton('Sign in with Matrix.org').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('This service is not taking new accounts.')
    expect(findLink('Create an account in your browser')).toBeTruthy()
  })

  it('clears the prior provider before checking a custom service', async () => {
    await renderScreen()
    await openServiceList()
    await act(async () => {
      findButton('Sign in with Matrix.org').click()
      await Promise.resolve()
    })
    expect(container.querySelector('[aria-label="Matrix.org details"]')).not.toBeNull()

    await act(async () => findButton('Back').click())
    await useAnotherService()

    expect(container.querySelector('[aria-label="Matrix.org details"]')).toBeNull()
    expect(findButton('Check service')).toBeTruthy()
  })

  it('keeps community-hosted account creation optional and bound to its invitation', async () => {
    vi.useFakeTimers()
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixServiceCapabilities).mockResolvedValue(capabilities({
      homeserver: 'community.example',
      registration: 'open',
    }))
    const checkUsername = vi.fn(async () => true)
    const register = vi.fn(async () => {})
    await renderScreen({
      initialPendingInvitation: {
        ...pendingInvitationMetadata(),
        service: 'community.example',
        admissionService: 'https://invites.community.example',
        communityServiceDisplayName: 'Friends Account Service',
      },
      onMatrixCheckUsernameAvailable: checkUsername,
      onMatrixRegisterAccount: register,
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // The invitation-backed service owns account creation inside Mesh, because
    // it is the one service that can answer the in-app registration stages.
    expect(findButton('Create an account')).toBeTruthy()
    await openServiceList()
    expect(findButton('Sign in with Matrix.org')).toBeTruthy()
    await act(async () => { findButton('Back').click() })
    expect(container.textContent).toContain('Friends Account Service')
    expect(container.textContent).toContain('community.example')

    await act(async () => findButton('Create an account').click())
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
      pendingInvitationHandle: 'd283967b-e094-460c-bf06-fbe068c21d5b',
      deviceName: 'Mesh Desktop',
    })
  })

  it('uses only native pending-invitation metadata and discards it explicitly', async () => {
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
    const discardPending = vi.fn(async () => {})

    await renderScreen({
      initialPendingInvitation: pendingInvitation,
      onDiscardPendingInvitation: discardPending,
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(findButton('Create an account')).toBeTruthy()

    await act(async () => findButton('Create an account').click())
    expect(container.textContent).toContain('Mesh uses this saved invitation')
    expect(container.textContent).not.toContain('!garden:community.example')
    expect(container.textContent).not.toContain('d283967b-e094-460c-bf06-fbe068c21d5b')

    await act(async () => {
      findButton('Discard invitation').click()
      await Promise.resolve()
    })
    expect(discardPending).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Mesh uses this saved invitation')
  })

  it('does not hide a newer invitation when an older discard finishes late', async () => {
    let finishDiscard!: () => void
    const discardPending = vi.fn(() => new Promise<void>((resolve) => {
      finishDiscard = resolve
    }))
    const firstInvitation = pendingInvitationMetadata()
    const newerInvitation: PendingInvitationMetadata = {
      ...firstInvitation,
      handle: '875d1969-a61f-4b25-bc5c-e0ebf4cb5f2c',
      communityName: 'Book Club',
    }

    await renderScreen({
      initialPendingInvitation: firstInvitation,
      onDiscardPendingInvitation: discardPending,
    })
    await act(async () => {
      findButton('Discard invitation').click()
      await Promise.resolve()
    })
    await renderScreen({
      initialPendingInvitation: newerInvitation,
      onDiscardPendingInvitation: discardPending,
    })
    expect(container.textContent).toContain('Book Club')

    await act(async () => {
      finishDiscard()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Book Club')
    expect(container.textContent).toContain('Mesh uses this saved invitation')
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
      nativeCallbackReady: true,
      reason: '',
    })
    const oidcLogin = vi.fn(async () => {})
    await renderScreen({ onMatrixOidcLogin: oidcLogin })

    await useAnotherService()
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

  it('offers familiar sign-in without technical details when a saved sign-in expires', async () => {
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
    const switchAccount = vi.fn(async () => {
      throw {
        code: 'not_authenticated',
        detail: '[401] M_UNKNOWN_TOKEN: refresh token does not exist',
        retryable: false,
      }
    })
    const discardInvitation = vi.fn(async () => {})
    await renderScreen({
      onMatrixSwitchAccount: switchAccount,
      initialPendingInvitation: pendingInvitationMetadata(),
      onDiscardPendingInvitation: discardInvitation,
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const continueButton = container.querySelector<HTMLButtonElement>(
      'section[aria-label="Saved accounts"] button',
    )
    expect(continueButton).not.toBeNull()
    await act(async () => {
      continueButton!.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(findInput('username').value).toBe('@alice:friends.example')
    expect(container.textContent).toContain(
      'Your saved sign-in expired. Sign in again to continue.',
    )
    expect(discardInvitation).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('M_UNKNOWN_TOKEN')
    expect(container.textContent).not.toContain('refresh token')
    expect(
      [...container.querySelectorAll('details')]
        .some((details) => details.textContent?.includes('Service details')),
    ).toBe(false)
  })

  it('shows a failed saved-account sign-in without leaving the account list', async () => {
    /*
      Only not_authenticated navigates to the sign-in form, where the error
      region used to live. Every other failure calls setError and stays in
      'select', which rendered no error region at all: the row label flipped
      back from "Opening..." to "Continue" and nothing else happened. This is
      the most-used path for every returning user.
    */
    vi.mocked(bridge.isTauriRuntime).mockReturnValue(true)
    vi.mocked(bridge.matrixAccounts).mockResolvedValue([
      {
        profileId: 'profile-2',
        userId: '@alice:friends.example',
        homeserver: 'https://friends.example',
        deviceId: 'DEVICE',
        lastUsedAt: '2026-07-25T00:00:00Z',
        current: false,
      },
    ])
    const switchAccount = vi.fn(async () => {
      throw {
        code: 'network_unavailable',
        detail: '[000] dial tcp 10.0.0.1:443: connect: network is unreachable',
        retryable: true,
      }
    })
    await renderScreen({ onMatrixSwitchAccount: switchAccount })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const continueButton = container.querySelector<HTMLButtonElement>(
      'section[aria-label="Saved accounts"] button',
    )
    expect(continueButton).not.toBeNull()
    await act(async () => {
      continueButton!.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Still on the account list, and the failure is on screen rather than lost.
    expect(container.querySelector('section[aria-label="Saved accounts"]')).not.toBeNull()
    expect(container.textContent).toContain(
      'We could not reach your account service. Check your connection and try again.',
    )
    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    // The raw transport failure stays out of the primary message.
    expect(container.textContent).not.toContain('dial tcp')
    expect(container.textContent).not.toContain('network is unreachable')
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
      pendingInvitationHandle?: string
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
    initialPendingInvitation?: PendingInvitationMetadata
    initialAccountService?: string
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
          initialPendingInvitation={overrides.initialPendingInvitation}
          initialAccountService={overrides.initialAccountService}
          onDiscardPendingInvitation={overrides.onDiscardPendingInvitation}
          onNext={overrides.onNext ?? (() => {})}
        />,
      )
    })
  }

  function findButton(label: string): HTMLButtonElement {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    const button = buttons.find((candidate) => candidate.textContent?.trim() === label)
      ?? buttons.find((candidate) => candidate.getAttribute('aria-label') === label)
    if (!button) throw new Error(`Button not found: ${label}`)
    return button
  }

  /*
    The first screen now asks whether you are new or returning, so every
    journey that starts at a service answers "returning" first. This is
    idempotent: tests that already stand past the welcome screen, or that
    resume from a saved registration, call it harmlessly.
  */
  async function openServiceList() {
    const returning = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'I already have an account')
    if (returning) await act(async () => { returning.click() })
  }

  async function chooseService(name: string) {
    await openServiceList()
    await act(async () => { findButton(`Sign in with ${name}`).click() })
  }

  async function useAnotherService() {
    await openServiceList()
    await act(async () => { findButton('My service is not listed').click() })
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
