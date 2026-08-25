import { AnimatePresence, motion } from '../../lib/lazy-motion'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { MatrixAccountScreen, type MatrixAccountOutcome } from './MatrixAccountScreen'
import { Spinner } from '../ui/Spinner'
import { PixelMark } from '../ui/PixelMark'
import { Eyebrow } from '../ui/QuietStructure'
import { variants } from '../../lib/motion'
import { DEFAULT_AVATAR_COLORS, type OnboardingFlowProps, type OnboardingProfile } from './types'
import { InvitationDestinationCard } from './InvitationConfirmation'

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
type Step = 'account' | 'identity' | 'profile' | 'bootstrap'

const STEP_LABELS: Record<Step, string> = {
  account: 'Account',
  identity: 'Device setup',
  profile: 'Profile',
  bootstrap: 'Ready',
}


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
  onBackupSkipped,
  onGenerateIdentity,
  onUpdateProfile,
  onBootstrap,
  initialPendingInvitation,
  initialProfile,
  avatarColors = DEFAULT_AVATAR_COLORS,
}: OnboardingFlowProps) {
  const needsMatrixLogin = backendKind === 'matrix' && !backendAuthenticated
  const steps = useMemo<Step[]>(
    () => backendKind === 'matrix'
      ? needsMatrixLogin
        ? ['account', 'bootstrap']
        : ['bootstrap']
      : ['identity', 'profile', 'bootstrap'],
    [backendKind, needsMatrixLogin],
  )
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
  /*
   * `steps` is derived from props, so signing in elsewhere can drop the step
   * the flow is standing on. `indexOf` then returned -1, which rendered
   * "Step 1 of 1" with no segment marked at all. Put the flow back on a step
   * that exists, and clamp for the render that happens before the effect runs.
   */
  useEffect(() => {
    if (steps.includes(step)) return
    const fallback = steps[0]
    if (fallback) setStep(fallback)
  }, [step, steps])
  const currentIndex = Math.max(steps.indexOf(step), 0)

  const handleMatrixAccount = (outcome: MatrixAccountOutcome) => {
    if (outcome === 'registered') onBackupSkipped?.()
    setStep('bootstrap')
  }

  const invitationCommunity = initialPendingInvitation?.communityName?.trim()
    || 'your community'

  /*
   * The rail earns its place only when there is a road to be partway along.
   * On the Matrix path setup is one real question followed by a completion
   * screen, and a segmented "Step 1 of 2" over that reported progress through
   * something nobody experienced as a journey. It stays for the longer legacy
   * path, where there genuinely are three.
   */
  const showProgress = steps.length > 2

  /*
   * The shell centres with `my-auto` inside a row-direction flex parent rather
   * than `items-center`. A centred flex item taller than its container
   * overflows past the top edge, where nothing can scroll to it, which cut the
   * head off the sign-in form on a short window. Automatic margins collapse
   * instead of clipping.
   */
  return (
    <main className="mesh-onboarding-root flex min-h-screen justify-center overflow-y-auto bg-surface-sunken p-6">
      <motion.section
        aria-label="Set up Mesh"
        data-onboarding-shell
        className="mesh-onboarding-shell mx-auto my-auto flex h-fit w-full max-w-onboarding-shell flex-col rounded-panel border border-border-subtle bg-surface-base px-8 py-10 shadow-overlay sm:px-12 sm:py-12"
        variants={variants.screen}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        <div className="mesh-onboarding-content flex min-h-0 min-w-0 flex-col">
          {/*
            One mark, no wordmark stack and no tagline. This screen already
            says Mesh in its heading, and a brand lockup that repeats it was
            the first of three places the product introduced itself before
            asking anything.
          */}
          <span
            role="img"
            aria-label="Mesh"
            className="mesh-pixel-brand mb-9 flex h-11 w-11 items-center justify-center"
          >
            <PixelMark variant="brand" className="h-11 w-11" />
          </span>

          {initialPendingInvitation ? (
            <div className="mesh-onboarding-invitation-destination mb-5 flex-none">
              <InvitationDestinationCard pending={initialPendingInvitation} compact />
            </div>
          ) : null}
          {showProgress ? (
            <div className="mb-4 flex-none">
              <div className="flex items-center justify-between gap-4">
                <Eyebrow>
                  {initialPendingInvitation ? 'Invitation progress' : 'Setup progress'}
                </Eyebrow>
                <p className="font-mono text-eyebrow uppercase text-content-secondary" aria-live="polite">
                  Step {currentIndex + 1} of {steps.length}
                </p>
              </div>
              <ol aria-label="Setup progress" className="mt-3 grid grid-flow-col auto-cols-fr gap-2">
                {steps.map((item, index) => {
                  const complete = index < currentIndex
                  const current = index === currentIndex
                  return (
                    <li key={item} aria-current={current ? 'step' : undefined} className="min-w-0">
                      {/*
                        * Done and here used to render identically, so the rail
                        * could say how far you had come but not where you were.
                        * Here is the accent at full strength; done is the muted
                        * accent, which is the token for a weaker accent and
                        * avoids inventing an opacity. Both are 2px: the rail
                        * reads as one continuous rule across the three steps,
                        * and the thickness is the vocabulary rather than the
                        * state.
                        */}
                      <span
                        className={`block h-trust-rail w-full rounded-plane transition-colors duration-normal ${
                          current ? 'bg-accent' : complete ? 'bg-accent-muted' : 'bg-surface-fill-hover'
                        }`}
                      />
                      <span
                        className={`sr-only font-mono text-eyebrow uppercase sm:not-sr-only sm:mt-2 sm:block sm:truncate ${
                          current
                            ? 'font-medium text-content-primary'
                            : 'text-content-secondary'
                        }`}
                      >
                        {STEP_LABELS[item]}
                      </span>
                    </li>
                  )
                })}
              </ol>
            </div>
          ) : null}

          <div ref={stepContentRef} className="mesh-onboarding-scroll w-full">
            <Suspense
              fallback={
                <div
                  className="flex min-h-64 flex-col items-center justify-center gap-3 text-center"
                  role="status"
                  aria-label="Loading setup step"
                >
                  <Spinner />
                  <p className="text-sm font-semibold text-primary">
                    {initialPendingInvitation
                      ? `Keeping ${invitationCommunity} ready`
                      : 'Opening account setup'}
                  </p>
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
                      hideInvitationSummary={Boolean(initialPendingInvitation)}
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

