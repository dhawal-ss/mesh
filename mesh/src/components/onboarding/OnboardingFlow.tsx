import { AnimatePresence, motion } from '../../lib/lazy-motion'
import { lazy, Suspense, useRef, useState } from 'react'
import { MatrixAccountScreen, type MatrixAccountOutcome } from './MatrixAccountScreen'
import { Button } from '../ui/Button'
import { ErrorState } from '../ui/ErrorState'
import { Spinner } from '../ui/Spinner'
import { Icon, type IconName } from '../ui/Icon'
import { PixelMark } from '../ui/PixelMark'
import { variants } from '../../lib/motion'
import { DEFAULT_AVATAR_COLORS, type OnboardingFlowProps, type OnboardingProfile } from './types'
import type { MatrixRecoverySetupResult } from '../../types/ipc'

const IdentityScreen = lazy(() =>
  import('./IdentityScreen').then((module) => ({
    default: module.IdentityScreen,
  })),
)
const JoinScreen = lazy(() =>
  import('./JoinScreen').then((module) => ({ default: module.JoinScreen })),
)
const ReadyScreen = lazy(() =>
  import('./ReadyScreen').then((module) => ({ default: module.ReadyScreen })),
)
const BackupCodeScreen = lazy(() =>
  import('./BackupCodeScreen').then((module) => ({
    default: module.BackupCodeScreen,
  })),
)

type Step = 'account' | 'identity' | 'profile' | 'backup' | 'bootstrap'

const STEP_LABELS: Record<Step, string> = {
  account: 'Account',
  identity: 'Identity',
  profile: 'Profile',
  backup: 'Backup',
  bootstrap: 'Ready',
}

const TRUST_CUES: Array<{
  icon: IconName
  title: string
  description: string
}> = [
  {
    icon: 'lock',
    title: 'Protected from the first message',
    description: 'A conversation must be protected before Mesh will send or show messages.',
  },
  {
    icon: 'shieldCheck',
    title: 'Trust stays visible',
    description: 'Review every signed-in device and check new ones before relying on them.',
  },
  {
    icon: 'refresh',
    title: 'Recovery you control',
    description: 'Restore saved messages on another device with your private backup code.',
  },
]

export function OnboardingFlow({
  onComplete,
  backendKind = 'matrix',
  backendAuthenticated = false,
  onMatrixCheckUsernameAvailable,
  onMatrixRegisterAccount,
  onMatrixLogin,
  onMatrixOidcLogin,
  onMatrixSwitchAccount,
  onDiscardPendingInvitation,
  onCreateBackupCode,
  onBackupConfigured,
  onBackupSkipped,
  onGenerateIdentity,
  onUpdateProfile,
  onBootstrap,
  initialPendingInvitation,
  initialProfile,
  avatarColors = DEFAULT_AVATAR_COLORS,
}: OnboardingFlowProps) {
  const needsMatrixLogin = backendKind === 'matrix' && !backendAuthenticated
  const [newAccount, setNewAccount] = useState(false)
  const steps: Step[] =
    backendKind === 'matrix'
      ? needsMatrixLogin
        ? newAccount
          ? ['account', 'backup', 'bootstrap']
          : ['account', 'bootstrap']
        : ['bootstrap']
      : ['identity', 'profile', 'bootstrap']
  const [step, setStep] = useState<Step>(
    backendKind === 'matrix'
      ? needsMatrixLogin
        ? 'account'
        : 'bootstrap'
      : initialProfile
        ? 'profile'
        : 'identity',
  )
  const stepContentRef = useRef<HTMLDivElement>(null)
  const focusCurrentStepHeading = () => {
    const heading = stepContentRef.current?.querySelector<HTMLElement>('h1, [role="heading"]')
    if (!heading) return
    heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  }
  const [profile, setProfile] = useState<OnboardingProfile>({
    displayName: initialProfile?.displayName ?? '',
    avatarColor: initialProfile?.avatarColor ?? avatarColors[0] ?? DEFAULT_AVATAR_COLORS[0],
  })
  const [backupCode, setBackupCode] = useState<string | null>(null)
  const [backupSetup, setBackupSetup] = useState<MatrixRecoverySetupResult | null>(null)
  const [backupError, setBackupError] = useState<unknown | null>(null)
  const [preparingBackup, setPreparingBackup] = useState(false)
  /** True only after the user explicitly asks to enable recovery. */
  const [recoveryRequested, setRecoveryRequested] = useState(false)

  const currentIndex = steps.indexOf(step)

  const prepareBackupCode = async () => {
    setPreparingBackup(true)
    setBackupError(null)
    setBackupSetup(null)
    setBackupCode(null)
    try {
      if (!onCreateBackupCode) {
        throw new Error('Message backup is unavailable in this build.')
      }
      const setup = await onCreateBackupCode()
      setBackupSetup(setup)
      setBackupCode(setup.recoveryKey)
    } catch (error) {
      setBackupError(error)
    } finally {
      setPreparingBackup(false)
    }
  }

  const handleMatrixAccount = (outcome: MatrixAccountOutcome) => {
    if (outcome === 'signed-in') {
      setStep('bootstrap')
      return
    }
    setNewAccount(true)
    setStep('backup')
    /*
     * Deliberately does NOT call prepareBackupCode() here. Preparing the code
     * enables cross-signing recovery on the account, and doing that as a side
     * effect of navigation meant a user who then chose "Remind me later" ended
     * up in the worst possible state: the account believing it was
     * recoverable, with a key the human had never seen. Recovery is now
     * enabled only by the explicit action on the consent step below.
     */
  }

  return (
    <main className="mesh-onboarding-root h-screen overflow-hidden bg-surface-sunken p-3 sm:p-4">
      <motion.section
        aria-label="Set up Mesh"
        data-onboarding-shell
        className="mesh-onboarding-shell mx-auto grid h-full w-full max-w-onboarding-shell overflow-hidden rounded-panel border border-border-subtle bg-surface-base shadow-overlay lg:grid-cols-[minmax(18rem,0.76fr)_minmax(30rem,1.24fr)]"
        variants={variants.screen}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        <aside className="mesh-onboarding-aside flex flex-col border-b border-border-subtle bg-surface-base px-5 py-5 sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-8 sm:px-8 sm:py-6 lg:flex lg:flex-col lg:items-stretch lg:gap-0 lg:border-b-0 lg:border-r lg:px-10 lg:py-8">
          <div className="flex items-center gap-3" aria-label="Mesh">
            <span className="mesh-pixel-brand flex h-10 w-10 items-center justify-center text-accent">
              <PixelMark variant="brand" className="h-10 w-10" />
            </span>
            <span>
              <span className="block text-base font-semibold tracking-tight text-content">Mesh</span>
              <span className="block text-caption uppercase tracking-section text-content-muted">
                Private community chat
              </span>
            </span>
          </div>

          <div className="mt-6 sm:mt-0 lg:mt-14">
            <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">
              Your account, your trust
            </p>
            <h2 className="mt-3 max-w-sm text-title font-semibold tracking-tight text-content lg:text-lg">
              Conversations that stay yours.
            </h2>
            <p className="mt-3 max-w-sm text-sm leading-6 text-content-secondary">
              Familiar rooms and messages, with privacy and service choice built in from the
              beginning.
            </p>
          </div>

          <div className="mesh-onboarding-trust mt-9 hidden space-y-5 lg:block">
            {TRUST_CUES.map((cue) => (
              <TrustCue key={cue.title} {...cue} />
            ))}
          </div>

          <p className="mt-auto hidden pt-6 text-caption leading-5 text-content-muted lg:block">
            Mesh explains who can read a conversation and which devices need your attention.
          </p>
        </aside>

        <div className="mesh-onboarding-content flex min-h-0 min-w-0 flex-col bg-surface-raised px-5 py-4 sm:px-8 sm:py-5 lg:px-12">
          <div className="mb-4 flex-none">
            <div className="flex items-center justify-between gap-4">
              <p className="text-caption font-semibold uppercase tracking-section text-content-muted">
                Setup progress
              </p>
              <p className="text-caption text-content-secondary" aria-live="polite">
                Step {Math.max(currentIndex + 1, 1)} of {steps.length}
              </p>
            </div>
            <ol aria-label="Setup progress" className="mt-3 grid grid-flow-col auto-cols-fr gap-2">
              {steps.map((item, index) => {
                const complete = index < currentIndex
                const current = index === currentIndex
                return (
                  <li key={item} aria-current={current ? 'step' : undefined} className="min-w-0">
                    <span
                      className={`block h-1 rounded-full transition-colors duration-normal ${
                        index <= currentIndex ? 'bg-accent' : 'bg-surface-active'
                      }`}
                    />
                    <span
                      className={`sr-only text-caption sm:not-sr-only sm:mt-2 sm:block sm:truncate ${
                        current
                          ? 'font-medium text-content'
                          : complete
                            ? 'text-content-secondary'
                            : 'text-content-muted'
                      }`}
                    >
                      {STEP_LABELS[item]}
                    </span>
                  </li>
                )
              })}
            </ol>
          </div>

          <div ref={stepContentRef} className="mesh-onboarding-scroll my-auto w-full max-w-xl overflow-y-auto py-2 pr-1">
            <Suspense
              fallback={
                <div
                  className="flex min-h-64 items-center justify-center"
                  role="status"
                  aria-label="Loading setup step"
                >
                  <Spinner />
                </div>
              }
            >
              <AnimatePresence mode="wait" initial={false}>
                {step === 'account' && (
                  <motion.div
                    key="account"
                    variants={variants.screen}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    onAnimationComplete={focusCurrentStepHeading}
                  >
                    <MatrixAccountScreen
                      initialPendingInvitation={initialPendingInvitation}
                      onDiscardPendingInvitation={onDiscardPendingInvitation}
                      onMatrixCheckUsernameAvailable={onMatrixCheckUsernameAvailable}
                      onMatrixRegisterAccount={onMatrixRegisterAccount}
                      onMatrixLogin={onMatrixLogin}
                      onMatrixOidcLogin={onMatrixOidcLogin}
                      onMatrixSwitchAccount={onMatrixSwitchAccount}
                      onNext={handleMatrixAccount}
                    />
                  </motion.div>
                )}

                {step === 'backup' && (
                  <motion.div
                    key="backup"
                    variants={variants.screen}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    onAnimationComplete={focusCurrentStepHeading}
                  >
                    {!recoveryRequested ? (
                      <section aria-labelledby="recovery-consent-title" className="space-y-6">
                        <header className="space-y-2">
                          <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">
                            Protect your messages
                          </p>
                          <h1
                            id="recovery-consent-title"
                            className="text-lg font-semibold tracking-tight text-content"
                          >
                            Set up message recovery
                          </h1>
                          <p className="max-w-lg text-sm leading-6 text-content-secondary">
                            Your messages are locked so only you can read them: not even we can see
                            them. That also means that if you lose this device, there is no way back
                            into your history unless you set up recovery now.
                          </p>
                        </header>

                        <ul className="space-y-2 text-sm text-content-secondary">
                          <li>Mesh creates a one-time backup code that only you hold.</li>
                          <li>You save it somewhere safe, then confirm a few words of it.</li>
                          <li>You can turn recovery on later in Settings instead.</li>
                        </ul>

                        <div className="space-y-3">
                          <Button
                            className="w-full"
                            onClick={() => {
                              setRecoveryRequested(true)
                              void prepareBackupCode()
                            }}
                          >
                            Set up recovery
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="w-full"
                            onClick={() => {
                              onBackupSkipped?.()
                              setStep('bootstrap')
                            }}
                          >
                            Not now (you could lose your messages)
                          </Button>
                        </div>
                      </section>
                    ) : preparingBackup ? (
                      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
                        <Spinner />
                        <p className="text-sm text-content-secondary">
                          Preparing your backup code…
                        </p>
                      </div>
                    ) : backupError != null || !backupCode ? (
                      <div className="space-y-4">
                        <h1 className="text-lg font-semibold text-content">
                          Protect your messages
                        </h1>
                        <ErrorState
                          error={backupError ?? new Error('The backup code could not be prepared.')}
                          context={{ operation: 'prepare your message backup' }}
                          onAction={() => void prepareBackupCode()}
                        />
                      </div>
                    ) : (
                      <BackupCodeScreen
                        backupCode={backupCode}
                        secureStorageState={backupSetup?.secureStorageState}
                        verificationState={backupSetup?.verificationState}
                        onCopy={(code) => navigator.clipboard.writeText(code)}
                        onPrint={() => window.print()}
                        onContinue={() => {
                          onBackupConfigured?.()
                          setStep('bootstrap')
                        }}
                        onSkip={() => {
                          onBackupSkipped?.()
                          setStep('bootstrap')
                        }}
                      />
                    )}
                  </motion.div>
                )}

                {step === 'identity' && (
                  <motion.div
                    key="identity"
                    variants={variants.screen}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    onAnimationComplete={focusCurrentStepHeading}
                  >
                    <IdentityScreen
                      backendKind={backendKind}
                      onGenerateIdentity={async () => {
                        await onGenerateIdentity?.()
                      }}
                      onNext={() => setStep('profile')}
                    />
                  </motion.div>
                )}

                {step === 'profile' && (
                  <motion.div
                    key="profile"
                    variants={variants.screen}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    onAnimationComplete={focusCurrentStepHeading}
                  >
                    <JoinScreen
                      avatarColors={avatarColors}
                      initialProfile={profile}
                      onBack={() => setStep('identity')}
                      onNext={async (nextProfile) => {
                        setProfile(nextProfile)
                        await onUpdateProfile?.(nextProfile)
                        setStep('bootstrap')
                      }}
                    />
                  </motion.div>
                )}

                {step === 'bootstrap' && (
                  <motion.div
                    key="bootstrap"
                    variants={variants.screen}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    onAnimationComplete={focusCurrentStepHeading}
                  >
                    <ReadyScreen
                      backendKind={backendKind}
                      onComplete={onComplete}
                      onBootstrap={onBootstrap}
                      onBack={backendKind === 'matrix' ? undefined : () => setStep('profile')}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </Suspense>
          </div>
        </div>
      </motion.section>
    </main>
  )
}

function TrustCue({
  icon,
  title,
  description,
}: {
  icon: IconName
  title: string
  description: string
}) {
  return (
    <div className="flex gap-3.5">
      <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-control border border-border-subtle bg-surface-sunken text-accent">
        <Icon name={icon} size="sm" />
      </span>
      <span>
        <span className="block text-sm font-medium text-content">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-content-muted">{description}</span>
      </span>
    </div>
  )
}
