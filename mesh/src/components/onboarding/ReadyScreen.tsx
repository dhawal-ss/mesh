import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Button } from '../ui/Button'
import { ErrorState } from '../ui/ErrorState'
import { motionDurations, transitions } from '../../lib/motion'
import type { BootstrapState, OnboardingFlowProps } from './types'

interface ReadyScreenProps {
  backendKind?: 'matrix' | 'legacy-p2p'
  onComplete: () => void
  onBootstrap?: OnboardingFlowProps['onBootstrap']
  onBack?: () => void
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

export function ReadyScreen({ backendKind = 'matrix', onComplete, onBootstrap, onBack }: ReadyScreenProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<BootstrapState>({
    phase: 'connecting',
    label: backendKind === 'matrix' ? 'Connecting to Mesh' : 'Finding nearby peers',
    progress: 24,
  })
  const [failure, setFailure] = useState<unknown | null>(null)
  const [isDone, setIsDone] = useState(false)

  const timeline = useMemo(
    () => [
      { phase: 'connecting' as const, label: backendKind === 'matrix' ? 'Connecting to Mesh' : 'Finding nearby peers', progress: 24, delay: 280 },
      { phase: 'syncing' as const, label: backendKind === 'matrix' ? 'Getting your conversations' : 'Syncing channels', progress: 68, delay: 760 },
      { phase: 'finalizing' as const, label: 'Finishing setup', progress: 92, delay: 1180 },
      { phase: 'ready' as const, label: 'Ready', progress: 100, delay: 1480 },
    ],
    [backendKind]
  )

  useEffect(() => {
    let alive = true
    setFailure(null)
    setIsDone(false)
    setState({
      phase: 'connecting',
      label: backendKind === 'matrix' ? 'Connecting to Mesh' : 'Finding nearby peers',
      progress: 24,
    })

    const run = async () => {
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
  }, [attempt, onBootstrap, timeline])

  const handleContinue = useCallback(() => {
    if (isDone && !failure) {
      onComplete()
    }
  }, [isDone, failure, onComplete])

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <p className="text-2xs uppercase tracking-eyebrow text-muted">
          {backendKind === 'matrix' ? 'Account setup' : 'Step 3 of 3'}
        </p>
        <h1 className="text-lg font-semibold tracking-tight text-primary">
          {backendKind === 'matrix' ? 'Getting things ready' : 'Starting the network'}
        </h1>
        <p className="max-w-sm text-sm leading-6 text-secondary">
          {backendKind === 'matrix'
            ? 'Mesh is loading your conversations. This usually takes only a moment.'
            : 'Mesh is waking up the peer network and syncing the first shared state.'}
        </p>
      </div>

      <motion.div
        className="space-y-5 rounded-lg bg-bg-primary p-5"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.enter}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-primary">{state.label}</p>
            <p className="text-2xs uppercase tracking-section text-muted">
              {state.phase === 'ready' ? 'Complete' : 'In progress'}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold text-primary">{state.progress}%</p>
            <p className="text-2xs uppercase tracking-section text-muted">Setup</p>
          </div>
        </div>

        <div className="h-1 overflow-hidden rounded-full bg-bg-modifier-hover">
          <motion.div
            className="h-full w-full origin-left rounded-full bg-blue"
            animate={{ scaleX: Math.max(12, state.progress) / 100 }}
            transition={transitions.enter}
          />
        </div>

        <div className="grid gap-2 text-2xs uppercase tracking-section text-muted">
          {(backendKind === 'matrix'
            ? ['Signed in', 'Service connected', 'Conversations ready']
            : ['Identity secured', 'Peers discovered', 'Channels synced']
          ).map((item, index) => (
            <motion.div
              key={item}
              className="flex items-center justify-between rounded-md bg-bg-modifier-hover px-3 py-2"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...transitions.enter, delay: index * motionDurations.staggerFast }}
            >
              <span>{item}</span>
              <span className={index < 2 || state.phase === 'ready' ? 'text-primary' : 'text-muted'}>
                {index < 2 || state.phase === 'ready' ? 'Done' : 'Queued'}
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
        />
      ) : null}

      <Button
        disabled={!isDone || !!failure}
        onClick={handleContinue}
        className="w-full"
      >
        {isDone && !failure ? 'Open Mesh' : state.phase === 'ready' ? 'Finishing up...' : 'Connecting...'}
      </Button>

      <div className="flex items-center justify-between">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-secondary transition-colors hover:text-primary"
          >
            &larr; Back to profile
          </button>
        )}
      </div>
    </div>
  )
}
