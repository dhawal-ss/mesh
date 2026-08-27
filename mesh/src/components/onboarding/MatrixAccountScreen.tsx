import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Avatar } from '../ui/Avatar'
import * as bridge from '../../lib/bridge'
import {
  MATRIX_ORG_SERVICE,
  PUBLIC_SERVICES,
  publicServiceReviewExpired,
  publicServiceUnavailable,
  type PublicService,
} from '../../config/public-services'
import type { PendingInvitationMetadata } from '../../types/ipc'
import type { OnboardingFlowProps } from './types'
import {
  friendlyAccountCreationError,
  normalizeUsername,
  passwordStrength,
  usernameValidationError,
} from './accountCreation'
import {
  normalizeServiceAddress,
  displayServiceAddress,
  friendlyServiceError,
  resolveServiceAddress,
  serviceFromUsername,
  serviceAddressConfigError,
  technicalSignInError,
  friendlySignInError,
} from './matrixSignIn'
import {
  clearRegistrationContinuation,
  consumeRegistrationContinuation,
  createRegistrationContinuation,
  inspectRegistrationContinuation,
  type RegistrationContinuation,
} from '../../lib/registration-continuation'
import {
  beginInvitationActivation,
  recordInvitationMilestone,
} from '../../lib/invitation-activation'
import { normalizeError } from '../../lib/errors'
import { useSettingsStore } from '../../store/settings'

/*
 * `welcome` asks the only question a first-time person can answer: are you new
 * here, or do you have an account already. Every other mode below asks
 * something that presumes a Matrix account already exists, or presumes the
 * asker knows what an account service is. Those questions are real, but they
 * are the second question, and putting them first was the reason the first
 * screen opened on "Choose your account service" with a primary button reading
 * "Sign in" that a new person could not use.
 */
type AccountMode =
  | 'welcome'
  | 'select'
  | 'registration-return'
  | 'create'
  | 'sign-in'
  | 'advanced'
type Availability = 'idle' | 'checking' | 'available' | 'taken' | 'error'
type AvailabilityCheck = {
  serviceIdentity: string
  username: string
  status: Exclude<Availability, 'idle' | 'checking'>
}
export type MatrixAccountOutcome = 'registered' | 'signed-in'

type SelectedAccountService =
  | { kind: 'public'; service: PublicService }
  | { kind: 'community'; name: string; address: string }
  | { kind: 'configured'; name: string; address: string }

type MatrixAccountScreenProps = Pick<
  OnboardingFlowProps,
  | 'onMatrixCheckUsernameAvailable'
  | 'onMatrixRegisterAccount'
  | 'onMatrixLogin'
  | 'onMatrixOidcLogin'
  | 'onMatrixSwitchAccount'
  | 'onDiscardPendingInvitation'
> & {
  onNext: (outcome: MatrixAccountOutcome) => void
  initialPendingInvitation?: PendingInvitationMetadata | null
  initialAccountService?: string
  hideInvitationSummary?: boolean
}

// Read wall-clock time only from explicit user-action handlers. Keeping this
// outside the component prevents an expiry check from becoming render input.
function currentEpochMsForUserAction(): number {
  return Date.now()
}

export function MatrixAccountScreen({
  onMatrixCheckUsernameAvailable,
  onMatrixRegisterAccount,
  onMatrixLogin,
  onMatrixOidcLogin,
  onMatrixSwitchAccount,
  onDiscardPendingInvitation,
  onNext,
  initialPendingInvitation = null,
  initialAccountService,
  hideInvitationSummary = false,
}: MatrixAccountScreenProps) {
  const [registrationStartup] = useState(initializeRegistrationContinuation)
  const normalizedInitialService = initialPendingInvitation
    ? null
    : normalizeServiceAddress(initialAccountService ?? '')
  const [mode, setMode] = useState<AccountMode>(
    registrationStartup.service
      ? 'registration-return'
      : normalizedInitialService
        ? 'sign-in'
        : 'welcome',
  )
  const [selectedService, setSelectedService] = useState<SelectedAccountService | null>(
    registrationStartup.service
      ? { kind: 'public', service: registrationStartup.service }
      : normalizedInitialService
      ? {
          kind: 'configured',
          name: 'Selected service',
          address: normalizedInitialService,
        }
      : null,
  )
  /*
    Whether the service list is being read to sign in or to create. The rows
    are identical either way, so this is one boolean rather than a second
    screen. Creation matters here and not only on the welcome screen: starting
    it from Mesh is what writes the return point that keeps a pending community
    invitation alive across the trip to the browser, so a person who wants an
    account somewhere other than the recommended service would otherwise have
    to choose between their preferred provider and their invitation.
  */
  const [serviceListIntent, setServiceListIntent] = useState<'sign-in' | 'create'>('sign-in')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [dismissedPendingInvitationHandle, setDismissedPendingInvitationHandle] =
    useState<string | null>(null)
  const [serviceAddress, setServiceAddress] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [recoveryHelp, setRecoveryHelp] = useState<'password' | 'username' | null>(null)
  const [availabilityCheck, setAvailabilityCheck] = useState<AvailabilityCheck | null>(null)
  const [error, setErrorMessage] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [savedSignInNotice, setSavedSignInNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [switchingProfile, setSwitchingProfile] = useState<string | null>(null)
  const [savedAccounts, setSavedAccounts] = useState<bridge.MatrixAccount[]>([])
  const [checkingBrowser, setCheckingBrowser] = useState(false)
  const [browserReady, setBrowserReady] = useState(false)
  const [browserSigningIn, setBrowserSigningIn] = useState(false)
  const signalCheckEnabled = useSettingsStore((state) => state.signalCheckEnabled)
  const [capabilities, setCapabilities] = useState<bridge.MatrixServiceCapabilities | null>(null)
  const [checkingCapabilities, setCheckingCapabilities] = useState(false)
  const [registrationContinuation, setRegistrationContinuation] =
    useState<RegistrationContinuation | null>(registrationStartup.continuation)
  const [continuationNotice, setContinuationNotice] =
    useState<string | null>(registrationStartup.notice)
  const modeHeadingRef = useRef<HTMLHeadingElement>(null)
  const previousModeRef = useRef<AccountMode>(mode)
  const availabilityGenerationRef = useRef(0)
  const capabilityGenerationRef = useRef(0)
  const browserGenerationRef = useRef(0)
  const errorSummaryRef = useRef<HTMLDivElement>(null)
  const modeHeadingFrameRef = useRef<number | null>(null)

  const setError = useCallback((message: string | null, cause?: unknown) => {
    setErrorMessage(message)
    setErrorDetails(
      signalCheckEnabled && message && cause !== undefined
        ? technicalSignInError(cause)
        : null,
    )
  }, [signalCheckEnabled])

  useEffect(() => {
    if (!error) return
    if (modeHeadingFrameRef.current !== null) {
      window.cancelAnimationFrame(modeHeadingFrameRef.current)
      modeHeadingFrameRef.current = null
    }
    errorSummaryRef.current?.focus()
  }, [error])

  const normalizedUsername = useMemo(() => normalizeUsername(username), [username])
  const createUsernameError = useMemo(
    () => mode === 'create' ? usernameValidationError(username) : null,
    [mode, username],
  )
  const strength = useMemo(() => passwordStrength(password), [password])
  const passwordsMatch = passwordConfirmation.length > 0 && password === passwordConfirmation
  const storedPendingInvitation = initialPendingInvitation
    && initialPendingInvitation.handle !== dismissedPendingInvitationHandle
    ? initialPendingInvitation
    : null
  const pendingInvitationHandle = storedPendingInvitation?.handle ?? null

  useEffect(() => {
    if (!storedPendingInvitation) return
    beginInvitationActivation(
      storedPendingInvitation.handle,
      storedPendingInvitation.storedAt,
    )
    recordInvitationMilestone(storedPendingInvitation.handle, 'destination-visible')
    if (
      registrationContinuation?.invitationTarget === storedPendingInvitation.handle
    ) {
      recordInvitationMilestone(
        storedPendingInvitation.handle,
        'service-selected',
        registrationContinuation.createdAt,
      )
      recordInvitationMilestone(
        storedPendingInvitation.handle,
        'account-handoff-started',
        registrationContinuation.createdAt,
      )
    }
  }, [registrationContinuation, storedPendingInvitation])

  const offeredCommunityService = storedPendingInvitation?.service ?? null
  const communityAccountCreationOffered = Boolean(
    offeredCommunityService && storedPendingInvitation?.admissionService,
  )
  const selectedServiceAddress = selectedService?.kind === 'public'
    ? selectedService.service.serviceAddress
    : selectedService?.address ?? ''
  const selectedServiceIdentity = normalizeServiceAddress(selectedServiceAddress) ?? ''
  const resolvedService = useMemo(
    () => resolveServiceAddress(
      mode === 'advanced' ? 'advanced' : 'recommended',
      username,
      serviceAddress,
      selectedServiceAddress,
    ),
    [mode, selectedServiceAddress, serviceAddress, username],
  )
  const availabilityUsername =
    mode === 'create'
    && normalizedUsername
    && !createUsernameError
    && onMatrixCheckUsernameAvailable
    && selectedServiceIdentity
      ? normalizedUsername
      : null
  const availability: Availability = !availabilityUsername
    ? 'idle'
    : availabilityCheck?.serviceIdentity === selectedServiceIdentity
      && availabilityCheck.username === availabilityUsername
      ? availabilityCheck.status
      : 'checking'

  useEffect(() => {
    if (!bridge.isTauriRuntime()) return
    let active = true
    void bridge.matrixAccounts().then((accounts) => {
      if (active) setSavedAccounts(accounts)
    }).catch(() => {
      // A missing local account list must not block sign-in or account creation.
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (
      !selectedServiceAddress
      || mode === 'welcome'
      || mode === 'select'
      || mode === 'registration-return'
      || mode === 'advanced'
    ) {
      return
    }
    if (!bridge.isTauriRuntime()) {
      const publicService = selectedService?.kind === 'public'
        ? selectedService.service
        : null
      const timer = window.setTimeout(() => {
        setCapabilities({
          homeserver: selectedServiceAddress,
          serverVersions: ['preview'],
          passwordLogin: publicService?.loginMethods.includes('password') ?? true,
          browserLogin: publicService?.loginMethods.includes('browser') ?? false,
          registration: selectedService?.kind === 'community' ? 'open' : 'unknown',
          maxUploadBytes: publicService?.freeUseLimits.maxAttachmentBytes ?? null,
        })
      }, 0)
      return () => window.clearTimeout(timer)
    }

    const generation = ++capabilityGenerationRef.current
    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setCheckingCapabilities(true)
      setCapabilities(null)
      setError(null)
      try {
        const nextCapabilities = await bridge.matrixServiceCapabilities(selectedServiceIdentity)
        if (active && generation === capabilityGenerationRef.current) {
          setCapabilities(nextCapabilities)
        }
      } catch (cause) {
        if (!active || generation !== capabilityGenerationRef.current) return
        setError(friendlyServiceError(cause, 'reach that account service'), cause)
      } finally {
        if (active && generation === capabilityGenerationRef.current) {
          setCheckingCapabilities(false)
        }
      }
    })
    return () => {
      active = false
    }
  }, [mode, selectedService, selectedServiceAddress, selectedServiceIdentity, setError])

  useEffect(() => {
    if (!availabilityUsername || !onMatrixCheckUsernameAvailable) return

    const serviceIdentity = selectedServiceIdentity
    const generation = ++availabilityGenerationRef.current
    let active = true
    const timer = window.setTimeout(() => {
      void onMatrixCheckUsernameAvailable(serviceIdentity, availabilityUsername).then((available) => {
        if (active && generation === availabilityGenerationRef.current) {
          setAvailabilityCheck({
            serviceIdentity,
            username: availabilityUsername,
            status: available ? 'available' : 'taken',
          })
        }
      }).catch((cause) => {
        if (active && generation === availabilityGenerationRef.current) {
          setAvailabilityCheck({ serviceIdentity, username: availabilityUsername, status: 'error' })
          setError(friendlyAccountCreationError(cause), cause)
        }
      })
    }, 300)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [availabilityUsername, onMatrixCheckUsernameAvailable, selectedServiceIdentity, setError])

  useEffect(() => {
    if (previousModeRef.current === mode) return
    previousModeRef.current = mode
    modeHeadingFrameRef.current = window.requestAnimationFrame(() => {
      modeHeadingFrameRef.current = null
      modeHeadingRef.current?.focus()
    })
    return () => {
      if (modeHeadingFrameRef.current !== null) {
        window.cancelAnimationFrame(modeHeadingFrameRef.current)
        modeHeadingFrameRef.current = null
      }
    }
  }, [mode])

  const resetFeedback = () => {
    browserGenerationRef.current += 1
    setError(null)
    setCheckingBrowser(false)
    setBrowserReady(false)
    setRecoveryHelp(null)
    setSavedSignInNotice(null)
  }

  const changeMode = (nextMode: AccountMode) => {
    if (nextMode === 'welcome' || nextMode === 'select' || nextMode === 'advanced') {
      setSelectedService(null)
      setCapabilities(null)
      setAvailabilityCheck(null)
      capabilityGenerationRef.current += 1
      availabilityGenerationRef.current += 1
    }
    setMode(nextMode)
    setPassword('')
    setPasswordConfirmation('')
    setShowPassword(false)
    resetFeedback()
  }

  const beginExternalRegistration = (service: PublicService): boolean => {
    setError(null)
    setContinuationNotice(null)
    try {
      const continuation = createRegistrationContinuation({
        invitationTarget: storedPendingInvitation?.handle ?? null,
        accountServiceId: service.id,
        accountServiceAddress: service.serviceAddress,
      })
      setSelectedService({ kind: 'public', service })
      setRegistrationContinuation(continuation)
      setMode('registration-return')
      if (pendingInvitationHandle) {
        recordInvitationMilestone(pendingInvitationHandle, 'service-selected')
        recordInvitationMilestone(pendingInvitationHandle, 'account-handoff-started')
      }
      setPassword('')
      setPasswordConfirmation('')
      setCapabilities(null)
      return true
    } catch {
      setContinuationNotice(
        'Mesh could not save a return point on this device. Free some storage, or sign in instead.',
      )
      return false
    }
  }

  const handleContinueAfterExternalRegistration = () => {
    if (!registrationContinuation || selectedService?.kind !== 'public') {
      clearRegistrationContinuation()
      setRegistrationContinuation(null)
      setSelectedService(null)
      setMode('select')
      setContinuationNotice(
        'That sign-up return was incomplete. Choose your service again.',
      )
      return
    }
    if (
      registrationContinuation.invitationTarget
      && !storedPendingInvitation
    ) {
      setContinuationNotice(
        'Mesh cannot find your saved invitation yet. Try again in a moment.',
      )
      return
    }
    if (
      registrationContinuation.invitationTarget
      && storedPendingInvitation
      && (
        storedPendingInvitation.handle !== registrationContinuation.invitationTarget
        || storedPendingInvitation.expiresAt <= currentEpochMsForUserAction()
      )
    ) {
      clearRegistrationContinuation()
      setRegistrationContinuation(null)
      setSelectedService(null)
      setMode('select')
      setContinuationNotice(
        'The saved invitation is missing or expired. Open it again.',
      )
      return
    }

    const inspected = inspectRegistrationContinuation()
    if (
      inspected.status !== 'ready'
      || inspected.continuation.correlation !== registrationContinuation.correlation
    ) {
      setRegistrationContinuation(null)
      setSelectedService(null)
      setMode('select')
      setContinuationNotice(registrationContinuationProblem(
        inspected.status === 'ready' ? 'mismatch' : inspected.status,
      ))
      return
    }

    setContinuationNotice(null)
    setMode('sign-in')
    resetFeedback()
  }

  const completeRegistrationContinuation = (): boolean => {
    if (!registrationContinuation) return true

    const consumed = consumeRegistrationContinuation(
      registrationContinuation.correlation,
    )
    if (consumed.status !== 'consumed') {
      setRegistrationContinuation(null)
      setSelectedService(null)
      setMode('select')
      setContinuationNotice(registrationContinuationProblem(consumed.status))
      return false
    }

    setRegistrationContinuation(null)
    setContinuationNotice(null)
    return true
  }

  const cancelExternalRegistration = () => {
    clearRegistrationContinuation()
    setRegistrationContinuation(null)
    setSelectedService(null)
    setCapabilities(null)
    // Backing out of account creation returns to the question that offered it,
    // not to the sign-in list, which answers a question this person just said
    // no to.
    setMode('welcome')
    setContinuationNotice('Account creation was cancelled.')
    resetFeedback()
  }

  const selectPublicService = (service: PublicService) => {
    capabilityGenerationRef.current += 1
    availabilityGenerationRef.current += 1
    setSelectedService({ kind: 'public', service })
    if (pendingInvitationHandle) {
      recordInvitationMilestone(pendingInvitationHandle, 'service-selected')
    }
    setServiceAddress('')
    setCapabilities(null)
    setAvailabilityCheck(null)
    changeMode('sign-in')
  }

  const selectCommunityService = () => {
    if (!offeredCommunityService || !pendingInvitationHandle) return
    const address = displayServiceAddress(offeredCommunityService)
    capabilityGenerationRef.current += 1
    availabilityGenerationRef.current += 1
    setSelectedService({
      kind: 'community',
      name: storedPendingInvitation?.communityServiceDisplayName?.trim() || address,
      address: offeredCommunityService,
    })
    recordInvitationMilestone(pendingInvitationHandle, 'service-selected')
    setServiceAddress('')
    setCapabilities(null)
    setAvailabilityCheck(null)
    changeMode(communityAccountCreationOffered ? 'create' : 'sign-in')
  }

  const discardPendingInvitation = async () => {
    const dismissedHandle = pendingInvitationHandle
    setError(null)
    try {
      await onDiscardPendingInvitation?.()
      clearRegistrationContinuation()
      setRegistrationContinuation(null)
      setDismissedPendingInvitationHandle(dismissedHandle)
    } catch (cause) {
      setError('Mesh could not discard the saved invitation. Try again.', cause)
    }
  }

  const checkCustomService = async () => {
    if (!resolvedService) {
      setError('Enter your account address or service address.')
      return
    }
    const serviceError = serviceAddressConfigError(resolvedService)
    if (serviceError) {
      setError(serviceError)
      return
    }
    const serviceIdentity = normalizeServiceAddress(resolvedService)
    if (!serviceIdentity) {
      setError('Enter a valid account service address.')
      return
    }
    const generation = ++capabilityGenerationRef.current
    setCheckingCapabilities(true)
    setCapabilities(null)
    setError(null)
    try {
      const nextCapabilities = bridge.isTauriRuntime()
        ? await bridge.matrixServiceCapabilities(serviceIdentity)
        : {
            homeserver: serviceIdentity,
            serverVersions: ['preview'],
            passwordLogin: true,
            browserLogin: true,
            registration: 'unknown' as const,
            maxUploadBytes: null,
          }
      if (generation === capabilityGenerationRef.current) {
        setCapabilities(nextCapabilities)
        if (pendingInvitationHandle) {
          recordInvitationMilestone(pendingInvitationHandle, 'service-selected')
        }
      }
    } catch (cause) {
      if (generation === capabilityGenerationRef.current) {
        setError(friendlyServiceError(cause, 'reach that account service'), cause)
      }
    } finally {
      if (generation === capabilityGenerationRef.current) {
        setCheckingCapabilities(false)
      }
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)

    if (mode === 'create') {
      if (!onMatrixRegisterAccount) {
        setError('Account creation is unavailable in this version of Mesh.')
        return
      }
      if (selectedService?.kind !== 'community' || !resolvedService) {
        setError('Choose an account service with this invitation before creating your account.')
        return
      }
      if (
        createUsernameError
        || availability !== 'available'
        || !strength.strongEnough
        || !passwordsMatch
        || !pendingInvitationHandle
      ) {
        setError('Finish the highlighted fields before creating your account.')
        return
      }

      setSubmitting(true)
      try {
        recordInvitationMilestone(pendingInvitationHandle, 'account-handoff-started')
        await onMatrixRegisterAccount({
          homeserver: resolvedService,
          username: normalizedUsername,
          password,
          pendingInvitationHandle,
          deviceName: 'Mesh Desktop',
        })
        setPassword('')
        setPasswordConfirmation('')
        recordInvitationMilestone(pendingInvitationHandle, 'account-ready')
        onNext('registered')
      } catch (cause) {
        setError(friendlyAccountCreationError(cause), cause)
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (!onMatrixLogin) {
      setError('Sign in is unavailable in this version of Mesh.')
      return
    }
    if (!resolvedService) {
      setError('Enter the address for your account.')
      return
    }
    const serviceError = serviceAddressConfigError(resolvedService)
    if (serviceError) {
      setError(serviceError)
      return
    }

    setSubmitting(true)
    try {
      if (pendingInvitationHandle) {
        recordInvitationMilestone(pendingInvitationHandle, 'account-handoff-started')
      }
      await onMatrixLogin({
        homeserver: resolvedService,
        username: username.trim().startsWith('@') ? username.trim() : normalizedUsername,
        password,
        deviceName: 'Mesh Desktop',
      })
      if (!completeRegistrationContinuation()) return
      setPassword('')
      if (pendingInvitationHandle) {
        recordInvitationMilestone(pendingInvitationHandle, 'account-ready')
      }
      onNext('signed-in')
    } catch (cause) {
      setError(friendlySignInError(cause), cause)
    } finally {
      setSubmitting(false)
    }
  }

  const switchAccount = async (profileId: string) => {
    if (!onMatrixSwitchAccount) return
    setSwitchingProfile(profileId)
    setError(null)
    setSavedSignInNotice(null)
    try {
      if (pendingInvitationHandle) {
        recordInvitationMilestone(pendingInvitationHandle, 'account-handoff-started')
      }
      await onMatrixSwitchAccount(profileId)
      /*
        Dynamic for the same reason as the App-level sign-out handler: this
        screen is in the startup graph, and account-transition's nineteen store
        imports have no business being there for a switch that has not happened.

        This one sits inside the existing try, so a chunk that fails to load is
        reported rather than swallowed. It lands in the generic branch below
        rather than the not_authenticated one, which is the right half: the
        switch itself already succeeded, and what failed is local cleanup.
      */
      const { clearRendererAccountState } = await import('../../lib/account-transition')
      clearRendererAccountState()
      if (pendingInvitationHandle) {
        recordInvitationMilestone(pendingInvitationHandle, 'account-ready')
      }
      onNext('signed-in')
    } catch (cause) {
      const account = savedAccounts.find((candidate) => candidate.profileId === profileId)
      if (account && normalizeError(cause).code === 'not_authenticated') {
        capabilityGenerationRef.current += 1
        availabilityGenerationRef.current += 1
        setSelectedService({
          kind: 'configured',
          name: displayServiceAddress(account.homeserver),
          address: account.homeserver,
        })
        setUsername(account.userId)
        setPassword('')
        setPasswordConfirmation('')
        setShowPassword(false)
        setServiceAddress('')
        setCapabilities(null)
        setAvailabilityCheck(null)
        setMode('sign-in')
        resetFeedback()
        setSavedSignInNotice('Your saved sign-in expired. Sign in again to continue.')
        return
      }
      setError(friendlySignInError(cause), cause)
    } finally {
      setSwitchingProfile(null)
    }
  }

  const checkBrowserSignIn = async () => {
    if (!resolvedService) return
    const serviceError = serviceAddressConfigError(resolvedService)
    if (serviceError) {
      setError(serviceError)
      return
    }
    const serviceIdentity = normalizeServiceAddress(resolvedService)
    if (!serviceIdentity) {
      setError('Enter a valid account service address.')
      return
    }
    const generation = ++browserGenerationRef.current
    setCheckingBrowser(true)
    setBrowserReady(false)
    setError(null)
    try {
      const status = await bridge.matrixOidcStatus(serviceIdentity)
      if (generation !== browserGenerationRef.current) return
      setBrowserReady(status.ready)
      if (!status.ready) setError('Browser sign-in is not available for this account.')
    } catch (cause) {
      if (generation !== browserGenerationRef.current) return
      setError(friendlyServiceError(cause, 'prepare browser sign-in'), cause)
    } finally {
      if (generation === browserGenerationRef.current) setCheckingBrowser(false)
    }
  }

  const startBrowserSignIn = async () => {
    if (!resolvedService || !browserReady || !onMatrixOidcLogin) return
    setBrowserSigningIn(true)
    setError(null)
    try {
      if (pendingInvitationHandle) {
        recordInvitationMilestone(pendingInvitationHandle, 'account-handoff-started')
      }
      await onMatrixOidcLogin(resolvedService)
      if (!completeRegistrationContinuation()) return
      if (pendingInvitationHandle) {
        recordInvitationMilestone(pendingInvitationHandle, 'account-ready')
      }
      onNext('signed-in')
    } catch (cause) {
      setError(friendlySignInError(cause), cause)
    } finally {
      setBrowserSigningIn(false)
    }
  }

  const isCreate = mode === 'create'
  const isAdvanced = mode === 'advanced'

  /*
    Both regions are built once here and rendered by every mode below.

    They used to live inside the sign-in form only, which meant the two paths
    that never reach the form failed in total silence. Choosing a saved account
    calls setError on failure while mode is still 'select', so a returning user
    whose sign-in failed saw the row label flip back from "Opening..." to
    "Continue" and nothing else. Starting external registration from the
    account-services list sets continuationNotice, which that mode did not render
    either, so no browser opened and no message appeared.

    These are JSX values rather than a nested component on purpose: a component
    declared during render is a new type on every render, so React would remount
    it and errorSummaryRef would lose the focus the effect above just moved.
  */
  const errorSummary = error ? (
    <div
      ref={errorSummaryRef}
      role="alert"
      tabIndex={-1}
      className="rounded-full border border-error-container-line bg-error-container px-3 py-2 text-body-md text-on-error-container"
    >
      <p>{error}</p>
      {signalCheckEnabled && errorDetails ? (
        <details className="mt-2 text-body-sm text-on-surface-variant">
          <summary className="cursor-pointer underline-offset-2 hover:underline">
            Service details
          </summary>
          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-full bg-surface-container-lowest p-2 text-body-sm text-on-surface-variant">
            {errorDetails}
          </pre>
        </details>
      ) : null}
    </div>
  ) : null

  const noticeRegion = continuationNotice ? (
    <div
      role="alert"
      className="rounded-full border border-marker-container-line bg-marker-container px-3 py-2 text-body-sm text-on-marker-container"
    >
      {continuationNotice}
    </div>
  ) : null
  const selectedPublicService = selectedService?.kind === 'public'
    ? selectedService.service
    : null
  const selectedServiceName = displayAccountService(selectedService)
  const accountHelpUrl = selectedPublicService?.accountHelpUrl
    ?? selectedPublicService?.supportUrl
    ?? null
  const accountHelpLabel = selectedPublicService
    ? `${selectedPublicService.displayName} account help`
    : 'your account service support'
  const communityServiceName = storedPendingInvitation?.communityServiceDisplayName?.trim()
    || displayServiceAddress(offeredCommunityService ?? '')
  const prominentServiceExpired = publicServiceReviewExpired(MATRIX_ORG_SERVICE)
  const prominentServiceUnavailable = publicServiceUnavailable(MATRIX_ORG_SERVICE)
  const usernameHint = isCreate && !normalizedUsername ? '3–32 lowercase characters.' : undefined
  const accountIdService = !isCreate ? serviceFromUsername(username) : null
  const selectedAccountDomain = selectedService?.kind === 'public'
    ? selectedService.service.accountDomain
    : null
  const accountIdBelongsElsewhere = Boolean(
    accountIdService
    && selectedAccountDomain
    && accountIdService.toLowerCase() !== selectedAccountDomain.toLowerCase(),
  )
  const createDisabled =
    submitting
    || availability !== 'available'
    || Boolean(createUsernameError)
    || !strength.strongEnough
    || !passwordsMatch
    || !pendingInvitationHandle
  const signInDisabled =
    submitting
    || switchingProfile !== null
    || !resolvedService
    || !username.trim()
    || !password
    || capabilities?.passwordLogin === false
    || (isAdvanced && !capabilities)

  if (
    mode === 'registration-return'
    && registrationContinuation
    && selectedPublicService
  ) {
    return (
      <section
        aria-labelledby="registration-return-title"
        className="space-y-5"
      >
        <header className="space-y-2">
          <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">
            Continue account setup
          </p>
          <h1
            id="registration-return-title"
            ref={modeHeadingRef}
            tabIndex={-1}
            className="text-headline-md font-semibold text-on-surface"
          >
            Finish with {onboardingPublicServiceName(selectedPublicService)}
          </h1>
          <p className="max-w-md text-body-md text-on-surface-variant">
            Finish creating the account in your browser, then sign in below.
          </p>
        </header>

        <p className="text-body-sm text-on-surface-variant">
          Mesh saved your place for two hours.
        </p>

        <Button
          type="button"
          className="w-full"
          onClick={handleContinueAfterExternalRegistration}
        >
          Continue to sign in
        </Button>

        {noticeRegion}
        {errorSummary}

        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-body-sm">
          <ExternalLink href={selectedPublicService.registration.url}>
            Open the sign-up page again
          </ExternalLink>
          <button
            type="button"
            className="min-h-8 rounded-full px-2 text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            onClick={cancelExternalRegistration}
          >
            Cancel
          </button>
        </div>
      </section>
    )
  }

  if (mode === 'welcome') {
    /*
      Mesh cannot create an account itself on any service it offers: all three
      entries in the public catalogue are registration kind "external", and the
      in-app path only answers the dummy and registration-token stages, not the
      captcha and email stages those services require. So account creation is a
      browser handoff, and the honest design makes the handoff the deliberate
      primary action with a return path rather than a link inside a sentence
      under a button reading "Sign in".

      A community that offers account creation is the exception: that service
      is reached through the in-app form, so the same button stays in Mesh.
    */
    const invitationCreate = communityAccountCreationOffered && offeredCommunityService
    const externalCreate = !invitationCreate
      && !prominentServiceUnavailable
      && !prominentServiceExpired
    return (
      <section className="mesh-account-welcome space-y-6" aria-labelledby="account-welcome-title">
        <header className="space-y-2">
          <h1
            id="account-welcome-title"
            ref={modeHeadingRef}
            tabIndex={-1}
            className="text-headline-md font-semibold text-on-surface"
          >
            Welcome to Mesh
          </h1>
        </header>

        {storedPendingInvitation && !hideInvitationSummary ? (
          <CommunityInvitationPassport
            pending={storedPendingInvitation}
            onDiscard={() => void discardPendingInvitation()}
          />
        ) : null}

        {savedAccounts.length > 0 ? (
          <SavedAccounts
            accounts={savedAccounts}
            switchingProfile={switchingProfile}
            disabled={submitting}
            onSelect={(profileId) => void switchAccount(profileId)}
          />
        ) : null}

        {noticeRegion}
        {errorSummary}

        {/*
          Two actions, one obviously first. Both are full width and the same
          height so neither is fiddly to hit; the accent fill alone carries the
          ranking. An outline second action tested as barely visible against
          this background, which turned "I already have an account" into
          something a returning person had to hunt for.
        */}
        <div className="space-y-2.5">
          {invitationCreate ? (
            <Button type="button" size="lg" className="w-full" onClick={selectCommunityService}>
              Create an account
            </Button>
          ) : externalCreate ? (
            <ExternalActionButton
              href={MATRIX_ORG_SERVICE.registration.url}
              onBeforeOpen={() => beginExternalRegistration(MATRIX_ORG_SERVICE)}
            >
              Create an account
            </ExternalActionButton>
          ) : null}
          <Button
            type="button"
            variant={externalCreate || invitationCreate ? 'secondary' : 'primary'}
            size="lg"
            className="w-full"
            onClick={() => {
              setServiceListIntent('sign-in')
              changeMode('select')
            }}
          >
            I already have an account
          </Button>
        </div>

        <p className="text-body-sm text-on-surface-variant">
          {invitationCreate
            ? `${communityServiceName} keeps your account and runs independently from Mesh.`
            : externalCreate
              ? `Creating an account opens ${MATRIX_ORG_SERVICE.displayName} in your browser, which runs independently from Mesh and asks that you be ${MATRIX_ORG_SERVICE.minimumAge} or over.`
              : 'New accounts are paused until Mesh reviews a service again.'}
          {' '}
          <button
            type="button"
            className="underline underline-offset-2 transition-colors hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            onClick={() => {
              setServiceListIntent('create')
              changeMode('select')
            }}
          >
            Use a different service
          </button>
        </p>
      </section>
    )
  }

  if (mode === 'select') {
    const creatingHere = serviceListIntent === 'create'
    return (
      <div className="mesh-account-service-choices space-y-4">
        <header className="mesh-account-service-header space-y-2">
          <h1
            ref={modeHeadingRef}
            tabIndex={-1}
            className="text-headline-md font-semibold text-on-surface"
          >
            {creatingHere ? 'Choose a service' : 'Sign in'}
          </h1>
          {creatingHere ? (
            <p className="max-w-md text-body-md text-on-surface-variant">
              Each service runs independently from Mesh and creates your account on its own page.
            </p>
          ) : null}
        </header>

        {storedPendingInvitation && !hideInvitationSummary ? (
          <CommunityInvitationPassport
            pending={storedPendingInvitation}
            onDiscard={() => void discardPendingInvitation()}
          />
        ) : null}

        {savedAccounts.length > 0 ? (
          <SavedAccounts
            accounts={savedAccounts}
            switchingProfile={switchingProfile}
            disabled={submitting}
            onSelect={(profileId) => void switchAccount(profileId)}
          />
        ) : null}

        {noticeRegion}
        {errorSummary}

        {/*
          One list, not two. This screen and a second "More account services"
          screen used to hold the same rows behind a pair of buttons reading
          "More account services" and "Use another service", which named the
          same idea twice and told nobody which one they wanted. Every reviewed
          service is here, most-used first, and the address field below covers
          the rest.

          These are rows rather than cards because the question is only which
          of these keeps your account. Upload limits and jurisdiction decided
          nothing at this point and read as an eye test, so they moved to the
          service's own page behind Terms, which is where somebody comparing
          services is actually going to look.
        */}
        <ul className="mesh-account-service-list divide-y divide-outline-variant border-y border-outline-variant">
          {offeredCommunityService && pendingInvitationHandle ? (
            <ServiceRow
              key="community-service"
              title={communityServiceName}
              detail={`Suggested by your invitation. ${displayServiceAddress(offeredCommunityService)}`}
              /*
                The one service that can register inside Mesh, when its
                invitation offers that. The row says so, because "Sign in with"
                on a service that is about to ask you to pick a username is the
                same mislabelling this screen was built to remove.
              */
              action={communityAccountCreationOffered ? 'create' : 'sign-in'}
              onSelect={selectCommunityService}
            />
          ) : null}
          {PUBLIC_SERVICES.map((service) => {
            const withdrawn = publicServiceUnavailable(service)
              || publicServiceReviewExpired(service)
            return (
              <ServiceRow
                key={service.id}
                title={service.displayName}
                detail={publicServiceUnavailable(service)
                  ? 'Unavailable until Mesh reviews this service again.'
                  : creatingHere && withdrawn
                    ? 'New accounts are paused until Mesh reviews this service again.'
                    : service.operator.trim().toLowerCase()
                        === service.displayName.trim().toLowerCase()
                      ? sentence(service.jurisdiction)
                      : `Run by ${sentence(service.operator)}`}
                action={creatingHere ? 'create' : 'sign-in'}
                disabled={creatingHere ? withdrawn : publicServiceUnavailable(service)}
                href={creatingHere ? service.registration.url : undefined}
                onBeforeOpen={() => beginExternalRegistration(service)}
                termsUrl={service.termsUrl}
                privacyUrl={service.privacyUrl}
                onSelect={() => selectPublicService(service)}
              />
            )
          })}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={() => changeMode('welcome')}>
            Back
          </Button>
          <Button type="button" variant="ghost" onClick={() => changeMode('advanced')}>
            My service is not listed
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form className="mesh-account-form space-y-3" onSubmit={submit}>
      {/*
        No eyebrow. "WELCOME BACK" in accent capitals above "Sign in to
        Matrix.org" said nothing the heading did not, and it was the last of
        four accent-coloured labels competing on a screen whose only real
        accent belongs on the button you are meant to press.
      */}
      <header className="space-y-2">
        <h1 ref={modeHeadingRef} tabIndex={-1} className="text-headline-md font-semibold text-on-surface">
          {isCreate
            ? `Create your account with ${selectedServiceName}`
            : isAdvanced
              ? 'Add your service'
              : `Sign in to ${selectedServiceName}`}
        </h1>
      </header>

      {savedSignInNotice ? (
        <p
          role="status"
          className="rounded-full border border-marker-container-line bg-marker-container px-3 py-2 text-body-md text-on-marker-container"
        >
          {savedSignInNotice}
        </p>
      ) : null}

      {selectedService?.kind === 'community' ? (
        <section
          aria-label={`${selectedService.name} service details`}
          className="mesh-inline-card border border-outline-variant p-3 text-body-sm text-on-surface-variant"
        >
          <p>
            Your account is stored at {displayServiceAddress(selectedService.address)}, which runs
            separately from the community and from Mesh.
          </p>
        </section>
      ) : null}

      {!selectedPublicService ? (
        checkingCapabilities ? (
          <p role="status" className="text-body-sm text-on-surface-variant">Checking this service…</p>
        ) : capabilities ? (
          <p role="status" className="text-body-sm text-on-surface-variant">
            {capabilitySummary(capabilities)}
          </p>
        ) : null
      ) : null}

      {!isCreate && savedAccounts.length > 0 ? (
        <section
          aria-label="Saved accounts"
          className="space-y-2 rounded-xl border border-outline-variant bg-surface-container-lowest p-3"
        >
          <p className="text-label-sm lowercase tracking-label-md text-on-surface-variant">Continue without a password</p>
          {savedAccounts.map((account) => (
            <button
              key={account.profileId}
              type="button"
              disabled={submitting || switchingProfile !== null}
              className="flex w-full items-center justify-between gap-3 rounded-full bg-surface px-3 py-2 text-left transition-colors hover:bg-state-hover disabled:cursor-wait disabled:opacity-60"
              onClick={() => void switchAccount(account.profileId)}
            >
              <span className="min-w-0">
                <span className="block truncate text-body-md font-medium text-on-surface">
                  {friendlyAccountName(account.userId)}
                </span>
                <span className="block truncate text-body-sm text-on-surface-variant">Saved on this device</span>
              </span>
              <span className="text-body-sm font-medium text-primary">
                {switchingProfile === account.profileId ? 'Opening…' : 'Continue'}
              </span>
            </button>
          ))}
        </section>
      ) : null}

      <div className={isCreate ? 'space-y-2 pt-1' : 'space-y-3 pt-1'}>
        <Input
          label={isCreate ? 'Username' : 'Username or account address'}
          name="username"
          value={username}
          onChange={(value: string) => {
            setUsername(value)
            if (isAdvanced) {
              capabilityGenerationRef.current += 1
              setCapabilities(null)
              setCheckingCapabilities(false)
              resetFeedback()
            } else {
              setError(null)
            }
          }}
          placeholder={isCreate ? 'ashvin' : isAdvanced ? '@ashvin:example.org' : 'ashvin'}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
          maxLength={isCreate ? 32 : 255}
          error={createUsernameError ?? undefined}
          hint={usernameHint}
        />
        {!isCreate && accountIdBelongsElsewhere && !isAdvanced ? (
          <p className="rounded-full border border-marker-container-line bg-marker-container px-3 py-2 text-body-sm text-on-marker-container">
            This account belongs to <span className="font-medium text-on-surface">{accountIdService}</span>.
            Go back and choose{' '}
            <span className="font-medium text-on-surface">My service is not listed</span>.
          </p>
        ) : null}
        {isCreate && normalizedUsername && !createUsernameError && availability !== 'idle' ? (
          <p
            role="status"
            className={`text-body-sm ${
              availability === 'available'
                ? 'text-primary'
                : availability === 'taken' || availability === 'error'
                  ? 'text-error'
                  : 'text-on-surface-variant'
            }`}
          >
            {availabilityMessage(availability, normalizedUsername)}
          </p>
        ) : null}

        <div className="space-y-2">
          <Input
            label="Password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(value: string) => {
              setPassword(value)
              setError(null)
            }}
            autoComplete={isCreate ? 'new-password' : 'current-password'}
            required
            maxLength={128}
            hint={isCreate ? 'At least 10 characters.' : undefined}
          />

          {isCreate ? (
            <div
              role="meter"
              aria-label="Password strength"
              aria-valuemin={0}
              aria-valuemax={4}
              aria-valuenow={strength.score}
              aria-valuetext={strength.label}
              className="space-y-1.5"
            >
              <div className="grid grid-cols-4 gap-1" aria-hidden="true">
                {[1, 2, 3, 4].map((score) => (
                  <span
                    key={score}
                    className={`h-1 rounded-xl ${
                      score <= strength.score
                        ? strength.strongEnough
                          ? 'bg-primary'
                          : 'bg-marker'
                        : 'bg-surface-container-highest'
                    }`}
                  />
                ))}
              </div>
              <p className={`text-body-sm ${strength.strongEnough ? 'text-primary' : 'text-on-surface-variant'}`}>
                {password ? `${strength.label} password` : 'Password strength'}
              </p>
            </div>
          ) : null}

          {isCreate ? (
            <Input
              label="Confirm password"
              name="password-confirmation"
              type={showPassword ? 'text' : 'password'}
              value={passwordConfirmation}
              onChange={(value: string) => {
                setPasswordConfirmation(value)
                setError(null)
              }}
              autoComplete="new-password"
              required
              maxLength={128}
              error={
                passwordConfirmation && !passwordsMatch
                  ? 'Passwords do not match.'
                  : undefined
              }
            />
          ) : null}

          <label className="inline-flex cursor-pointer items-center gap-2 text-body-sm text-on-surface-variant">
            <input
              type="checkbox"
              checked={showPassword}
              onChange={(event) => setShowPassword(event.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Show password
          </label>
        </div>

        {isCreate && storedPendingInvitation && !hideInvitationSummary ? (
          <CommunityInvitationPassport
            pending={storedPendingInvitation}
            onDiscard={() => void discardPendingInvitation()}
            compact
          />
        ) : null}

        {isAdvanced ? (
          <div className="space-y-3 border-t border-outline pt-4">
            <Input
              label="Service address"
              name="homeserver"
              value={serviceAddress}
              onChange={(value: string) => {
                capabilityGenerationRef.current += 1
                setServiceAddress(value)
                setCapabilities(null)
                setCheckingCapabilities(false)
                resetFeedback()
              }}
              placeholder="example.com"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={2048}
              hint="Optional when you entered an account address above."
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={checkingCapabilities || !resolvedService}
              onClick={() => void checkCustomService()}
            >
              {checkingCapabilities ? 'Checking…' : capabilities ? 'Check again' : 'Check service'}
            </Button>
          </div>
        ) : null}
      </div>

      {!isCreate && capabilities && !capabilities.passwordLogin && !capabilities.browserLogin ? (
        <p role="alert" className="rounded-full border border-error-container-line bg-error-container px-3 py-2 text-body-md text-on-error-container">
          This service does not offer a sign-in method that Mesh can use.
        </p>
      ) : null}

      {noticeRegion}
      {errorSummary}

      <Button
        type="submit"
        disabled={isCreate ? createDisabled : signInDisabled}
        className="w-full"
      >
        {submitting
          ? isCreate ? 'Creating your account…' : 'Signing you in…'
          : isCreate ? 'Create account' : 'Sign in'}
      </Button>

      {!isCreate ? (
        <section
          aria-label="Sign-in help"
          className="space-y-2 border-t border-outline-variant pt-3"
        >
          <p className="text-body-sm font-medium text-on-surface">Having trouble signing in?</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-body-sm">
            <button
              type="button"
              className="min-h-8 rounded-full px-1 text-on-surface-variant underline-offset-2 transition-colors hover:text-on-surface hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              aria-expanded={recoveryHelp === 'password'}
              onClick={() => setRecoveryHelp((current) => current === 'password' ? null : 'password')}
            >
              Forgot password?
            </button>
            <button
              type="button"
              className="min-h-8 rounded-full px-1 text-on-surface-variant underline-offset-2 transition-colors hover:text-on-surface hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              aria-expanded={recoveryHelp === 'username'}
              onClick={() => setRecoveryHelp((current) => current === 'username' ? null : 'username')}
            >
              Forgot username?
            </button>
          </div>
          {recoveryHelp ? (
            <div role="status" className="space-y-2 border-t border-outline pt-2 text-body-sm text-on-surface-variant">
              {recoveryHelp === 'password' ? (
                <>
                  <p>
                    Password recovery is handled by {selectedServiceName}, not by Mesh.
                  </p>
                  {accountHelpUrl ? (
                    <ExternalLink href={accountHelpUrl}>Open {accountHelpLabel}</ExternalLink>
                  ) : (
                    <p>
                      Ask whoever runs {displayServiceAddress(selectedServiceAddress)} for a
                      password reset.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p>
                    Check the email or password manager you used when you created the account.
                  </p>
                  {savedAccounts.length > 0 ? (
                    <p>Or choose a saved account above.</p>
                  ) : null}
                  {accountHelpUrl ? (
                    <ExternalLink href={accountHelpUrl}>Open {accountHelpLabel}</ExternalLink>
                  ) : (
                    <p>
                      Ask whoever runs {displayServiceAddress(selectedServiceAddress)} to help
                      recover your account address.
                    </p>
                  )}
                </>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      {!isCreate && capabilities?.browserLogin ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {!browserReady ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={checkingBrowser || !resolvedService || !bridge.isTauriRuntime()}
                aria-describedby={!bridge.isTauriRuntime() ? 'browser-sign-in-availability' : undefined}
                onClick={() => void checkBrowserSignIn()}
              >
                {checkingBrowser ? 'Checking…' : 'Use browser sign-in'}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={browserSigningIn || !onMatrixOidcLogin}
                onClick={() => void startBrowserSignIn()}
              >
                {browserSigningIn ? 'Waiting for browser…' : 'Continue in browser'}
              </Button>
            )}
            {browserSigningIn ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void bridge.matrixCancelLogin()}
              >
                Cancel
              </Button>
            ) : null}
          </div>
          {!bridge.isTauriRuntime() ? (
            <p
              id="browser-sign-in-availability"
              role="status"
              className="text-body-sm text-on-surface-variant"
            >
              Browser sign-in opens from the installed Mesh app.
            </p>
          ) : null}
        </div>
      ) : null}

      {selectedPublicService ? (
        checkingCapabilities ? (
          <p role="status" className="text-body-sm text-on-surface-variant">Checking this service…</p>
        ) : capabilities ? (
          <p role="status" className="text-body-sm text-on-surface-variant">
            {capabilitySummary(capabilities)}
          </p>
        ) : null
      ) : null}

      {/*
        Who runs the service and where its policies are, as one muted line. It
        used to be a bordered card carrying the operator, the free-use limits,
        Terms, Privacy and a "Create an account in your browser" link, sitting
        directly above a footer that offered account creation a second time.
        The limits belong to choosing a service, which has already happened by
        the time this form is on screen.
      */}
      {selectedPublicService ? (
        <p
          aria-label={`${onboardingPublicServiceName(selectedPublicService)} details`}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-label-sm text-on-surface-variant"
        >
          <span>Run independently by {sentence(selectedPublicService.operator)}</span>
          <PolicyLink href={selectedPublicService.termsUrl}>Terms</PolicyLink>
          <PolicyLink href={selectedPublicService.privacyUrl}>Privacy</PolicyLink>
        </p>
      ) : null}

      {isCreate ? (
        <p className="text-center text-body-md text-on-surface-variant">
          Already have an account with this service?{' '}
          <button
            type="button"
            className="inline-flex min-h-8 items-center rounded-full px-1 text-primary transition-colors hover:bg-state-hover hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            onClick={() => changeMode('sign-in')}
          >
            Sign in
          </button>
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-outline-variant pt-2 text-body-sm">
          <button
            type="button"
            className="inline-flex min-h-8 items-center rounded-full px-2 text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            onClick={() => changeMode('select')}
          >
            Back
          </button>
          {selectedPublicService ? (
            <span className="text-on-surface-variant">
              Need an account?{' '}
              <ExternalLink
                href={selectedPublicService.registration.url}
                onBeforeOpen={() => beginExternalRegistration(selectedPublicService)}
              >
                Create an account in your browser
              </ExternalLink>
            </span>
          ) : null}
        </div>
      )}

    </form>
  )
}

function CommunityInvitationPassport({
  pending,
  onDiscard,
  compact = false,
}: {
  pending: PendingInvitationMetadata | null | undefined
  onDiscard?: () => void
  compact?: boolean
}) {
  const communityName = invitationLabel(pending?.communityName)
  const inviter = invitationLabel(pending?.inviterDisplayName)
  const communityService = invitationLabel(pending?.communityServiceDisplayName)
  const serviceAddress = invitationLabel(
    pending?.service ? displayServiceAddress(pending.service) : null,
  )
  const joinRule = plainJoinRule(pending?.joinRule)
  const title = communityName ?? 'Community invitation'

  return (
    <section
      aria-label="Community invitation"
      className={`space-y-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-3 text-body-sm text-on-surface-variant ${compact ? '' : 'sm:p-4'}`}
    >
      <div className="flex items-start gap-3">
        <Avatar
          color="var(--accent)"
          size={40}
          name={communityName ?? 'Community invitation'}
          variant="community"
          className="flex-none"
        />
        <div className="min-w-0 space-y-0.5">
          <p className="text-label-sm lowercase tracking-label-md text-on-surface-variant">Community invitation</p>
          <h2 className="truncate text-body-md font-semibold text-on-surface">{title}</h2>
          {inviter ? <p>Invited by {inviter}.</p> : null}
        </div>
      </div>

      {communityService || joinRule ? (
        <dl className="grid gap-x-4 gap-y-2 border-t border-outline-variant pt-3 sm:grid-cols-2">
          {communityService ? (
            <div>
              <dt className="text-label-sm lowercase tracking-label-md text-on-surface-variant">Community service</dt>
              <dd className="truncate text-on-surface">{communityService}</dd>
            </div>
          ) : null}
          {joinRule ? (
            <div>
              <dt className="text-label-sm lowercase tracking-label-md text-on-surface-variant">Access</dt>
              <dd className="text-on-surface">{joinRule}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {serviceAddress ? (
        <details className="rounded-full border border-outline-variant bg-surface px-3">
          <summary className="flex min-h-10 cursor-pointer items-center font-semibold text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
            Service details
          </summary>
          <dl className="space-y-2 border-t border-outline-variant py-3">
            {serviceAddress ? (
              <div>
                <dt className="text-label-sm lowercase tracking-label-md text-on-surface-variant">Service address</dt>
                <dd className="break-all text-on-surface">{serviceAddress}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}

      {/*
        One line for both placements. The compact and full variants said the
        same thing twice over: saved here, used later, service separate from
        community. Only the first half of that changes what anybody does.
      */}
      <p>Mesh uses this saved invitation after you sign in.</p>

      {onDiscard ? (
        <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
          Discard invitation
        </Button>
      ) : null}
    </section>
  )
}

function SavedAccounts({
  accounts,
  switchingProfile,
  disabled,
  onSelect,
}: {
  accounts: bridge.MatrixAccount[]
  switchingProfile: string | null
  disabled: boolean
  onSelect: (profileId: string) => void
}) {
  return (
    <section
      aria-label="Saved accounts"
      className="space-y-2 rounded-xl border border-outline-variant bg-surface-container-lowest p-3"
    >
      <p className="text-label-sm lowercase tracking-label-md text-on-surface-variant">Continue without a password</p>
      {accounts.map((account) => (
        <button
          key={account.profileId}
          type="button"
          disabled={disabled || switchingProfile !== null}
          className="flex w-full items-center justify-between gap-3 rounded-full bg-surface px-3 py-2 text-left transition-colors hover:bg-state-hover disabled:cursor-wait disabled:opacity-60"
          onClick={() => onSelect(account.profileId)}
        >
          <span className="min-w-0">
            <span className="block truncate text-body-md font-medium text-on-surface">
              {friendlyAccountName(account.userId)}
            </span>
            <span className="block truncate text-body-sm text-on-surface-variant">Saved on this device</span>
          </span>
          <span className="text-body-sm font-medium text-primary">
            {switchingProfile === account.profileId ? 'Opening…' : 'Continue'}
          </span>
        </button>
      ))}
    </section>
  )
}

/*
  A row, not a card. The card this replaces nested four borders deep on the
  first screen anyone sees: panel, then card, then an age notice, then a
  "Policies and independence" disclosure. Each border was defensible on its own
  and together they read as a form to be completed rather than a choice to be
  made.

  Terms and Privacy stay, because linking them is not decoration, but they sit
  as plain links at the end of the row instead of behind a disclosure that hid
  them one click deep.
*/
/*
  Operator names in the catalogue carry their own legal suffix, and half of
  them already end in a period. Appending one produced "C.I.C..", so the
  sentence is closed only when it is not closed already.
*/
function sentence(text: string): string {
  return /[.!?]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`
}

function ServiceRow({
  title,
  detail,
  onSelect,
  action = 'sign-in',
  href,
  onBeforeOpen,
  disabled = false,
  termsUrl,
  privacyUrl,
}: {
  title: string
  detail: string
  onSelect: () => void
  action?: 'sign-in' | 'create'
  href?: string
  onBeforeOpen?: () => boolean
  disabled?: boolean
  termsUrl?: string
  privacyUrl?: string
}) {
  const label = `${action === 'create' ? 'Create account with' : 'Sign in with'} ${title}`
  const rowClass = 'group flex w-full items-center gap-3 px-1 py-3 text-left transition-colors hover:bg-state-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus'
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-md font-medium text-on-surface">{title}</span>
        <span className="block truncate text-body-sm text-on-surface-variant">{detail}</span>
      </span>
      <Icon
        name="arrowRight"
        size="sm"
        className="flex-none text-on-surface-variant transition-transform duration-fast motion-safe:group-hover:translate-x-0.5"
      />
    </>
  )
  return (
    <li className="mesh-service-row">
      {action === 'create' && href && !disabled ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={label}
          onClick={(event) => {
            if (onBeforeOpen && !onBeforeOpen()) event.preventDefault()
          }}
          className={rowClass}
        >
          {body}
        </a>
      ) : (
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          onClick={onSelect}
          className={`${rowClass} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {body}
        </button>
      )}
      {/*
        Muted rather than accent. Accent-coloured underlined links made Terms
        and Privacy the brightest thing in each row, so the eye landed on the
        legal footnote instead of the name of the service being chosen. They
        are still links, and still reachable; they are simply not the offer.
      */}
      {termsUrl || privacyUrl ? (
        <p className="flex flex-wrap gap-3 px-1 pb-3 text-label-sm">
          {termsUrl ? <PolicyLink href={termsUrl}>Terms</PolicyLink> : null}
          {privacyUrl ? <PolicyLink href={privacyUrl}>Privacy</PolicyLink> : null}
        </p>
      ) : null}
    </li>
  )
}

function PolicyLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-on-surface-variant underline-offset-2 transition-colors hover:text-on-surface hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
    >
      {children}
    </a>
  )
}

/*
  Account creation leaves Mesh, so the control that starts it is an anchor. It
  carries the primary button's weight because on the welcome screen it is the
  primary action, and dressing the real exit up as an ordinary button would
  hide the one thing somebody needs to expect: a browser is about to open.
*/
function ExternalActionButton({
  href,
  onBeforeOpen,
  children,
}: {
  href: string
  onBeforeOpen: () => boolean
  children: ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        if (!onBeforeOpen()) event.preventDefault()
      }}
      className="mesh-button no-select inline-flex h-control-lg w-full items-center justify-center rounded-full border border-primary bg-primary px-4 font-semibold text-on-primary transition-colors duration-fast hover:bg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
    >
      {children}
    </a>
  )
}

function ExternalLink({
  href,
  children,
  onBeforeOpen,
}: {
  href: string
  children: ReactNode
  onBeforeOpen?: () => boolean
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        if (onBeforeOpen && !onBeforeOpen()) event.preventDefault()
      }}
      className="text-primary underline underline-offset-2"
    >
      {children}
    </a>
  )
}

function initializeRegistrationContinuation(): {
  continuation: RegistrationContinuation | null
  service: PublicService | null
  notice: string | null
} {
  const inspected = inspectRegistrationContinuation()
  if (inspected.status === 'ready') {
    const service = PUBLIC_SERVICES.find((candidate) => (
      candidate.id === inspected.continuation.accountServiceId
      && candidate.serviceAddress.toLowerCase()
        === inspected.continuation.accountServiceAddress.toLowerCase()
    ))
    if (service && !publicServiceReviewExpired(service)) {
      return {
        continuation: inspected.continuation,
        service,
        notice: null,
      }
    }
    clearRegistrationContinuation()
    return {
      continuation: null,
      service: null,
      notice: 'That saved account service is no longer available. Choose another.',
    }
  }
  if (inspected.status === 'empty') {
    return { continuation: null, service: null, notice: null }
  }
  return {
    continuation: null,
    service: null,
    notice: registrationContinuationProblem(inspected.status),
  }
}

function registrationContinuationProblem(
  status:
    | 'empty'
    | 'expired'
    | 'malformed'
    | 'replayed'
    | 'unavailable'
    | 'mismatch',
): string {
  if (status === 'expired') {
    return 'The saved sign-up return expired. Choose your service again.'
  }
  if (status === 'replayed' || status === 'mismatch') {
    return 'That sign-up return was already used or replaced. Choose your service again.'
  }
  if (status === 'unavailable') {
    return 'Mesh cannot save a sign-up return on this device right now.'
  }
  if (status === 'empty') {
    return 'No saved sign-up return was found. Choose your service again.'
  }
  return 'The saved sign-up return could not be used. Choose your service again.'
}

function displayAccountService(service: SelectedAccountService | null): string {
  if (!service) return 'your service'
  if (service.kind === 'public') return onboardingPublicServiceName(service.service)
  return service.name
}

function onboardingPublicServiceName(service: PublicService): string {
  return service.displayName
}

function invitationLabel(value: string | null | undefined): string | null {
  const label = value?.trim().replace(/\s+/g, ' ')
  return label ? label.slice(0, 255) : null
}

function plainJoinRule(joinRule: string | null | undefined): string | null {
  switch (joinRule?.trim().toLowerCase()) {
    case 'public':
      return 'Anyone with the invitation'
    case 'knock':
      return 'Request to join'
    case 'invite':
      return 'Invitation only'
    case 'restricted':
    case 'knock_restricted':
      return 'Community approval'
    default:
      return joinRule ? 'Community rules apply' : null
  }
}

/*
  Read aloud, this line used to be "Account service is available. password and
  browser sign-in available. Maximum upload: 10 MB." Three sentences, one
  starting lower case, the word "available" three times, and a byte figure that
  decides nothing while somebody is typing a password. It says one thing now:
  Mesh reached the service, and here is how you get in.
*/
function capabilitySummary(capabilities: bridge.MatrixServiceCapabilities): string {
  const methods = [
    capabilities.passwordLogin ? 'a password' : null,
    capabilities.browserLogin ? 'your browser' : null,
  ].filter(Boolean)
  const methodSummary = methods.length > 0
    ? `Sign in with ${methods.join(' or ')}.`
    : 'This service offers no sign-in method Mesh supports.'
  const registrationSummary = capabilities.registration === 'invitation-only'
    ? ' New accounts here need an invitation from the service.'
    : capabilities.registration === 'closed'
      ? ' This service is not taking new accounts.'
      : ''
  return `Connected. ${methodSummary}${registrationSummary}`
}


function availabilityMessage(
  availability: Availability,
  username: string,
): string | undefined {
  if (!username) return '3–32 lowercase characters.'
  if (availability === 'checking') return 'Checking availability…'
  if (availability === 'available') return `✓ ${username} is available.`
  if (availability === 'taken') return `${username} is already taken.`
  if (availability === 'error') return 'Could not check availability. Try again.'
  return undefined
}

function friendlyAccountName(userId: string): string {
  const localName = userId.replace(/^@/, '').split(':')[0]?.trim()
  return localName || 'Saved account'
}
