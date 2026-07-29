import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import { IdentityScreen } from './IdentityScreen'
import { JoinScreen } from './JoinScreen'
import { ReadyScreen } from './ReadyScreen'
import { MatrixAccountScreen, type MatrixAccountOutcome } from './MatrixAccountScreen'
import { BackupCodeScreen } from './BackupCodeScreen'
import { ErrorState } from '../ui/ErrorState'
import { Spinner } from '../ui/Spinner'
import { Icon, type IconName } from '../ui/Icon'
import { variants } from '../../lib/motion'
import { DEFAULT_AVATAR_COLORS, type OnboardingFlowProps, type OnboardingProfile } from './types'

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
  onCreateBackupCode,
  onBackupConfigured,
  onBackupSkipped,
  onGenerateIdentity,
  onUpdateProfile,
  onBootstrap,
  initialMatrixInvitation,
  initialProfile,
  avatarColors = DEFAULT_AVATAR_COLORS,
}: OnboardingFlowProps) {
  const needsMatrixLogin = backendKind === 'matrix' && !backendAuthenticated
  const [newAccount, setNewAccount] = useState(false)
  const steps: Step[] = backendKind === 'matrix'
    ? needsMatrixLogin
      ? newAccount ? ['account', 'backup', 'bootstrap'] : ['account', 'bootstrap']
      : ['bootstrap']
    : ['identity', 'profile', 'bootstrap']
  const [step, setStep] = useState<Step>(
    backendKind === 'matrix'
      ? needsMatrixLogin ? 'account' : 'bootstrap'
      : initialProfile ? 'profile' : 'identity',
  )
  const [profile, setProfile] = useState<OnboardingProfile>({
    displayName: initialProfile?.displayName ?? '',
    avatarColor: initialProfile?.avatarColor ?? avatarColors[0] ?? DEFAULT_AVATAR_COLORS[0],
  })
  const [backupCode, setBackupCode] = useState<string | null>(null)
  const [backupError, setBackupError] = useState<unknown | null>(null)
  const [preparingBackup, setPreparingBackup] = useState(false)

  const currentIndex = steps.indexOf(step)

  const prepareBackupCode = async () => {
    setPreparingBackup(true)
    setBackupError(null)
    try {
      if (!onCreateBackupCode) {
        throw new Error('Message backup is unavailable in this build.')
      }
      setBackupCode(await onCreateBackupCode())
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
    void prepareBackupCode()
  }

  return (
    <main className="flex h-screen flex-col overflow-y-auto bg-surface-sunken p-4 sm:px-6">
      <motion.section
        aria-label="Set up Mesh"
        data-onboarding-shell
        className="m-auto grid w-full max-w-onboarding-shell overflow-hidden rounded-panel border border-border-subtle bg-surface-base shadow-overlay lg:min-h-onboarding-shell lg:grid-cols-[minmax(17rem,0.78fr)_minmax(28rem,1.22fr)]"
        variants={variants.screen}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        <aside className="flex flex-col border-b border-border-subtle bg-surface-base px-5 py-5 sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-8 sm:px-8 sm:py-6 lg:flex lg:flex-col lg:items-stretch lg:gap-0 lg:border-b-0 lg:border-r lg:px-10 lg:py-8">
          <div className="flex items-center gap-3" aria-label="Mesh">
            <span className="flex h-9 w-9 items-center justify-center rounded-control bg-accent text-content-on-accent">
              <Icon name="shieldCheck" size="md" />
            </span>
            <span>
              <span className="block text-sm font-semibold tracking-tight text-content">Mesh</span>
              <span className="block text-caption uppercase tracking-section text-content-muted">
                Community messenger
              </span>
            </span>
          </div>

          <div className="mt-6 sm:mt-0 lg:mt-12">
            <p className="text-caption font-semibold uppercase tracking-eyebrow text-accent">
              Your account, your trust
            </p>
            <h2 className="mt-3 max-w-sm text-title font-semibold tracking-tight text-content lg:text-lg">
              Conversations that stay yours.
            </h2>
            <p className="mt-3 max-w-sm text-sm leading-6 text-content-secondary">
              Familiar rooms and messages, with protection, device trust, and recovery built into
              the experience.
            </p>
          </div>

          <div className="mt-8 hidden space-y-4 lg:block">
            {TRUST_CUES.map((cue) => (
              <TrustCue key={cue.title} {...cue} />
            ))}
          </div>

          <p className="mt-auto hidden pt-6 text-caption leading-5 text-content-muted lg:block">
            Mesh explains who can read a conversation and which devices need your attention.
          </p>
        </aside>

        <div className="flex min-w-0 flex-col bg-surface-raised px-5 py-4 sm:px-8 sm:py-5 lg:px-12">
          <div className="mb-4">
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
                  <li
                    key={item}
                    aria-current={current ? 'step' : undefined}
                    className="min-w-0"
                  >
                    <span
                      className={`block h-1 rounded-full transition-colors duration-normal ${
                        index <= currentIndex ? 'bg-accent' : 'bg-surface-active'
                      }`}
                    />
                    <span
                      className={`mt-2 hidden truncate text-caption sm:block ${
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

          <div className="my-auto w-full max-w-lg">
            <AnimatePresence mode="wait" initial={false}>
              {step === 'account' && (
                <motion.div key="account" variants={variants.screen} initial="initial" animate="animate" exit="exit">
                  <MatrixAccountScreen
                    initialInvitation={initialMatrixInvitation}
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
                <motion.div key="backup" variants={variants.screen} initial="initial" animate="animate" exit="exit">
                  {preparingBackup ? (
                    <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
                      <Spinner />
                      <p className="text-sm text-content-secondary">Preparing your backup code…</p>
                    </div>
                  ) : backupError != null || !backupCode ? (
                    <div className="space-y-4">
                      <h1 className="text-lg font-semibold text-content">Protect your messages</h1>
                      <ErrorState
                        error={backupError ?? new Error('The backup code could not be prepared.')}
                        context={{ operation: 'prepare your message backup' }}
                        onAction={() => void prepareBackupCode()}
                      />
                    </div>
                  ) : (
                    <BackupCodeScreen
                      backupCode={backupCode}
                      onCopy={(code) => navigator.clipboard.writeText(code)}
                      onSaveFile={saveBackupCodeFile}
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
                <motion.div key="identity" variants={variants.screen} initial="initial" animate="animate" exit="exit">
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
                <motion.div key="profile" variants={variants.screen} initial="initial" animate="animate" exit="exit">
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
                <motion.div key="bootstrap" variants={variants.screen} initial="initial" animate="animate" exit="exit">
                  <ReadyScreen
                    backendKind={backendKind}
                    onComplete={onComplete}
                    onBootstrap={onBootstrap}
                    onBack={backendKind === 'matrix' ? undefined : () => setStep('profile')}
                  />
                </motion.div>
              )}
            </AnimatePresence>
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
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-control bg-accent/10 text-accent">
        <Icon name={icon} size="sm" />
      </span>
      <span>
        <span className="block text-sm font-medium text-content">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-content-muted">{description}</span>
      </span>
    </div>
  )
}

function saveBackupCodeFile(backupCode: string): void {
  const blob = new Blob(
    [
      'Mesh backup code\n\n',
      `${backupCode}\n\n`,
      'Keep this file somewhere private. Anyone with this code can unlock your saved messages.\n',
    ],
    { type: 'text/plain;charset=utf-8' },
  )
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'mesh-backup-code.txt'
  link.click()
  URL.revokeObjectURL(url)
}
