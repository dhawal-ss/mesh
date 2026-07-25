import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import clsx from 'clsx'
import { motionDurations, transitions } from '../../lib/motion'
import { describeError } from '../../lib/errors'
import { Button } from '../ui/Button'
import { useIdentityStore } from '../../store/identity'
import type { OnboardingFlowProps } from './types'

type IdentityScreenProps = Pick<OnboardingFlowProps, 'onGenerateIdentity'> & {
  backendKind?: 'matrix' | 'legacy-p2p'
  onNext: () => void
}

const WAIT_MS = 950

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

function formatFingerprint(publicKey?: string) {
  if (!publicKey) {
    return 'Pending'
  }

  return `${publicKey.slice(0, 6)}...${publicKey.slice(-6)}`
}

export function IdentityScreen({ backendKind = 'matrix', onGenerateIdentity, onNext }: IdentityScreenProps) {
  const identity = useIdentityStore((s) => s.identity)
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [detail, setDetail] = useState('Preparing a local identity')

  const steps = useMemo(
    () => ['Creating local keys', 'Locking identity to this device', 'Finishing'],
    []
  )

  useEffect(() => {
    let alive = true

    const run = async () => {
      setPhase('running')
      setDetail('Preparing a local identity')

      try {
        const existing = useIdentityStore.getState().identity
        if (existing?.publicKey) {
          setDetail('Device key already exists')
          setPhase('done')
          return
        }

        const work = onGenerateIdentity?.() ?? Promise.resolve()
        await Promise.all([work, wait(WAIT_MS)])
        if (!alive) return
        setDetail('Device key created')
        setPhase('done')
      } catch (error) {
        if (!alive) return
        console.error('Unable to create identity:', error)
        const description = describeError(error, { operation: 'create your local identity' })
        setPhase('error')
        setDetail(`${description.title}. ${description.body}`)
      }
    }

    void run()

    return () => {
      alive = false
    }
  }, [attempt])

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <p className="text-2xs uppercase tracking-eyebrow text-muted">Step 1 of 3</p>
        <h1 className="text-lg font-semibold tracking-tight text-primary">
          Welcome to Mesh
        </h1>
        <p className="max-w-sm text-sm leading-6 text-secondary">
          {backendKind === 'matrix'
            ? 'We are creating a local migration key. Your Matrix account and revocable devices remain authoritative.'
            : 'We are creating your peer identity locally. Nothing leaves this device.'}
        </p>
      </div>

      <motion.div
        className="overflow-hidden rounded-lg bg-bg-primary p-4"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.enter}
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <span className="text-sm font-medium text-primary">{detail}</span>
          <span className="text-2xs uppercase tracking-section text-muted">
            {phase === 'done' ? 'Created' : phase === 'error' ? 'Check' : 'Private'}
          </span>
        </div>

        <div className="h-1 overflow-hidden rounded-full bg-bg-modifier-hover">
          <motion.div
            className="h-full w-1/3 rounded-full bg-blue"
            animate={
              phase === 'done'
                ? { x: ['-20%', '120%'], opacity: [0.45, 0.95] }
                : { x: ['-35%', '115%'] }
            }
            transition={
              phase === 'done'
                ? transitions.celebration
                : transitions.ambientLoop
            }
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {steps.map((step, index) => (
            <motion.span
              key={step}
              className={clsx(
                'rounded-md px-2.5 py-1 text-2xs uppercase tracking-control',
                index === 0
                  ? 'bg-bg-modifier-hover text-secondary'
                  : 'text-muted'
              )}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...transitions.enter, delay: index * motionDurations.stagger }}
            >
              {step}
            </motion.span>
          ))}
        </div>

        {phase === 'done' && (
          <motion.div
            className="mt-5 rounded-lg bg-green/10 border border-green/20 p-4"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={transitions.enter}
          >
            <p className="text-2xs uppercase tracking-status text-muted">Device key created</p>
            <p className="mt-2 text-sm text-primary">
              {backendKind === 'matrix'
                ? 'This key stays on this device as legacy migration metadata; Matrix device keys protect room activity.'
                : 'This identity now lives on this device and will sign your peer activity locally.'}
            </p>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-bg-tertiary px-3 py-2">
              <span className="text-2xs uppercase tracking-section text-muted">Fingerprint</span>
              <span className="font-mono text-xs text-primary">{formatFingerprint(identity?.publicKey)}</span>
            </div>
          </motion.div>
        )}
      </motion.div>

      {phase === 'done' ? (
        <Button onClick={onNext} className="w-full">
          Continue to profile
        </Button>
      ) : (
        <Button disabled className="w-full">
          {phase === 'error' ? 'Identity creation failed' : 'Creating your device key...'}
        </Button>
      )}

      {phase === 'error' && (
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="text-sm text-secondary transition-colors hover:text-primary"
        >
          Retry identity generation
        </button>
      )}
    </div>
  )
}
