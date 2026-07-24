import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Button } from '../ui/Button'
import { transitions } from '../../lib/motion'
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
  const [hasErrored, setHasErrored] = useState(false)
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
    setHasErrored(false)
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
        setHasErrored(true)
        setState({
          phase: 'connecting',
          label: error instanceof Error ? error.message : 'Bootstrap failed',
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
    if (isDone && !hasErrored) {
      onComplete()
    }
  }, [isDone, hasErrored, onComplete])

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <p className="text-2xs uppercase tracking-[0.35em] text-muted">
          {backendKind === 'matrix' ? 'Account setup' : 'Step 3 of 3'}
        </p>
        <h1 className="text-[clamp(2rem,4vw,2.6rem)] font-semibold tracking-tight text-primary">
          {backendKind === 'matrix' ? 'Getting things ready' : 'Starting the network'}
        </h1>
        <p className="max-w-sm text-sm leading-6 text-secondary">
          {backendKind === 'matrix'
            ? 'Mesh is securely restoring your conversations. This usually takes only a moment.'
            : 'Mesh is waking up the peer network and syncing the first shared state.'}
        </p>
      </div>

      <motion.div
        className="space-y-5 rounded-lg bg-bg-primary p-5"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.softSpring}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-primary">{state.label}</p>
            <p className="text-2xs uppercase tracking-[0.3em] text-muted">
              {state.phase === 'ready' ? 'Complete' : 'In progress'}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold text-primary">{state.progress}%</p>
            <p className="text-2xs uppercase tracking-[0.3em] text-muted">Setup</p>
          </div>
        </div>

        <div className="h-1 overflow-hidden rounded-full bg-bg-modifier-hover">
          <motion.div
            className="h-full rounded-full bg-blue"
            animate={{ width: `${Math.max(12, state.progress)}%` }}
            transition={transitions.softSpring}
          />
        </div>

        <div className="grid gap-2 text-2xs uppercase tracking-[0.3em] text-muted">
          {(backendKind === 'matrix'
            ? ['Account secured', 'Service connected', 'Conversations ready']
            : ['Identity secured', 'Peers discovered', 'Channels synced']
          ).map((item, index) => (
            <motion.div
              key={item}
              className="flex items-center justify-between rounded-md bg-bg-modifier-hover px-3 py-2"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: index * 0.08 }}
            >
              <span>{item}</span>
              <span className={index < 2 || state.phase === 'ready' ? 'text-primary' : 'text-muted'}>
                {index < 2 || state.phase === 'ready' ? 'Done' : 'Queued'}
              </span>
            </motion.div>
          ))}
        </div>
      </motion.div>

      {hasErrored ? (
        <p className="text-sm text-red">Network bootstrap failed. Please try again.</p>
      ) : null}

      <Button
        disabled={!isDone || hasErrored}
        onClick={handleContinue}
        className="w-full"
      >
        {isDone && !hasErrored ? 'Open Mesh' : state.phase === 'ready' ? 'Finishing up...' : 'Connecting...'}
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
        {hasErrored && (
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
            className="text-sm text-secondary transition-colors hover:text-primary"
          >
            Retry bootstrap
          </button>
        )}
      </div>
    </div>
  )
}
