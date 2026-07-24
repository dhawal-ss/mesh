import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import * as bridge from '../../lib/bridge'
import type { OnboardingFlowProps } from './types'
import {
  displayServiceAddress,
  friendlySignInError,
  recommendedServiceConfigError,
  resolveServiceAddress,
  serviceFromUsername,
  technicalSignInError,
  type MatrixSignInMode,
} from './matrixSignIn'

type MatrixAccountScreenProps = Pick<OnboardingFlowProps, 'onMatrixLogin' | 'onMatrixSwitchAccount'> & {
  onNext: () => void
  recommendedService?: string
  recommendedServiceName?: string
}

const CONFIGURED_SERVICE = import.meta.env.VITE_MESH_HOMESERVER?.trim()
const DEFAULT_RECOMMENDED_SERVICE = CONFIGURED_SERVICE || ''
const DEFAULT_RECOMMENDED_SERVICE_NAME = import.meta.env.VITE_MESH_SERVICE_NAME?.trim()
  || (CONFIGURED_SERVICE ? 'Mesh' : '')

export function MatrixAccountScreen({
  onMatrixLogin,
  onMatrixSwitchAccount,
  onNext,
  recommendedService = DEFAULT_RECOMMENDED_SERVICE,
  recommendedServiceName = DEFAULT_RECOMMENDED_SERVICE_NAME,
}: MatrixAccountScreenProps) {
  const recommendedServiceError = recommendedServiceConfigError(recommendedService)
  const hasRecommendedService = recommendedServiceError === null
  const recommendedServiceHost = displayServiceAddress(recommendedService)
  const recommendedServiceLabel = recommendedServiceName.trim() || recommendedServiceHost
  const recommendedServiceDescription = recommendedServiceLabel.toLocaleLowerCase() === recommendedServiceHost.toLocaleLowerCase()
    ? recommendedServiceLabel
    : `${recommendedServiceLabel} (${recommendedServiceHost})`
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [serviceAddress, setServiceAddress] = useState('')
  const [signInMode, setSignInMode] = useState<MatrixSignInMode>(
    hasRecommendedService ? 'recommended' : 'advanced',
  )
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [technicalError, setTechnicalError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [switchingProfile, setSwitchingProfile] = useState<string | null>(null)
  const [savedAccounts, setSavedAccounts] = useState<bridge.MatrixAccount[]>([])
  const [oidcStatus, setOidcStatus] = useState<bridge.MatrixOidcStatus | null>(null)
  const [checkingOidc, setCheckingOidc] = useState(false)
  const [browserSigningIn, setBrowserSigningIn] = useState(false)

  useEffect(() => {
    if (!bridge.isTauriRuntime()) return
    let active = true
    void bridge.matrixAccounts().then((accounts) => {
      if (active) setSavedAccounts(accounts)
    }).catch(() => {
      // A missing/corrupt account registry must never block password sign-in.
    })
    return () => {
      active = false
    }
  }, [])

  const inferredService = useMemo(() => serviceFromUsername(username), [username])
  const resolvedService = useMemo(
    () => resolveServiceAddress(signInMode, username, serviceAddress, recommendedService),
    [recommendedService, serviceAddress, signInMode, username],
  )

  useEffect(() => {
    if (
      signInMode !== 'recommended'
      || !resolvedService
      || !bridge.isTauriRuntime()
    ) return
    let active = true
    setCheckingOidc(true)
    setOidcStatus(null)
    void bridge.matrixOidcStatus(resolvedService).then((status) => {
      if (active) setOidcStatus(status)
    }).catch((cause) => {
      if (!active) return
      setError('Mesh could not prepare browser sign-in for this service.')
      setTechnicalError(technicalSignInError(cause))
    }).finally(() => {
      if (active) setCheckingOidc(false)
    })
    return () => {
      active = false
    }
  }, [resolvedService, signInMode])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!onMatrixLogin) {
      setError('Sign in is unavailable in this build.')
      return
    }
    setSubmitting(true)
    setError(null)
    setTechnicalError(null)
    try {
      await onMatrixLogin({
        homeserver: resolvedService,
        username: username.trim(),
        password,
        deviceName: 'Mesh Desktop',
      })
      setPassword('')
      onNext()
    } catch (cause) {
      setError(friendlySignInError(cause))
      setTechnicalError(technicalSignInError(cause))
    } finally {
      setSubmitting(false)
    }
  }

  const switchAccount = async (profileId: string) => {
    if (!onMatrixSwitchAccount) return
    setSwitchingProfile(profileId)
    setError(null)
    setTechnicalError(null)
    try {
      await onMatrixSwitchAccount(profileId)
      onNext()
    } catch (cause) {
      setError(friendlySignInError(cause))
      setTechnicalError(technicalSignInError(cause))
    } finally {
      setSwitchingProfile(null)
    }
  }

  const checkBrowserSignIn = async () => {
    setCheckingOidc(true)
    setOidcStatus(null)
    setError(null)
    setTechnicalError(null)
    try {
      setOidcStatus(await bridge.matrixOidcStatus(resolvedService))
    } catch (cause) {
      setError('Mesh could not check browser sign-in for this service.')
      setTechnicalError(technicalSignInError(cause))
    } finally {
      setCheckingOidc(false)
    }
  }

  const startBrowserSignIn = async () => {
    if (!oidcStatus?.ready) return
    setBrowserSigningIn(true)
    setError(null)
    setTechnicalError(null)
    try {
      await bridge.matrixStartOidcLogin(resolvedService)
      onNext()
    } catch (cause) {
      setError(friendlySignInError(cause))
      setTechnicalError(technicalSignInError(cause))
    } finally {
      setBrowserSigningIn(false)
    }
  }

  return (
    <form className="space-y-6" onSubmit={submit}>
      <div className="space-y-3">
        <p className="text-2xs uppercase tracking-[0.35em] text-muted">Mesh</p>
        <h1 className="text-[clamp(2rem,4vw,2.6rem)] font-semibold tracking-tight text-primary">
          Welcome back
        </h1>
        <p className="max-w-sm text-sm leading-6 text-secondary">
          Sign in to see your conversations and start talking with your friends.
        </p>
      </div>

      {savedAccounts.length > 0 && (
        <section aria-label="Saved accounts" className="space-y-2 rounded-lg border border-bg-modifier-active p-3">
          <p className="text-2xs uppercase tracking-[0.25em] text-muted">Saved on this device</p>
          {savedAccounts.map((account) => (
            <button
              key={account.profileId}
              type="button"
              disabled={submitting || switchingProfile !== null}
              className="flex w-full items-center justify-between gap-3 rounded-md bg-bg-primary px-3 py-2 text-left transition-colors hover:bg-bg-modifier-hover disabled:cursor-wait disabled:opacity-60"
              onClick={() => void switchAccount(account.profileId)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-primary">{account.userId}</span>
                <span className="block truncate text-xs text-muted">{account.homeserver}</span>
              </span>
              <span className="text-xs text-blue">
                {switchingProfile === account.profileId ? 'Opening…' : 'Continue'}
              </span>
            </button>
          ))}
        </section>
      )}

      <div className="space-y-4 rounded-lg bg-bg-primary p-5">
        <section aria-label="Browser sign-in" className="space-y-3 rounded-md border border-bg-modifier-active p-3">
          <div>
            <p className="text-xs font-semibold text-primary">Private browser sign-in</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Mesh checks your provider's OAuth metadata and requires authorization code, refresh tokens,
              and S256 PKCE. Secrets and authorization responses stay inside the desktop app.
            </p>
          </div>
          {signInMode === 'recommended' && (
            <p className="text-xs leading-5 text-muted">
              Continue through {recommendedServiceDescription}. No server setup or Matrix ID is needed.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={
                checkingOidc
                || browserSigningIn
                || !oidcStatus?.ready
                || !resolvedService
                || !bridge.isTauriRuntime()
              }
              onClick={() => void startBrowserSignIn()}
            >
              {browserSigningIn
                ? 'Waiting for browser…'
                : checkingOidc
                  ? 'Preparing sign-in…'
                  : signInMode === 'recommended'
                    ? 'Continue with Mesh'
                    : 'Continue in browser'}
            </Button>
            {browserSigningIn && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void bridge.matrixCancelLogin()}
              >
                Cancel
              </Button>
            )}
            {signInMode === 'advanced' && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={checkingOidc || browserSigningIn || !resolvedService || !bridge.isTauriRuntime()}
                onClick={() => void checkBrowserSignIn()}
              >
                {checkingOidc ? 'Checking provider…' : 'Check browser sign-in'}
              </Button>
            )}
          </div>
          {!bridge.isTauriRuntime() && (
            <p className="text-xs text-muted">Browser sign-in is available in the installed desktop app.</p>
          )}
          {oidcStatus && (
            <div
              role="status"
              className={`rounded-md border px-3 py-2 text-xs leading-5 ${
                oidcStatus.ready
                  ? 'border-green/30 bg-green/5 text-green'
                  : 'border-yellow/30 bg-yellow/5 text-yellow'
              }`}
            >
              <p className="font-semibold">
                {oidcStatus.ready ? 'Browser sign-in is ready' : 'Browser sign-in is unavailable'}
              </p>
              <p className="mt-1">{oidcStatus.reason}</p>
              {oidcStatus.issuer && (
                <p className="mt-1 break-all text-muted">Issuer: {oidcStatus.issuer}</p>
              )}
            </div>
          )}
          {signInMode === 'recommended' && (
            <button
              type="button"
              className="text-left text-xs text-blue transition-colors hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue"
              onClick={() => {
                setSignInMode('advanced')
                setOidcStatus(null)
                setError(null)
                setTechnicalError(null)
              }}
            >
              Advanced: use an existing account password or another Matrix homeserver
            </button>
          )}
        </section>

        {signInMode === 'advanced' && (
          <>
        <div className="flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-bg-modifier-active" />
          <span className="text-2xs uppercase tracking-[0.25em] text-muted">Existing account password</span>
          <span className="h-px flex-1 bg-bg-modifier-active" />
        </div>

        <Input
          label="Username"
          name="username"
          value={username}
          onChange={setUsername}
          placeholder="@you:example.org"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
        />
        <div className="space-y-2">
          <Input
            label="Password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            required
          />
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={showPassword}
              onChange={(event) => setShowPassword(event.target.checked)}
              className="h-4 w-4 accent-blue"
            />
            Show password
          </label>
        </div>

        <div className="space-y-2 rounded-md border border-bg-modifier-active p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-primary">Advanced connection</p>
                <p className="mt-1 text-xs leading-5 text-muted">
                  {hasRecommendedService
                    ? 'For accounts hosted by another Matrix provider or your own server.'
                    : 'Use your Matrix ID or enter the homeserver that hosts your existing account.'}
                </p>
              </div>
              {hasRecommendedService && (
                <button
                  type="button"
                  className="shrink-0 text-xs text-blue transition-colors hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue"
                  onClick={() => {
                    setSignInMode('recommended')
                    setError(null)
                    setTechnicalError(null)
                  }}
                >
                  Use recommended
                </button>
              )}
            </div>
            {!hasRecommendedService && (
              <p role="status" className="rounded-md border border-yellow/30 bg-yellow/5 px-3 py-2 text-xs leading-5 text-yellow">
                Recommended sign-in is unavailable. {recommendedServiceError}
              </p>
            )}
            <Input
              label="Homeserver address"
              name="homeserver"
              type="text"
              value={serviceAddress}
              onChange={setServiceAddress}
              placeholder="chat.example.com or localhost:8008"
              autoCapitalize="none"
              spellCheck={false}
            />
            <p className="text-xs leading-5 text-muted">
              {inferredService
                ? `Leave this blank to discover ${inferredService} from your Matrix ID.`
                : 'Enter a secure domain such as chat.example.com, or use a full Matrix ID such as @you:example.com.'}
            </p>
        </div>

        <p className="text-xs leading-5 text-muted">
          Your session is stored securely on this device. Messages in encrypted conversations are end-to-end encrypted.
        </p>
          </>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          <p>{error}</p>
          {signInMode === 'advanced' && technicalError && technicalError !== error && (
            <details className="mt-2 text-xs text-muted">
              <summary className="cursor-pointer">Technical details</summary>
              <p className="mt-1 break-words font-mono">{technicalError}</p>
            </details>
          )}
        </div>
      )}

      {signInMode === 'advanced' && (
        <div className="flex gap-2">
        <Button
          type="submit"
          disabled={submitting || switchingProfile !== null || !resolvedService || !username.trim() || !password}
          className="flex-1"
        >
          {submitting
            ? 'Signing you in…'
            : 'Sign in with Matrix'}
        </Button>
        {submitting && bridge.isTauriRuntime() && (
          <Button type="button" variant="secondary" onClick={() => void bridge.matrixCancelLogin()}>
            Cancel
          </Button>
        )}
        </div>
      )}
    </form>
  )
}
