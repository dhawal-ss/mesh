import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import { IdentityScreen } from './IdentityScreen'
import { JoinScreen } from './JoinScreen'
import { ReadyScreen } from './ReadyScreen'
import { MatrixAccountScreen, type MatrixAccountOutcome } from './MatrixAccountScreen'
import { BackupCodeScreen } from './BackupCodeScreen'
import { ErrorState } from '../ui/ErrorState'
import { Spinner } from '../ui/Spinner'
import { variants } from '../../lib/motion'
import { DEFAULT_AVATAR_COLORS, type OnboardingFlowProps, type OnboardingProfile } from './types'

type Step = 'account' | 'identity' | 'profile' | 'backup' | 'bootstrap'

export function OnboardingFlow({
  onComplete,
  backendKind = 'matrix',
  backendAuthenticated = false,
  onMatrixCheckUsernameAvailable,
  onMatrixRegisterAccount,
  onMatrixLogin,
  onMatrixSwitchAccount,
  onCreateBackupCode,
  onBackupConfigured,
  onBackupSkipped,
  onGenerateIdentity,
  onUpdateProfile,
  onBootstrap,
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
    <main className="min-h-screen bg-bg-tertiary px-6 py-6 md:px-8 md:py-8">
      <div className="mx-auto flex min-h-onboarding-shell w-full max-w-onboarding-shell items-center">
        <motion.div
          className="relative w-full overflow-hidden rounded-md bg-bg-secondary px-5 py-6 shadow-overlay md:px-8 md:py-8"
          variants={variants.screen}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <div aria-hidden="true" className="mb-8 flex gap-1.5">
            {steps.map((item, index) => (
              <div
                key={item}
                className={`h-1 flex-1 rounded-full transition-colors duration-normal ${
                  index <= currentIndex ? 'bg-accent' : 'bg-bg-modifier-hover'
                }`}
              />
            ))}
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {step === 'account' && (
              <motion.div key="account" variants={variants.screen} initial="initial" animate="animate" exit="exit">
                <MatrixAccountScreen
                  onMatrixCheckUsernameAvailable={onMatrixCheckUsernameAvailable}
                  onMatrixRegisterAccount={onMatrixRegisterAccount}
                  onMatrixLogin={onMatrixLogin}
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
        </motion.div>
      </div>
    </main>
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
