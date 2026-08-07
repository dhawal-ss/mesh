import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Avatar } from '../ui/Avatar'
import * as bridge from '../../lib/bridge'
import {
  MATRIX_ORG_SERVICE,
  PUBLIC_SERVICES,
  publicServiceReviewExpired,
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
import { clearRendererAccountState } from '../../lib/account-transition'
import {
  beginInvitationActivation,
  recordInvitationMilestone,
} from '../../lib/invitation-activation'

type AccountMode =
  | 'select'
  | 'public-services'
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
        : 'select',
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
  const [submitting, setSubmitting] = useState(false)
  const [switchingProfile, setSwitchingProfile] = useState<string | null>(null)
  const [savedAccounts, setSavedAccounts] = useState<bridge.MatrixAccount[]>([])
  const [checkingBrowser, setCheckingBrowser] = useState(false)
  const [browserReady, setBrowserReady] = useState(false)
  const [browserSigningIn, setBrowserSigningIn] = useState(false)
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

  const setError = (message: string | null, cause?: unknown) => {
    setErrorMessage(message)
    setErrorDetails(message && cause !== undefined ? technicalSignInError(cause) : null)
  }

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
      || mode === 'select'
      || mode === 'public-services'
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
  }, [mode, selectedService, selectedServiceAddress, selectedServiceIdentity])

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
  }, [availabilityUsername, onMatrixCheckUsernameAvailable, selectedServiceIdentity])

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
  }

  const changeMode = (nextMode: AccountMode) => {
    if (nextMode === 'select' || nextMode === 'public-services' || nextMode === 'advanced') {
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
        'Mesh could not save a safe return point on this device. Free some storage or choose Sign in if you already have an account.',
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
        'That registration return was incomplete. Choose your account service and try again.',
      )
      return
    }
    if (
      registrationContinuation.invitationTarget
      && !storedPendingInvitation
    ) {
      setContinuationNotice(
        'Mesh could not find the saved community invitation yet. Wait a moment and try again, or open the invitation again.',
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
        'The saved invitation is missing or expired. Open the invitation again, then choose your account service.',
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
    setMode('select')
    setContinuationNotice(
      storedPendingInvitation
        ? 'Account creation was cancelled. Your invitation is still saved on this device.'
        : 'Account creation was cancelled. Choose a service when you are ready.',
    )
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
      setError('Enter your full account ID or service address.')
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
        setError('Account creation is unavailable in this build.')
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
      setError('Sign in is unavailable in this build.')
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
    try {
      if (pendingInvitationHandle) {
        recordInvitationMilestone(pendingInvitationHandle, 'account-handoff-started')
      }
      await onMatrixSwitchAccount(profileId)
      clearRendererAccountState()
      if (pendingInvitationHandle) {
        recordInvitationMilestone(pendingInvitationHandle, 'account-ready')
      }
      onNext('signed-in')
    } catch (cause) {
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
  const selectedPublicService = selectedService?.kind === 'public'
    ? selectedService.service
    : null
  const selectedServiceName = displayAccountService(selectedService)
  const accountHelpUrl = selectedPublicService?.accountHelpUrl
    ?? selectedPublicService?.supportUrl
    ?? null
  const accountHelpLabel = selectedPublicService
    ? selectedPublicService.prominent
      ? 'account service help'
      : `${selectedPublicService.displayName} account help`
    : 'your account service support'
  const communityServiceName = storedPendingInvitation?.communityServiceDisplayName?.trim()
    || displayServiceAddress(offeredCommunityService ?? '')
  const prominentServiceExpired = publicServiceReviewExpired(MATRIX_ORG_SERVICE)
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
          <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">
            Continue account setup
          </p>
          <h1
            id="registration-return-title"
            ref={modeHeadingRef}
            tabIndex={-1}
            className="text-lg font-semibold tracking-tight text-primary"
          >
            Finish with {onboardingPublicServiceName(selectedPublicService)}
          </h1>
          <p className="max-w-md text-sm leading-6 text-secondary">
            This independent service creates the account in its own browser page.
            When you have finished there, return to Mesh and sign in below.
          </p>
        </header>

        <div className="space-y-2 rounded-panel border border-border-subtle bg-surface-sunken p-3 text-xs leading-5 text-secondary">
          <p className="font-medium text-primary">
            Mesh has saved your place for two hours
          </p>
          <p>
            {registrationContinuation.invitationTarget
              ? 'Your community invitation remains protected on this device and is separate from your account service.'
              : 'Your selected account service is saved on this device.'}
          </p>
          <p>
            Mesh has not received or stored your provider credentials, and cannot tell whether
            the provider created the account until you sign in.
          </p>
        </div>

        <Button
          type="button"
          className="w-full"
          onClick={handleContinueAfterExternalRegistration}
        >
          I created my account: sign in
        </Button>

        {continuationNotice ? (
          <div
            role="alert"
            className="rounded-control border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs leading-5 text-secondary"
          >
            {continuationNotice}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
          <ExternalLink href={selectedPublicService.registration.url}>
            Open the registration page again
          </ExternalLink>
          <button
            type="button"
            className="min-h-8 rounded-control px-2 text-muted transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={cancelExternalRegistration}
          >
            Cancel
          </button>
        </div>
      </section>
    )
  }

  if (mode === 'select') {
    return (
      <div className="mesh-account-service-choices space-y-4">
        <header className="mesh-account-service-header space-y-2">
          <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">Account service</p>
          <h1
            ref={modeHeadingRef}
            tabIndex={-1}
            className="text-lg font-semibold tracking-tight text-primary"
          >
            Pick an account service
          </h1>
          <p className="max-w-md text-sm leading-6 text-secondary">
            This service stores your account data. It can be different from the service used by
            the community you are joining.
          </p>
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

        {continuationNotice ? (
          <div
            role="alert"
            className="rounded-control border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs leading-5 text-secondary"
          >
            {continuationNotice}
          </div>
        ) : null}

        {MATRIX_ORG_SERVICE ? (
          <ServiceChoiceCard
            title="Public account service"
            eyebrow={prominentServiceExpired
              ? 'Review expired'
              : 'Recommended public option'}
            description={prominentServiceExpired
              ? 'This option is unavailable until its operator and policies are reviewed again.'
              : 'Matrix.org is operated independently by the Matrix.org Foundation. Free plan: 10 MB attachments and 100 MB per day.'}
            notice={serviceAgeNotice(MATRIX_ORG_SERVICE)}
            actionLabel="Sign in"
            disabled={prominentServiceExpired}
            registrationUrl={MATRIX_ORG_SERVICE.registration.url}
            onRegister={() => beginExternalRegistration(MATRIX_ORG_SERVICE)}
            onSelect={() => selectPublicService(MATRIX_ORG_SERVICE)}
            termsUrl={MATRIX_ORG_SERVICE.termsUrl}
            privacyUrl={MATRIX_ORG_SERVICE.privacyUrl}
          />
        ) : null}

        {offeredCommunityService && pendingInvitationHandle ? (
          <ServiceChoiceCard
            title={communityServiceName}
            eyebrow={communityAccountCreationOffered ? 'Optional account offer' : 'Invitation service'}
            description={communityAccountCreationOffered
              ? `This invitation offers account creation with ${communityServiceName}. Mesh verifies the one-use invitation only when you choose this action. The service has no Mesh uptime guarantee, and you may choose another service instead.`
              : `This invitation suggests ${communityServiceName} for people who already have an account there. It remains optional; you may sign in with any compatible service instead.`}
            serviceAddress={displayServiceAddress(offeredCommunityService)}
            actionLabel={communityAccountCreationOffered ? 'Create account' : 'Sign in'}
            actionVariant="secondary"
            onSelect={selectCommunityService}
          />
        ) : null}

        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" variant="secondary" onClick={() => changeMode('public-services')}>
            More public services
          </Button>
          <Button type="button" variant="secondary" onClick={() => changeMode('advanced')}>
            Use another service
          </Button>
        </div>
      </div>
    )
  }

  if (mode === 'public-services') {
    return (
      <div className="space-y-4">
        <header className="space-y-2">
          <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">Independent options</p>
          <h1
            ref={modeHeadingRef}
            tabIndex={-1}
            className="text-lg font-semibold tracking-tight text-primary"
          >
            More public services
          </h1>
          <p className="text-sm leading-6 text-secondary">
            These entries are manually reviewed, not copied from a public directory.
          </p>
        </header>
        <Button type="button" variant="ghost" className="w-full" onClick={() => changeMode('select')}>
          Back to service choices
        </Button>
        {PUBLIC_SERVICES.filter((service) => !service.prominent).map((service) => {
          const expired = publicServiceReviewExpired(service)
          return (
            <ServiceChoiceCard
              key={service.id}
              title={service.displayName}
              eyebrow={expired ? 'Review expired' : `Operated by ${service.operator}`}
              description={expired
                ? 'This option is unavailable until its operator and policies are reviewed again.'
                : `${service.jurisdiction}. ${service.freeUseLimits.summary}`}
              notice={serviceAgeNotice(service)}
              actionLabel="Sign in"
              disabled={expired}
              registrationUrl={service.registration.url}
              onRegister={() => beginExternalRegistration(service)}
              onSelect={() => selectPublicService(service)}
              termsUrl={service.termsUrl}
              privacyUrl={service.privacyUrl}
            />
          )
        })}
      </div>
    )
  }

  return (
    <form className="mesh-account-form space-y-3" onSubmit={submit}>
      <header className="space-y-2">
        <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">
          {isCreate ? 'Create an account' : isAdvanced ? 'Advanced sign in' : 'Welcome back'}
        </p>
        <h1 ref={modeHeadingRef} tabIndex={-1} className="text-lg font-semibold tracking-tight text-primary">
          {isCreate
            ? `Create your account with ${selectedServiceName}`
            : isAdvanced
              ? 'Use another service'
              : `Sign in to ${selectedServiceName}`}
        </h1>
        <p className="max-w-sm text-sm leading-6 text-secondary">
          {isCreate
            ? `This invitation offers an account at ${displayServiceAddress(selectedServiceAddress)}. You can go back and choose an independent service instead.`
            : isAdvanced
              ? 'Enter your full account ID or the address of the service that stores your account.'
              : 'Enter your account details. You can still join communities hosted elsewhere.'}
        </p>
      </header>

      {selectedService?.kind === 'community' ? (
        <section
          aria-label={`${selectedService.name} service details`}
          className="mesh-inline-card rounded-panel border border-border-subtle bg-surface-sunken p-3 text-xs leading-5 text-secondary"
        >
          <p>
            Your account will be stored at {displayServiceAddress(selectedService.address)}. This
            service has no Mesh uptime guarantee and remains separate from the community itself.
          </p>
        </section>
      ) : null}

      {!selectedPublicService ? (
        checkingCapabilities ? (
          <p role="status" className="text-xs text-muted">Checking this service…</p>
        ) : capabilities ? (
          <p role="status" className="text-xs text-muted">
            {capabilitySummary(capabilities)}
          </p>
        ) : null
      ) : null}

      {!isCreate && savedAccounts.length > 0 ? (
        <section
          aria-label="Saved accounts"
          className="space-y-2 rounded-panel border border-border-subtle bg-surface-sunken p-3"
        >
          <p className="text-2xs uppercase tracking-signal text-muted">Continue without a password</p>
          <p className="text-xs leading-5 text-secondary">
            Choose an account to continue with its saved sign-in instead of typing your account
            details again.
          </p>
          {savedAccounts.map((account) => (
            <button
              key={account.profileId}
              type="button"
              disabled={submitting || switchingProfile !== null}
              className="flex w-full items-center justify-between gap-3 rounded-control bg-surface-base px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60"
              onClick={() => void switchAccount(account.profileId)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-primary">
                  {friendlyAccountName(account.userId)}
                </span>
                <span className="block truncate text-xs text-muted">Saved on this device</span>
              </span>
              <span className="text-xs font-medium text-accent">
                {switchingProfile === account.profileId ? 'Opening…' : 'Continue'}
              </span>
            </button>
          ))}
        </section>
      ) : null}

      <div
        className={`mesh-form-card rounded-panel border border-border-subtle bg-surface-sunken p-4 ${
          isCreate ? 'space-y-2' : 'space-y-3'
        }`}
      >
        <Input
          label={isCreate ? 'Username' : 'Username or full account ID'}
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
          <p className="rounded-control border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs leading-5 text-secondary">
            This account ID belongs to <span className="font-medium text-primary">{accountIdService}</span>.
            Choose <span className="font-medium text-primary">Use another service</span> so Mesh can
            connect to the service that stores this account.
          </p>
        ) : null}
        {isCreate && normalizedUsername && !createUsernameError && availability !== 'idle' ? (
          <p
            role="status"
            className={`text-xs ${
              availability === 'available'
                ? 'text-status-success'
                : availability === 'taken' || availability === 'error'
                  ? 'text-status-danger'
                  : 'text-muted'
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
            hint={isCreate ? 'Use at least 10 characters. A longer passphrase works well.' : undefined}
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
                    className={`h-1 rounded-full ${
                      score <= strength.score
                        ? strength.strongEnough
                          ? 'bg-status-success'
                          : 'bg-status-warning'
                        : 'bg-surface-active'
                    }`}
                  />
                ))}
              </div>
              <p className={`text-xs ${strength.strongEnough ? 'text-status-success' : 'text-muted'}`}>
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

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={showPassword}
              onChange={(event) => setShowPassword(event.target.checked)}
              className="h-4 w-4 accent-accent"
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
          <div className="space-y-3 border-t border-border pt-4">
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
              hint="Optional when you entered a full account ID above."
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
        <p role="alert" className="rounded-control border border-status-danger/40 bg-status-danger/10 px-3 py-2 text-sm text-status-danger">
          This service did not advertise a sign-in method that Mesh can use.
        </p>
      ) : null}

      {error ? (
        <div
          ref={errorSummaryRef}
          role="alert"
          tabIndex={-1}
          className="rounded-control border border-status-danger/40 bg-status-danger/10 px-3 py-2 text-sm text-status-danger"
        >
          <p>{error}</p>
          {errorDetails ? (
            <details className="mt-2 text-xs text-muted">
              <summary className="cursor-pointer underline-offset-2 hover:underline">
                Technical details
              </summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-control bg-surface-sunken p-2 font-mono text-meta text-secondary">
                {errorDetails}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}

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
          className="space-y-2 border-t border-border-subtle pt-3"
        >
          <p className="text-xs font-medium text-primary">Having trouble signing in?</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <button
              type="button"
              className="min-h-8 rounded-control px-1 text-accent transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              aria-expanded={recoveryHelp === 'password'}
              onClick={() => setRecoveryHelp((current) => current === 'password' ? null : 'password')}
            >
              Forgot password?
            </button>
            <button
              type="button"
              className="min-h-8 rounded-control px-1 text-accent transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              aria-expanded={recoveryHelp === 'username'}
              onClick={() => setRecoveryHelp((current) => current === 'username' ? null : 'username')}
            >
              Forgot username?
            </button>
          </div>
          {recoveryHelp ? (
            <div role="status" className="space-y-2 border-t border-border pt-2 text-xs leading-5 text-secondary">
              {recoveryHelp === 'password' ? (
                <>
                  <p>
                    Mesh never stores your account password. Password recovery is handled by{' '}
                    {selectedServiceName}, so there isn&apos;t one Mesh-wide reset page.
                  </p>
                  {accountHelpUrl ? (
                    <ExternalLink href={accountHelpUrl}>Open {accountHelpLabel}</ExternalLink>
                  ) : (
                    <p>
                      Open the website for {displayServiceAddress(selectedServiceAddress)} or ask
                      whoever runs that service for a password reset.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p>
                    Usernames are issued by the account service, so Mesh cannot safely search for
                    one across services. Check the email or password manager you used when you
                    created the account.
                  </p>
                  {savedAccounts.length > 0 ? (
                    <p>
                      If you used this device before, choose a saved account above. It opens
                      without asking for the username or password again.
                    </p>
                  ) : null}
                  {accountHelpUrl ? (
                    <ExternalLink href={accountHelpUrl}>Open {accountHelpLabel}</ExternalLink>
                  ) : (
                    <p>
                      Ask whoever runs {displayServiceAddress(selectedServiceAddress)} to help
                      recover your account ID.
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
              className="text-xs leading-5 text-muted"
            >
              Browser sign-in opens from the installed Mesh app. Password sign-in remains
              available here when the service supports it.
            </p>
          ) : null}
        </div>
      ) : null}

      {selectedPublicService ? (
        checkingCapabilities ? (
          <p role="status" className="text-xs text-muted">Checking this service…</p>
        ) : capabilities ? (
          <p role="status" className="text-xs text-muted">
            {capabilitySummary(capabilities)}
          </p>
        ) : null
      ) : null}

      {selectedPublicService ? (
        <section
          aria-label={`${onboardingPublicServiceName(selectedPublicService)} details`}
          className="mesh-inline-card space-y-2 rounded-panel border border-border-subtle bg-surface-sunken p-3 text-xs leading-5 text-secondary"
        >
          <p>
            Operated independently by {selectedPublicService.operator}.{' '}
            {selectedPublicService.freeUseLimits.summary}
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <ExternalLink
              href={selectedPublicService.registration.url}
              onBeforeOpen={() => beginExternalRegistration(selectedPublicService)}
            >
              {selectedPublicService.prominent
                ? 'Create an account in your browser'
                : selectedPublicService.registration.label}
            </ExternalLink>
            <ExternalLink href={selectedPublicService.termsUrl}>Terms</ExternalLink>
            <ExternalLink href={selectedPublicService.privacyUrl}>Privacy</ExternalLink>
          </div>
        </section>
      ) : null}

      {isCreate ? (
        <p className="text-center text-sm text-secondary">
          Already have an account with this service?{' '}
          <button
            type="button"
            className="inline-flex min-h-8 items-center rounded-control px-1 text-accent transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => changeMode('sign-in')}
          >
            Sign in
          </button>
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2 text-xs">
          <button
            type="button"
            className="inline-flex min-h-8 items-center rounded-control px-2 text-muted transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => changeMode('select')}
          >
            Back to service choices
          </button>
          {selectedPublicService ? (
            <span className="text-muted">
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
  const route = (pending?.via ?? [])
    .map(invitationLabel)
    .filter((value): value is string => value !== null)
    .join(', ')
  const joinRule = plainJoinRule(pending?.joinRule)
  const title = communityName ?? 'Community invitation'

  return (
    <section
      aria-label="Community invitation"
      className={`space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-3 text-xs leading-5 text-secondary ${compact ? '' : 'sm:p-4'}`}
    >
      <div className="flex items-start gap-3">
        <Avatar
          color="var(--accent)"
          size={40}
          name={communityName ?? 'Community invitation'}
          variant="community"
          className="flex-none !rounded-panel"
        />
        <div className="min-w-0 space-y-0.5">
          <p className="text-2xs uppercase tracking-signal text-muted">Community invitation</p>
          <h2 className="truncate text-sm font-semibold text-primary">{title}</h2>
          <p>
            {inviter
              ? `Invited by ${inviter}.`
              : 'An invitation is saved securely on this device.'}
          </p>
        </div>
      </div>

      {communityService || joinRule ? (
        <dl className="grid gap-x-4 gap-y-2 border-t border-border-subtle pt-3 sm:grid-cols-2">
          {communityService ? (
            <div>
              <dt className="text-2xs uppercase tracking-signal text-muted">Community service</dt>
              <dd className="truncate text-primary">{communityService}</dd>
            </div>
          ) : null}
          {joinRule ? (
            <div>
              <dt className="text-2xs uppercase tracking-signal text-muted">Access</dt>
              <dd className="text-primary">{joinRule}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {serviceAddress || route ? (
        <details className="rounded-control border border-border-subtle bg-surface-base px-3">
          <summary className="flex min-h-10 cursor-pointer items-center font-semibold text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            Service details
          </summary>
          <dl className="space-y-2 border-t border-border-subtle py-3">
            {serviceAddress ? (
              <div>
                <dt className="text-2xs uppercase tracking-signal text-muted">Service address</dt>
                <dd className="break-all text-primary">{serviceAddress}</dd>
              </div>
            ) : null}
            {route ? (
              <div>
                <dt className="text-2xs uppercase tracking-signal text-muted">Community route</dt>
                <dd className="break-all text-primary">{route}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}

      <p>
        {compact
          ? 'Invitation saved securely on this device. Mesh will use it only after your account is ready, and your account service remains separate from this community.'
          : 'Invitation saved securely on this device and will be used after you sign in. Choose where your account lives below; Mesh checks this invitation and the community rules again before joining.'}
      </p>

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
      className="space-y-2 rounded-panel border border-border-subtle bg-surface-sunken p-3"
    >
      <p className="text-2xs uppercase tracking-signal text-muted">Continue without a password</p>
      <p className="text-xs leading-5 text-secondary">
        Choose an account to continue with its saved sign-in.
      </p>
      {accounts.map((account) => (
        <button
          key={account.profileId}
          type="button"
          disabled={disabled || switchingProfile !== null}
          className="flex w-full items-center justify-between gap-3 rounded-control bg-surface-base px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60"
          onClick={() => onSelect(account.profileId)}
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-primary">
              {friendlyAccountName(account.userId)}
            </span>
            <span className="block truncate text-xs text-muted">Saved on this device</span>
          </span>
          <span className="text-xs font-medium text-accent">
            {switchingProfile === account.profileId ? 'Opening…' : 'Continue'}
          </span>
        </button>
      ))}
    </section>
  )
}

function ServiceChoiceCard({
  title,
  eyebrow,
  description,
  actionLabel,
  onSelect,
  disabled = false,
  registrationUrl,
  onRegister,
  termsUrl,
  privacyUrl,
  notice,
  serviceAddress,
  actionVariant = 'primary',
}: {
  title: string
  eyebrow: string
  description: string
  actionLabel: string
  onSelect: () => void
  disabled?: boolean
  registrationUrl?: string
  onRegister?: () => boolean
  termsUrl?: string
  privacyUrl?: string
  notice?: string
  serviceAddress?: string
  actionVariant?: 'primary' | 'secondary'
}) {
  return (
    <article className="mesh-service-card space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-4">
      <div className="space-y-1">
        <p className="text-2xs uppercase tracking-signal text-muted">{eyebrow}</p>
        <h2 className="text-base font-semibold tracking-tight text-primary">{title}</h2>
        <p className="text-xs leading-5 text-secondary">{description}</p>
        {serviceAddress ? (
          <details className="rounded-control border border-border-subtle bg-surface-base px-2.5">
            <summary className="flex min-h-9 cursor-pointer items-center text-xs font-semibold text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              Service details
            </summary>
            <p className="break-all border-t border-border-subtle py-2 text-xs text-muted">
              {serviceAddress}
            </p>
          </details>
        ) : null}
        {notice ? (
          <p className="rounded-control border border-status-warning/30 bg-status-warning/10 px-2.5 py-2 text-xs font-medium leading-5 text-secondary">
            {notice}
          </p>
        ) : null}
      </div>
      {registrationUrl ? (
        <div className="mesh-service-card-actions space-y-2">
          <Button
            type="button"
            variant={actionVariant}
            className="w-full"
            disabled={disabled}
            aria-label={`${actionLabel} with ${title}`}
            onClick={onSelect}
          >
            {actionLabel}
          </Button>
          {disabled ? (
            <p className="text-center text-xs leading-5 text-muted">
              Account creation is unavailable until this service is reviewed again.
            </p>
          ) : (
            <p className="text-center text-xs leading-5 text-muted">
              New here?{' '}
              <a
                href={registrationUrl}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`Create account with ${title}`}
                onClick={(event) => {
                  if (onRegister && !onRegister()) event.preventDefault()
                }}
                className="text-accent underline underline-offset-2"
              >
                Create account
              </a>
              {' '}in your browser, then return to Mesh.
            </p>
          )}
        </div>
      ) : (
        <Button
          type="button"
          variant={actionVariant}
          className="w-full"
          disabled={disabled}
          aria-label={`${actionLabel} with ${title}`}
          onClick={onSelect}
        >
          {actionLabel}
        </Button>
      )}
      {termsUrl || privacyUrl ? (
        <details className="rounded-control border border-border-subtle bg-surface-base px-2.5 text-xs">
          <summary className="flex min-h-9 cursor-pointer items-center font-semibold text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            Policies and independence
          </summary>
          <div className="space-y-2 border-t border-border-subtle py-2 leading-5 text-muted">
            <p>
              This service sets its own availability, registration rules, content policies, and
              limits. Mesh does not operate, endorse, or guarantee it.
            </p>
            <div className="flex flex-wrap gap-3">
              {termsUrl ? <ExternalLink href={termsUrl}>Terms</ExternalLink> : null}
              {privacyUrl ? <ExternalLink href={privacyUrl}>Privacy</ExternalLink> : null}
            </div>
          </div>
        </details>
      ) : null}
    </article>
  )
}

function serviceAgeNotice(service: PublicService): string {
  return `Ages ${service.minimumAge}+ under the service's current terms.`
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
      className="text-accent underline underline-offset-2"
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
      notice: 'That saved account service is no longer available. Choose another reviewed service or use your own.',
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
    return 'The saved registration return expired. Choose your account service again; your invitation remains saved separately.'
  }
  if (status === 'replayed' || status === 'mismatch') {
    return 'Mesh rejected a registration return that was already used or replaced. Choose your account service again.'
  }
  if (status === 'unavailable') {
    return 'Mesh cannot save a registration return on this device right now. You can still sign in to an existing account.'
  }
  if (status === 'empty') {
    return 'No saved registration return was found. Choose your account service again.'
  }
  return 'Mesh rejected invalid saved registration state. Choose your account service again; your invitation remains saved separately.'
}

function displayAccountService(service: SelectedAccountService | null): string {
  if (!service) return 'your service'
  if (service.kind === 'public') return onboardingPublicServiceName(service.service)
  return service.name
}

function onboardingPublicServiceName(service: PublicService): string {
  return service.prominent ? 'Public account service' : service.displayName
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

function capabilitySummary(capabilities: bridge.MatrixServiceCapabilities): string {
  const methods = [
    capabilities.passwordLogin ? 'password' : null,
    capabilities.browserLogin ? 'browser' : null,
  ].filter(Boolean)
  const methodSummary = methods.length > 0
    ? `${methods.join(' and ')} sign-in available`
    : 'no supported sign-in method advertised'
  const uploadSummary = capabilities.maxUploadBytes
    ? ` Maximum upload: ${formatBytes(capabilities.maxUploadBytes)}.`
    : ''
  const invitationOnlySummary = capabilities.registration === 'invitation-only'
    ? ' Account creation requires an invitation from the service operator.'
    : ''
  const registrationSummary = capabilities.registration === 'open'
    ? ' Direct account creation is available.'
    : capabilities.registration === 'closed'
      ? ' Direct account creation is closed; use the operator’s registration link if offered.'
      : ''
  return `Service reached; ${methodSummary}.${invitationOnlySummary || registrationSummary}${uploadSummary}`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024 * 1024))} GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
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
