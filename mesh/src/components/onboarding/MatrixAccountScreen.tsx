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
import * as bridge from '../../lib/bridge'
import {
  MATRIX_ORG_SERVICE,
  PUBLIC_SERVICES,
  publicServiceReviewExpired,
  type PublicService,
} from '../../config/public-services'
import type { MatrixCommunityAdmission, PendingInvitationMetadata } from '../../types/ipc'
import type { OnboardingFlowProps } from './types'
import {
  friendlyAccountCreationError,
  invitationCodeFromInput,
  invitationValidationError,
  normalizeUsername,
  passwordStrength,
  usernameValidationError,
} from './accountCreation'
import { parseAdmissionCommunityInvite } from '../../lib/community-invites'
import {
  normalizeServiceAddress,
  resolveServiceAddress,
  serviceAddressConfigError,
} from './matrixSignIn'

type AccountMode = 'select' | 'public-services' | 'create' | 'sign-in' | 'advanced'
type Availability = 'idle' | 'checking' | 'available' | 'taken' | 'error'
type AvailabilityCheck = {
  username: string
  status: Exclude<Availability, 'idle' | 'checking'>
}
type AdmissionResolution =
  | { invitation: string; status: 'resolving' }
  | { invitation: string; status: 'resolved'; admission: MatrixCommunityAdmission }
  | { invitation: string; status: 'error'; message: string }
type PendingAdmissionResolution =
  | { handle: string; status: 'resolving' }
  | { handle: string; status: 'resolved'; admission: MatrixCommunityAdmission }
  | { handle: string; status: 'error'; message: string }
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
  | 'onResolvePendingInvitation'
  | 'onDiscardPendingInvitation'
> & {
  onNext: (outcome: MatrixAccountOutcome) => void
  initialInvitation?: string
  initialPendingInvitation?: PendingInvitationMetadata | null
  initialAccountService?: string
}

export function MatrixAccountScreen({
  onMatrixCheckUsernameAvailable,
  onMatrixRegisterAccount,
  onMatrixLogin,
  onMatrixOidcLogin,
  onMatrixSwitchAccount,
  onResolvePendingInvitation,
  onDiscardPendingInvitation,
  onNext,
  initialInvitation = '',
  initialPendingInvitation = null,
  initialAccountService,
}: MatrixAccountScreenProps) {
  const normalizedInitialService = normalizeServiceAddress(initialAccountService ?? '')
  const [mode, setMode] = useState<AccountMode>(
    normalizedInitialService ? 'sign-in' : 'select',
  )
  const [selectedService, setSelectedService] = useState<SelectedAccountService | null>(
    normalizedInitialService
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
  const [invitation, setInvitation] = useState(initialInvitation)
  const [admissionResolution, setAdmissionResolution] =
    useState<AdmissionResolution | null>(null)
  const [pendingAdmissionResolution, setPendingAdmissionResolution] =
    useState<PendingAdmissionResolution | null>(null)
  const [pendingInvitationDismissed, setPendingInvitationDismissed] = useState(false)
  const [serviceAddress, setServiceAddress] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [availabilityCheck, setAvailabilityCheck] = useState<AvailabilityCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [switchingProfile, setSwitchingProfile] = useState<string | null>(null)
  const [savedAccounts, setSavedAccounts] = useState<bridge.MatrixAccount[]>([])
  const [checkingBrowser, setCheckingBrowser] = useState(false)
  const [browserReady, setBrowserReady] = useState(false)
  const [browserSigningIn, setBrowserSigningIn] = useState(false)
  const [capabilities, setCapabilities] = useState<bridge.MatrixServiceCapabilities | null>(null)
  const [checkingCapabilities, setCheckingCapabilities] = useState(false)
  const modeHeadingRef = useRef<HTMLHeadingElement>(null)
  const previousModeRef = useRef<AccountMode>(mode)

  const normalizedUsername = useMemo(() => normalizeUsername(username), [username])
  const createUsernameError = useMemo(
    () => mode === 'create' ? usernameValidationError(username) : null,
    [mode, username],
  )
  const strength = useMemo(() => passwordStrength(password), [password])
  const passwordsMatch = passwordConfirmation.length > 0 && password === passwordConfirmation
  const admissionInvitation = useMemo(
    () => parseAdmissionCommunityInvite(invitation),
    [invitation],
  )
  const matchingAdmission =
    admissionInvitation && admissionResolution?.invitation === admissionInvitation.original
      ? admissionResolution
      : null
  const resolvedAdmission =
    matchingAdmission?.status === 'resolved' ? matchingAdmission.admission : null
  const storedPendingInvitation = initialPendingInvitation && !pendingInvitationDismissed
    ? initialPendingInvitation
    : null
  const matchingPendingAdmission =
    storedPendingInvitation
    && pendingAdmissionResolution?.handle === storedPendingInvitation.handle
      ? pendingAdmissionResolution
      : null
  const pendingAdmission =
    matchingPendingAdmission?.status === 'resolved'
      ? matchingPendingAdmission.admission
      : null
  const pendingAdmissionError =
    matchingPendingAdmission?.status === 'error'
      ? matchingPendingAdmission.message
      : null
  const effectiveAdmission = resolvedAdmission ?? pendingAdmission
  const admissionResolving = matchingAdmission?.status === 'resolving'
    || matchingPendingAdmission?.status === 'resolving'
  const admissionError =
    matchingAdmission?.status === 'error' ? matchingAdmission.message : null
  const invitationError = useMemo(() => {
    if (mode !== 'create') return null
    if (storedPendingInvitation) return pendingAdmissionError
    const syntaxError = invitationValidationError(invitation)
    if (syntaxError) return syntaxError
    if (!admissionInvitation) return null
    if (admissionError) return admissionError
    return null
  }, [admissionError, admissionInvitation, invitation, mode, pendingAdmissionError, storedPendingInvitation])
  const registrationToken = useMemo(
    () => invitationCodeFromInput(invitation) ?? effectiveAdmission?.registrationToken ?? null,
    [effectiveAdmission, invitation],
  )
  const selectedServiceAddress = selectedService?.kind === 'public'
    ? selectedService.service.serviceAddress
    : selectedService?.address ?? ''
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
    && selectedServiceAddress
      ? normalizedUsername
      : null
  const availability: Availability = !availabilityUsername
    ? 'idle'
    : availabilityCheck?.username === availabilityUsername
      ? availabilityCheck.status
      : 'checking'

  useEffect(() => {
    if (!initialInvitation) return
    const timer = window.setTimeout(() => setInvitation(initialInvitation), 0)
    return () => window.clearTimeout(timer)
  }, [initialInvitation])

  useEffect(() => {
    if (!storedPendingInvitation?.admissionService || !onResolvePendingInvitation) return
    let active = true
    const handle = storedPendingInvitation.handle
    void Promise.resolve().then(async () => {
      if (!active) return
      setPendingAdmissionResolution({ handle, status: 'resolving' })
      try {
        const admission = await onResolvePendingInvitation()
        if (!active) return
        if (!admission) {
          setPendingAdmissionResolution({
            handle,
            status: 'error',
            message: 'This saved invitation could not be checked. You can discard it and paste it again.',
          })
        } else {
          setPendingAdmissionResolution({ handle, status: 'resolved', admission })
        }
      } catch {
        if (active) {
          setPendingAdmissionResolution({
            handle,
            status: 'error',
            message: 'This saved invitation is invalid, expired, or has already been used.',
          })
        }
      }
    })
    return () => {
      active = false
    }
  }, [onResolvePendingInvitation, storedPendingInvitation])

  useEffect(() => {
    if (!admissionInvitation) return
    if (!bridge.isTauriRuntime()) {
      const timer = window.setTimeout(() => {
        setAdmissionResolution({
          invitation: admissionInvitation.original,
          status: 'error',
          message: 'Community admission invitations can be opened in the installed Mesh app.',
        })
      }, 0)
      return () => window.clearTimeout(timer)
    }

    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setAdmissionResolution({
        invitation: admissionInvitation.original,
        status: 'resolving',
      })
      try {
        const admission = await bridge.resolveCommunityInvite(admissionInvitation.original)
        if (active) {
          setAdmissionResolution({
            invitation: admissionInvitation.original,
            status: 'resolved',
            admission,
          })
        }
      } catch {
        if (active) {
          setAdmissionResolution({
            invitation: admissionInvitation.original,
            status: 'error',
            message: 'This invitation is invalid, expired, or has already been used.',
          })
        }
      }
    })
    return () => {
      active = false
    }
  }, [admissionInvitation])

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

    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setCheckingCapabilities(true)
      setCapabilities(null)
      setError(null)
      try {
        const nextCapabilities = await bridge.matrixServiceCapabilities(selectedServiceAddress)
        if (active) setCapabilities(nextCapabilities)
      } catch {
        if (!active) return
        setError('Mesh could not reach that account service. Check its status or choose another service.')
      } finally {
        if (active) setCheckingCapabilities(false)
      }
    })
    return () => {
      active = false
    }
  }, [mode, selectedService, selectedServiceAddress])

  useEffect(() => {
    if (!availabilityUsername || !onMatrixCheckUsernameAvailable) return

    let active = true
    const timer = window.setTimeout(() => {
      void onMatrixCheckUsernameAvailable(selectedServiceAddress, availabilityUsername).then((available) => {
        if (active) {
          setAvailabilityCheck({
            username: availabilityUsername,
            status: available ? 'available' : 'taken',
          })
        }
      }).catch((cause) => {
        if (active) {
          setAvailabilityCheck({ username: availabilityUsername, status: 'error' })
          setError(friendlyAccountCreationError(cause))
        }
      })
    }, 300)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [availabilityUsername, onMatrixCheckUsernameAvailable, selectedServiceAddress])

  useEffect(() => {
    if (previousModeRef.current === mode) return
    previousModeRef.current = mode
    const frame = window.requestAnimationFrame(() => modeHeadingRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [mode])

  const resetFeedback = () => {
    setError(null)
    setBrowserReady(false)
  }

  const changeMode = (nextMode: AccountMode) => {
    if (nextMode === 'select' || nextMode === 'public-services' || nextMode === 'advanced') {
      setSelectedService(null)
      setCapabilities(null)
    }
    setMode(nextMode)
    setPassword('')
    setPasswordConfirmation('')
    setShowPassword(false)
    resetFeedback()
  }

  const selectPublicService = (service: PublicService) => {
    setSelectedService({ kind: 'public', service })
    setServiceAddress('')
    setCapabilities(null)
    changeMode('sign-in')
  }

  const selectCommunityService = () => {
    if (!effectiveAdmission?.registrationToken) return
    setSelectedService({
      kind: 'community',
      name: 'Community-hosted service',
      address: effectiveAdmission.service,
    })
    setServiceAddress('')
    setCapabilities(null)
    changeMode('create')
  }

  const discardPendingInvitation = async () => {
    setError(null)
    try {
      await onDiscardPendingInvitation?.()
      setPendingInvitationDismissed(true)
      setPendingAdmissionResolution(null)
    } catch {
      setError('Mesh could not discard the saved invitation. Try again.')
    }
  }

  const checkCustomService = async () => {
    if (!resolvedService) {
      setError('Enter your Matrix ID or service address.')
      return
    }
    const serviceError = serviceAddressConfigError(resolvedService)
    if (serviceError) {
      setError(serviceError)
      return
    }
    setCheckingCapabilities(true)
    setCapabilities(null)
    setError(null)
    try {
      const nextCapabilities = bridge.isTauriRuntime()
        ? await bridge.matrixServiceCapabilities(resolvedService)
        : {
            homeserver: resolvedService,
            serverVersions: ['preview'],
            passwordLogin: true,
            browserLogin: true,
            registration: 'unknown' as const,
            maxUploadBytes: null,
          }
      setCapabilities(nextCapabilities)
    } catch {
      setError('Mesh could not reach that account service. Check the address and try again.')
    } finally {
      setCheckingCapabilities(false)
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
        setError('Choose the community-hosted service before creating this account.')
        return
      }
      if (
        createUsernameError
        || availability !== 'available'
        || !strength.strongEnough
        || !passwordsMatch
        || invitationError
        || !registrationToken
      ) {
        setError('Finish the highlighted fields before creating your account.')
        return
      }

      setSubmitting(true)
      try {
        await onMatrixRegisterAccount({
          homeserver: resolvedService,
          username: normalizedUsername,
          password,
          registrationToken: registrationToken ?? undefined,
          deviceName: 'Mesh Desktop',
        })
        setPassword('')
        setPasswordConfirmation('')
        setInvitation('')
        onNext('registered')
      } catch (cause) {
        setError(friendlyAccountCreationError(cause))
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
      await onMatrixLogin({
        homeserver: resolvedService,
        username: username.trim().startsWith('@') ? username.trim() : normalizedUsername,
        password,
        deviceName: 'Mesh Desktop',
      })
      setPassword('')
      onNext('signed-in')
    } catch (cause) {
      setError(friendlyAccountSignInError(cause))
    } finally {
      setSubmitting(false)
    }
  }

  const switchAccount = async (profileId: string) => {
    if (!onMatrixSwitchAccount) return
    setSwitchingProfile(profileId)
    setError(null)
    try {
      await onMatrixSwitchAccount(profileId)
      onNext('signed-in')
    } catch (cause) {
      setError(friendlyAccountSignInError(cause))
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
    setCheckingBrowser(true)
    setBrowserReady(false)
    setError(null)
    try {
      const status = await bridge.matrixOidcStatus(resolvedService)
      setBrowserReady(status.ready)
      if (!status.ready) setError('Browser sign-in is not available for this account.')
    } catch {
      setError('Mesh could not prepare browser sign-in. Try your password instead.')
    } finally {
      setCheckingBrowser(false)
    }
  }

  const startBrowserSignIn = async () => {
    if (!resolvedService || !browserReady || !onMatrixOidcLogin) return
    setBrowserSigningIn(true)
    setError(null)
    try {
      await onMatrixOidcLogin(resolvedService)
      onNext('signed-in')
    } catch (cause) {
      setError(friendlyAccountSignInError(cause))
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
  const usernameHint = isCreate && !normalizedUsername ? '3–32 lowercase characters.' : undefined
  const createDisabled =
    submitting
    || availability !== 'available'
    || Boolean(createUsernameError)
    || !strength.strongEnough
    || !passwordsMatch
    || Boolean(invitationError)
    || admissionResolving
    || !registrationToken
  const signInDisabled =
    submitting
    || switchingProfile !== null
    || !resolvedService
    || !username.trim()
    || !password
    || capabilities?.passwordLogin === false
    || (isAdvanced && !capabilities)

  if (mode === 'select') {
    return (
      <div className="space-y-3">
        <header className="space-y-1.5">
          <p className="text-2xs uppercase tracking-eyebrow text-muted">Mesh</p>
          <h1 className="text-lg font-semibold tracking-tight text-primary">
            Choose your account service
          </h1>
          <p className="max-w-md text-sm leading-6 text-secondary">
            This service stores your account data and sets its own rules and limits. Your choice
            does not have to match the service that hosts the community you are joining.
          </p>
        </header>

        {savedAccounts.length > 0 ? (
          <SavedAccounts
            accounts={savedAccounts}
            switchingProfile={switchingProfile}
            disabled={submitting}
            onSelect={(profileId) => void switchAccount(profileId)}
          />
        ) : null}

        {MATRIX_ORG_SERVICE && !publicServiceReviewExpired(MATRIX_ORG_SERVICE) ? (
          <ServiceChoiceCard
            title="Matrix.org"
            eyebrow="Public service"
            description="Operated independently by the Matrix.org Foundation. Free-plan limits currently include 10 MB per attachment and 100 MB of data per day."
            actionLabel="Choose Matrix.org"
            onSelect={() => selectPublicService(MATRIX_ORG_SERVICE)}
          />
        ) : null}

        {effectiveAdmission?.registrationToken ? (
          <ServiceChoiceCard
            title="Community-hosted service"
            eyebrow="Optional account offer"
            description="This invitation offers account creation through the community operator. It has no Mesh uptime guarantee, and you may choose another service instead."
            actionLabel="Choose community-hosted service"
            onSelect={selectCommunityService}
          />
        ) : admissionResolving ? (
          <p role="status" className="rounded-control bg-surface-sunken px-3 py-2 text-xs text-muted">
            Checking whether this invitation offers a community-hosted account service…
          </p>
        ) : storedPendingInvitation && pendingAdmissionError ? (
          <div className="space-y-2 rounded-control border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-secondary">
            <p>{pendingAdmissionError}</p>
            <Button type="button" size="sm" variant="ghost" onClick={() => void discardPendingInvitation()}>
              Discard invitation
            </Button>
          </div>
        ) : storedPendingInvitation ? (
          <div className="space-y-2 rounded-control border border-border-subtle bg-surface-sunken px-3 py-2 text-xs text-secondary">
            <p>
              This invitation is saved securely and will be used after you sign in to join the community.
            </p>
            <Button type="button" size="sm" variant="ghost" onClick={() => void discardPendingInvitation()}>
              Discard invitation
            </Button>
          </div>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" variant="secondary" onClick={() => changeMode('public-services')}>
            More public services
          </Button>
          <Button type="button" variant="secondary" onClick={() => changeMode('advanced')}>
            Use another service
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted">
          Public services are independently operated and may change availability, registration
          rules, content policies, and limits. Mesh does not endorse or guarantee them.
        </p>
      </div>
    )
  }

  if (mode === 'public-services') {
    return (
      <div className="space-y-3">
        <header className="space-y-1.5">
          <p className="text-2xs uppercase tracking-eyebrow text-muted">Independent options</p>
          <h1 className="text-lg font-semibold tracking-tight text-primary">
            More public services
          </h1>
          <p className="text-sm leading-6 text-secondary">
            These entries are manually reviewed, not copied from a public directory.
          </p>
        </header>
        {PUBLIC_SERVICES.filter((service) => !service.prominent).map((service) => {
          const expired = publicServiceReviewExpired(service)
          return (
            <ServiceChoiceCard
              key={service.id}
              title={service.displayName}
              eyebrow={expired ? 'Review expired' : `Operated by ${service.operator}`}
              description={expired
                ? 'This option is hidden from selection until its operator and policies are reviewed again.'
                : `${service.jurisdiction}. ${service.freeUseLimits.summary}`}
              actionLabel={`Choose ${service.displayName}`}
              disabled={expired}
              onSelect={() => selectPublicService(service)}
              termsUrl={service.termsUrl}
              privacyUrl={service.privacyUrl}
            />
          )
        })}
        <Button type="button" variant="ghost" className="w-full" onClick={() => changeMode('select')}>
          Back to service choices
        </Button>
      </div>
    )
  }

  return (
    <form className={isCreate ? 'space-y-2' : 'space-y-3'} onSubmit={submit}>
      <header className="space-y-1.5">
        <p className="text-2xs uppercase tracking-eyebrow text-muted">Mesh</p>
        <h1 ref={modeHeadingRef} tabIndex={-1} className="text-lg font-semibold tracking-tight text-primary">
          {isCreate
            ? 'Create your community-hosted account'
            : isAdvanced
              ? 'Use another service'
              : `Sign in to ${selectedServiceName}`}
        </h1>
        <p className="max-w-sm text-sm leading-6 text-secondary">
          {isCreate
            ? 'This invitation offers an account from the community operator. You can go back and choose an independent service instead.'
            : isAdvanced
              ? 'Enter your full Matrix ID or the address of the service that stores your account.'
              : 'Enter your account details to continue. This choice does not control which communities you can join.'}
        </p>
      </header>

      {selectedPublicService ? (
        <section
          aria-label={`${selectedPublicService.displayName} service details`}
          className="space-y-2 rounded-panel border border-border-subtle bg-surface-sunken p-3 text-xs leading-5 text-secondary"
        >
          <p>
            Operated independently by {selectedPublicService.operator}.{' '}
            {selectedPublicService.freeUseLimits.summary}
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <ExternalLink href={selectedPublicService.registration.url}>
              {selectedPublicService.registration.label}
            </ExternalLink>
            <ExternalLink href={selectedPublicService.termsUrl}>Terms</ExternalLink>
            <ExternalLink href={selectedPublicService.privacyUrl}>Privacy</ExternalLink>
          </div>
        </section>
      ) : selectedService?.kind === 'community' ? (
        <p className="rounded-panel border border-border-subtle bg-surface-sunken p-3 text-xs leading-5 text-secondary">
          This account is hosted by the community operator, has no Mesh uptime guarantee, and
          remains separate from the community itself.
        </p>
      ) : null}

      {checkingCapabilities ? (
        <p role="status" className="text-xs text-muted">Checking this service…</p>
      ) : capabilities ? (
        <p role="status" className="text-xs text-muted">
          {capabilitySummary(capabilities)}
        </p>
      ) : null}

      {!isCreate && savedAccounts.length > 0 ? (
        <section
          aria-label="Saved accounts"
          className="space-y-2 rounded-panel border border-border-subtle bg-surface-sunken p-3"
        >
          <p className="text-2xs uppercase tracking-signal text-muted">Saved on this device</p>
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
                <span className="block truncate text-xs text-muted">Saved account</span>
              </span>
              <span className="text-xs font-medium text-accent">
                {switchingProfile === account.profileId ? 'Opening…' : 'Continue'}
              </span>
            </button>
          ))}
        </section>
      ) : null}

      <div
        className={`rounded-panel border border-border-subtle bg-surface-sunken p-3 ${
          isCreate ? 'space-y-2' : 'space-y-3'
        }`}
      >
        <Input
          label="Username"
          name="username"
          value={username}
          onChange={(value: string) => {
            setUsername(value)
            if (isAdvanced) setCapabilities(null)
            setError(null)
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

        {isCreate && storedPendingInvitation ? (
          <section className="space-y-2 rounded-panel border border-border-subtle bg-surface-sunken p-3 text-xs leading-5 text-secondary">
            <p className="font-medium text-primary">Invitation saved securely on this device</p>
            <p>
              {storedPendingInvitation.roomOrAlias
                ? `Community target: ${storedPendingInvitation.roomOrAlias}. `
                : ''}
              Mesh will use it only to create this account and join the community afterward.
            </p>
            <Button type="button" size="sm" variant="ghost" onClick={() => void discardPendingInvitation()}>
              Discard invitation
            </Button>
          </section>
        ) : isCreate ? (
          <Input
            label="Invitation code"
            name="invitation"
            value={invitation}
            onChange={(value: string) => {
              setInvitation(value)
              setError(null)
            }}
            placeholder="Paste your invitation link or code"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={512}
            error={invitation ? invitationError ?? undefined : undefined}
            hint={admissionResolving
              ? 'Checking this one-use invitation…'
              : 'One-use private beta invitation. No email needed.'}
          />
        ) : null}

        {isAdvanced ? (
          <div className="space-y-3 border-t border-border pt-4">
            <Input
              label="Service address"
              name="homeserver"
              value={serviceAddress}
              onChange={(value: string) => {
                setServiceAddress(value)
                setCapabilities(null)
                resetFeedback()
              }}
              placeholder="example.com"
              autoCapitalize="none"
              spellCheck={false}
              hint="Optional when you entered a full Matrix ID above."
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

      {!isCreate && capabilities?.browserLogin ? (
        <div className="flex flex-wrap gap-2">
          {!browserReady ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={checkingBrowser || !resolvedService || !bridge.isTauriRuntime()}
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
      ) : null}

      {!isCreate && capabilities && !capabilities.passwordLogin && !capabilities.browserLogin ? (
        <p role="alert" className="text-sm text-status-danger">
          This service did not advertise a sign-in method that Mesh can use.
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-control border border-status-danger/40 bg-status-danger/10 px-3 py-2 text-sm text-status-danger"
        >
          {error}
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
        <div className="space-y-2 text-center">
          <button
            type="button"
            className="flex min-h-8 w-full items-center justify-center rounded-control px-2 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => changeMode('select')}
          >
            Back to service choices
          </button>
          {selectedPublicService ? (
            <p className="text-xs text-muted">
              Need an account?{' '}
              <ExternalLink href={selectedPublicService.registration.url}>
                Register with {selectedPublicService.displayName}
              </ExternalLink>
            </p>
          ) : null}
        </div>
      )}
    </form>
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
      <p className="text-2xs uppercase tracking-signal text-muted">Saved on this device</p>
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
            <span className="block truncate text-xs text-muted">Saved account</span>
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
  termsUrl,
  privacyUrl,
}: {
  title: string
  eyebrow: string
  description: string
  actionLabel: string
  onSelect: () => void
  disabled?: boolean
  termsUrl?: string
  privacyUrl?: string
}) {
  return (
    <article className="space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-3">
      <div className="space-y-1">
        <p className="text-2xs uppercase tracking-signal text-muted">{eyebrow}</p>
        <h2 className="text-sm font-semibold text-primary">{title}</h2>
        <p className="text-xs leading-5 text-secondary">{description}</p>
      </div>
      {termsUrl || privacyUrl ? (
        <div className="flex flex-wrap gap-3 text-xs">
          {termsUrl ? <ExternalLink href={termsUrl}>Terms</ExternalLink> : null}
          {privacyUrl ? <ExternalLink href={privacyUrl}>Privacy</ExternalLink> : null}
        </div>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        disabled={disabled}
        onClick={onSelect}
      >
        {actionLabel}
      </Button>
    </article>
  )
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline-offset-2 hover:underline"
    >
      {children}
    </a>
  )
}

function displayAccountService(service: SelectedAccountService | null): string {
  if (!service) return 'your service'
  return service.kind === 'public' ? service.service.displayName : service.name
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
  const registrationSummary = capabilities.registration === 'open'
    ? ' Direct account creation is available.'
    : capabilities.registration === 'closed'
      ? ' Direct account creation is closed; use the operator’s registration link if offered.'
      : ''
  return `Service reached; ${methodSummary}.${registrationSummary}${uploadSummary}`
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

function friendlyAccountSignInError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase()
  if (
    message.includes('forbidden')
    || message.includes('invalid username')
    || message.includes('invalid password')
    || message.includes('403')
  ) {
    return 'That username or password did not work. Check both and try again.'
  }
  if (message.includes('cancel')) return 'Sign-in was cancelled. Nothing was changed.'
  if (message.includes('network') || message.includes('offline') || message.includes('connect')) {
    return 'Mesh could not connect. Check your internet connection and try again.'
  }
  return 'Mesh could not sign you in. Check your details and try again.'
}
