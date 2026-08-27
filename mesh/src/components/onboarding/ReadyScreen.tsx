import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from '../../lib/lazy-motion'
import { Button } from '../ui/Button'
import { ErrorState } from '../ui/ErrorState'
import { motionDurations, motionOffsets, transitions } from '../../lib/motion'
import type { BootstrapState, OnboardingFlowProps } from './types'

interface ReadyScreenProps {
  backendKind?: 'matrix' | 'legacy-p2p'
  onComplete: () => void
  onBootstrap?: OnboardingFlowProps['onBootstrap']
  onBack?: () => void
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))
export const MATRIX_READY_AUTO_CONTINUE_MS = 500

export function ReadyScreen({ backendKind = 'matrix', onComplete, onBootstrap, onBack }: ReadyScreenProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<BootstrapState>({
    phase: 'connecting',
    label: 'Connecting to Mesh',
    progress: 24,
  })
  const [failure, setFailure] = useState<unknown | null>(null)
  const [isDone, setIsDone] = useState(false)
  const completedRef = useRef(false)
  const completedSteps =
    state.phase === 'ready'
      ? 3
      : state.phase === 'finalizing'
        ? 2
        : state.phase === 'syncing'
          ? 1
          : 0

  const timeline = useMemo(
    () => [
      { phase: 'connecting' as const, label: 'Connecting to Mesh', progress: 24, delay: 280 },
      { phase: 'syncing' as const, label: 'Getting your conversations', progress: 68, delay: 760 },
      { phase: 'finalizing' as const, label: 'Finishing setup', progress: 92, delay: 1180 },
      { phase: 'ready' as const, label: 'Ready', progress: 100, delay: 1480 },
    ],
    []
  )

  useEffect(() => {
    let alive = true

    const run = async () => {
      await Promise.resolve()
      if (!alive) return
      setFailure(null)
      setIsDone(false)
      setState({
        phase: 'connecting',
        label: 'Connecting to Mesh',
        progress: 24,
      })
      try {
        if (onBootstrap) {
          await onBootstrap((nextState) => {
            if (alive) setState(nextState)
          })
        } else {
          for (const entry of timeline) {
            if (!alive) return
            await wait(entry.delay)
            if (!alive) return
            setState(entry)
          }
        }

        if (!alive) return
        setState({ phase: 'ready', label: 'Ready', progress: 100 })
        setIsDone(true)
      } catch (error) {
        if (!alive) return
        setFailure(error)
        setState({
          phase: 'connecting',
          label: 'Setup interrupted',
          progress: 0,
        })
      }
    }

    void run()

    return () => {
      alive = false
    }
  }, [attempt, backendKind, onBootstrap, timeline])

  const handleContinue = useCallback(() => {
    if (isDone && !failure && !completedRef.current) {
      completedRef.current = true
      onComplete()
    }
  }, [isDone, failure, onComplete])

  useEffect(() => {
    if (backendKind !== 'matrix' || !isDone || failure || completedRef.current) return
    const timer = window.setTimeout(handleContinue, MATRIX_READY_AUTO_CONTINUE_MS)
    return () => window.clearTimeout(timer)
  }, [backendKind, failure, handleContinue, isDone])

  const primaryAction = (
    <Button
      disabled={!isDone || !!failure}
      onClick={handleContinue}
      className="w-full"
    >
      {isDone && !failure ? 'Open Mesh' : state.phase === 'ready' ? 'Finishing up...' : 'Connecting...'}
    </Button>
  )

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">
          {backendKind === 'matrix' ? 'Account setup' : 'Step 3 of 3'}
        </p>
        <h1 className="text-headline-md font-semibold text-on-surface">
          Getting things ready
        </h1>
      </div>

      {isDone && !failure ? primaryAction : null}

      <motion.div
        className="space-y-5 rounded-xl border border-outline-variant bg-surface-container-lowest p-5"
        initial={{ y: motionOffsets.subtle }}
        animate={{ y: 0 }}
        transition={transitions.enter}
      >
        <div
          className="flex items-center justify-between gap-4"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="space-y-1">
            <p className="text-body-md font-medium text-on-surface">{state.label}</p>
            <p className="text-label-sm lowercase tracking-label-md text-on-surface-variant">
              {state.phase === 'ready' ? 'Complete' : 'In progress'}
            </p>
          </div>
          <div className="text-right">
            <p className="text-headline-md font-semibold text-on-surface">{state.progress}%</p>
            <p className="text-label-sm lowercase tracking-label-md text-on-surface-variant">Setup</p>
          </div>
        </div>

        <div
          className="h-1 overflow-hidden rounded-xl bg-surface-container-high"
          role="progressbar"
          aria-label="Mesh setup progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.progress}
          aria-valuetext={`${state.label}, ${state.progress}%`}
        >
          <motion.div
            className="h-full w-full origin-left rounded-xl bg-primary"
            animate={{ scaleX: Math.max(12, state.progress) / 100 }}
            transition={transitions.enter}
          />
        </div>

        {/* Bootstrap phases map one-to-one onto the three checklist rows. */}
        <div className="grid gap-2 text-label-sm lowercase tracking-label-md text-on-surface-variant">
          {['Signed in', 'Connected', 'Conversations ready'].map((item, index) => (
            <motion.div
              key={item}
              className="flex items-center justify-between rounded-full bg-surface-container-high px-3 py-2"
              initial={{ y: motionOffsets.tight }}
              animate={{ y: 0 }}
              transition={{ ...transitions.enter, delay: index * motionDurations.press }}
            >
              <span>{item}</span>
              {/*
                These rows previously read "Done" unconditionally for the first
                two entries, from the very first frame and before any bootstrap
                work had run. On a product whose whole pitch is trust, that is
                fabricated reassurance. Each row now reflects real progress.
              */}
              <span className={index < completedSteps ? 'text-on-surface' : 'text-on-surface-variant'}>
                {index < completedSteps
                  ? 'Done'
                  : index === completedSteps && !failure
                    ? 'Working'
                    : 'Queued'}
              </span>
            </motion.div>
          ))}
        </div>
      </motion.div>

      {failure ? (
        <ErrorState
          error={failure}
          context={{ operation: 'finish setting up your account' }}
          onAction={() => setAttempt((value) => value + 1)}
          actionLabel="Try again"
        />
      ) : null}

      {!isDone || failure ? primaryAction : null}

      <div className="flex items-center justify-between">
        {onBack && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
          >
            Back to profile
          </Button>
        )}
      </div>
    </div>
  )
}
