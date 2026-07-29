import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import * as bridge from '../../lib/bridge'
import type { OnboardingFlowProps } from './types'
import {
  friendlyAccountCreationError,
  normalizeUsername,
  passwordStrength,
  usernameValidationError,
} from './accountCreation'
import {
  recommendedServiceConfigError,
  resolveServiceAddress,
} from './matrixSignIn'

type AccountMode = 'create' | 'sign-in' | 'advanced'
type Availability = 'idle' | 'checking' | 'available' | 'taken' | 'error'
export type MatrixAccountOutcome = 'registered' | 'signed-in'

type MatrixAccountScreenProps = Pick<
  OnboardingFlowProps,
  | 'onMatrixCheckUsernameAvailable'
  | 'onMatrixRegisterAccount'
  | 'onMatrixLogin'
  | 'onMatrixSwitchAccount'
> & {
  onNext: (outcome: MatrixAccountOutcome) => void
  recommendedService?: string
}

const CONFIGURED_SERVICE = import.meta.env.VITE_MESH_HOMESERVER?.trim()
const DEFAULT_RECOMMENDED_SERVICE = CONFIGURED_SERVICE || ''

export function MatrixAccountScreen({
  onMatrixCheckUsernameAvailable,
  onMatrixRegisterAccount,
  onMatrixLogin,
  onMatrixSwitchAccount,
  onNext,
  recommendedService = DEFAULT_RECOMMENDED_SERVICE,
}: MatrixAccountScreenProps) {
  const hasRecommendedService = recommendedServiceConfigError(recommendedService) === null
  const [mode, setMode] = useState<AccountMode>('create')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [serviceAddress, setServiceAddress] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [availability, setAvailability] = useState<Availability>('idle')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [switchingProfile, setSwitchingProfile] = useState<string | null>(null)
  const [savedAccounts, setSavedAccounts] = useState<bridge.MatrixAccount[]>([])
  const [checkingBrowser, setCheckingBrowser] = useState(false)
  const [browserReady, setBrowserReady] = useState(false)
  const [browserSigningIn, setBrowserSigningIn] = useState(false)
  const modeHeadingRef = useRef<HTMLHeadingElement>(null)
  const previousModeRef = useRef<AccountMode>(mode)

  const normalizedUsername = useMemo(() => normalizeUsername(username), [username])
  const usernameError = useMemo(() => usernameValidationError(username), [username])
  const strength = useMemo(() => passwordStrength(password), [password])
  const passwordsMatch = passwordConfirmation.length > 0 && password === passwordConfirmation
  const resolvedService = useMemo(
    () => resolveServiceAddress(
      mode === 'advanced' ? 'advanced' : 'recommended',
      username,
      serviceAddress,
      recommendedService,
    ),
    [mode, recommendedService, serviceAddress, username],
  )

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
      mode !== 'create'
      || !normalizedUsername
      || usernameError
      || !onMatrixCheckUsernameAvailable
    ) {
      setAvailability('idle')
      return
    }

    let active = true
    setAvailability('checking')
    const timer = window.setTimeout(() => {
      void onMatrixCheckUsernameAvailable(normalizedUsername).then((available) => {
        if (active) setAvailability(available ? 'available' : 'taken')
      }).catch((cause) => {
        if (active) {
          setAvailability('error')
          setError(friendlyAccountCreationError(cause))
        }
      })
    }, 300)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [mode, normalizedUsername, onMatrixCheckUsernameAvailable, usernameError])

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
    setMode(nextMode)
    setPassword('')
    setPasswordConfirmation('')
    setShowPassword(false)
    resetFeedback()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)

    if (mode === 'create') {
      if (!onMatrixRegisterAccount) {
        setError('Account creation is unavailable in this build.')
        return
      }
      if (
        usernameError
        || availability !== 'available'
        || !strength.strongEnough
        || !passwordsMatch
      ) {
        setError('Finish the highlighted fields before creating your account.')
        return
      }

      setSubmitting(true)
      try {
        await onMatrixRegisterAccount(normalizedUsername, password)
        setPassword('')
        setPasswordConfirmation('')
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

    setSubmitting(true)
    try {
      await onMatrixLogin({
        homeserver: resolvedService,
        username: normalizedUsername,
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
    if (!resolvedService || !browserReady) return
    setBrowserSigningIn(true)
    setError(null)
    try {
      await bridge.matrixStartOidcLogin(resolvedService)
      onNext('signed-in')
    } catch (cause) {
      setError(friendlyAccountSignInError(cause))
    } finally {
      setBrowserSigningIn(false)
    }
  }

  const isCreate = mode === 'create'
  const isAdvanced = mode === 'advanced'
  const usernameHint = isCreate && !normalizedUsername ? '3–32 lowercase characters.' : undefined
  const createDisabled =
    submitting
    || availability !== 'available'
    || Boolean(usernameError)
    || !strength.strongEnough
    || !passwordsMatch
  const signInDisabled =
    submitting
    || switchingProfile !== null
    || !resolvedService
    || !normalizedUsername
    || !password

  return (
    <form className="space-y-3" onSubmit={submit}>
      <header className="space-y-1.5">
        <p className="text-2xs uppercase tracking-eyebrow text-muted">Mesh</p>
        <h1 ref={modeHeadingRef} tabIndex={-1} className="text-lg font-semibold tracking-tight text-primary">
          {isCreate ? 'Create your account' : isAdvanced ? 'Sign in somewhere else' : 'Welcome back'}
        </h1>
        <p className="max-w-sm text-sm leading-6 text-secondary">
          {isCreate
            ? 'Choose the name your friends will know you by.'
            : 'Enter your username and password to continue.'}
        </p>
      </header>

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

      <div className="space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-3">
        <Input
          label="Username"
          name="username"
          value={username}
          onChange={(value: string) => {
            setUsername(value)
            setError(null)
          }}
          placeholder="ashvin"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
          maxLength={32}
          error={usernameError ?? undefined}
          hint={usernameHint}
        />
        {isCreate && normalizedUsername && !usernameError && availability !== 'idle' ? (
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

        {isCreate ? (
          <p className="rounded-control bg-surface-hover px-3 py-2 text-xs text-secondary">
            No email needed.
          </p>
        ) : null}

        {isAdvanced ? (
          <div className="space-y-3 border-t border-border pt-4">
            <Input
              label="Service address"
              name="homeserver"
              value={serviceAddress}
              onChange={(value: string) => {
                setServiceAddress(value)
                resetFeedback()
              }}
              placeholder="example.com"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
            <div className="flex flex-wrap gap-2">
              {!browserReady ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={checkingBrowser || !resolvedService || !bridge.isTauriRuntime()}
                  onClick={() => void checkBrowserSignIn()}
                >
                  {checkingBrowser ? 'Checking…' : 'Check browser sign-in'}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={browserSigningIn}
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
          </div>
        ) : null}
      </div>

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
          Already have an account?{' '}
          <button
            type="button"
            className="inline-flex min-h-8 items-center rounded-control px-1 text-accent transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => changeMode(hasRecommendedService ? 'sign-in' : 'advanced')}
          >
            Sign in
          </button>
        </p>
      ) : (
        <div className="space-y-2 text-center">
          {!isAdvanced ? (
            <button
              type="button"
              className="flex min-h-8 w-full items-center justify-center rounded-control px-2 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => changeMode('advanced')}
            >
              I have an account somewhere else
            </button>
          ) : hasRecommendedService ? (
            <button
              type="button"
              className="flex min-h-8 w-full items-center justify-center rounded-control px-2 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => changeMode('sign-in')}
            >
              Back to Mesh sign in
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex min-h-8 items-center rounded-control px-2 text-sm text-accent transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => changeMode('create')}
          >
            Create a new account
          </button>
        </div>
      )}
    </form>
  )
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
