import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import { IdentityScreen } from './IdentityScreen'
import { JoinScreen } from './JoinScreen'
import { ReadyScreen } from './ReadyScreen'
import { MatrixAccountScreen } from './MatrixAccountScreen'
import { variants } from '../../lib/motion'
import { DEFAULT_AVATAR_COLORS, type OnboardingFlowProps, type OnboardingProfile } from './types'

type Step = 'account' | 'identity' | 'profile' | 'bootstrap'

export function OnboardingFlow({
  onComplete,
  backendKind = 'matrix',
  backendAuthenticated = false,
  onMatrixLogin,
  onMatrixSwitchAccount,
  onGenerateIdentity,
  onUpdateProfile,
  onBootstrap,
  initialProfile,
  avatarColors = DEFAULT_AVATAR_COLORS,
}: OnboardingFlowProps) {
  const needsMatrixLogin = backendKind === 'matrix' && !backendAuthenticated
  const steps: Step[] = backendKind === 'matrix'
    ? needsMatrixLogin ? ['account', 'bootstrap'] : ['bootstrap']
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

  const currentIndex = steps.indexOf(step)

  return (
    <main className="min-h-screen bg-bg-tertiary px-6 py-6 md:px-8 md:py-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-[460px] items-center">
        <motion.div
          className="relative w-full overflow-hidden rounded-md bg-bg-secondary px-5 py-6 shadow-elevation-high md:px-8 md:py-8"
          variants={variants.screen}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <div aria-hidden="true" className="mb-8 flex gap-1.5">
            {steps.map((item, index) => (
              <div
                key={item}
                className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                  index <= currentIndex ? 'bg-blue' : 'bg-bg-modifier-hover'
                }`}
              />
            ))}
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {step === 'account' && (
              <motion.div key="account" variants={variants.screen} initial="initial" animate="animate" exit="exit">
                <MatrixAccountScreen
                  onMatrixLogin={onMatrixLogin}
                  onMatrixSwitchAccount={onMatrixSwitchAccount}
                  onNext={() => setStep('bootstrap')}
                />
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
