import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from '../../lib/lazy-motion'
import { motionDurations, motionOffsets, transitions } from '../../lib/motion'
import { describeError } from '../../lib/errors'
import { Button } from '../ui/Button'
import type { OnboardingFlowProps } from './types'
import { Eyebrow, StateTick, rowNumber } from '../ui/QuietStructure'

type IdentityScreenProps = Pick<OnboardingFlowProps, 'onGenerateIdentity'> & {
  backendKind?: 'matrix' | 'legacy-p2p'
  onNext: () => void
}

const WAIT_MS = 950

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

export function IdentityScreen({ onGenerateIdentity, onNext }: IdentityScreenProps) {
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [detail, setDetail] = useState('Preparing your account')
  const generateIdentityRef = useRef(onGenerateIdentity)

  const steps = useMemo(
    () => ['Setting up your account', 'Securing this device', 'Finishing'],
    []
  )

  useEffect(() => {
    generateIdentityRef.current = onGenerateIdentity
  }, [onGenerateIdentity])

  useEffect(() => {
    let alive = true

    const run = async () => {
      setPhase('running')
      setDetail('Preparing your account')

      try {
        const work = generateIdentityRef.current?.() ?? Promise.resolve()
        await Promise.all([work, wait(WAIT_MS)])
        if (!alive) return
        setDetail('This device is ready')
        setPhase('done')
      } catch (error) {
        if (!alive) return
        console.error('Unable to create identity:', error)
        const description = describeError(error, { operation: 'set up your account' })
        setPhase('error')
        // `body` already opens with what failed, so prefixing the title
        // repeated the same thing in a shorter sentence first.
        setDetail(description.body)
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
        <Eyebrow className="block">Step 1 of 3</Eyebrow>
        {/*
          The one poster-scale heading in the product. The file has said so in a
          comment since it was written; this is the size that makes it true.
        */}
        <h1 className="text-display-lg font-semibold text-on-surface">
          Welcome to Mesh
        </h1>
        <p className="max-w-sm text-body-sm text-on-surface-variant">
          Mesh is securing this device automatically. You do not need to save or copy anything.
        </p>
      </div>

      {/*
        Key generation reads as a numbered ledger with a state tick per row.

        It was a bordered panel holding a percentage bar and three 
        pills, none of which said which step was actually running -- the first
        pill was highlighted whatever the phase was. A ledger says where you
        are because the ticks say it, and it uses the same mark the rest of the
        system already reads.
      */}
      <motion.ol
        className="border-y border-rule border-outline-variant"
        aria-label="Account setup"
        initial={{ opacity: 0, y: motionOffsets.subtle }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.enter}
      >
        {steps.map((step, index) => {
          const stepState = phase === 'error'
            ? index === 0 ? 'danger' : 'pending'
            : phase === 'done'
              ? 'ok'
              : index === 0 ? 'warning' : 'pending'
          return (
            <motion.li
              key={step}
              className="flex items-center gap-3 border-b border-rule border-outline-variant py-ledger last:border-b-0"
              initial={{ opacity: 0, y: motionOffsets.tight }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...transitions.enter, delay: index * motionDurations.press }}
            >
              <span
                aria-hidden="true"
                className="w-row-index flex-none text-label-sm font-semibold text-on-surface-variant"
              >
                {rowNumber(index)}
              </span>
              <StateTick
                state={stepState}
                label={stepState === 'ok' ? 'Done' : stepState === 'danger' ? 'Failed' : stepState === 'warning' ? 'Running' : 'Waiting'}
              />
              <span className="min-w-0 flex-1 truncate text-title-md text-on-surface">{step}</span>
            </motion.li>
          )
        })}
      </motion.ol>

      <div role="status" className="space-y-1">
        <p className="flex items-center gap-2 text-label-sm text-on-surface-variant">
          <span className="text-on-surface">{detail}</span>
          <span aria-hidden="true">·</span>
          {phase === 'done' ? 'Ready' : phase === 'error' ? 'Check' : 'Protected'}
        </p>
        {/*
          The completion sentence survives the panel it used to live in. A
          confirmation is not the norm restating itself: a person asked for
          this to be set up, and being told it worked is the answer to their
          own question.
        */}
        {phase === 'done' && (
          <p className="text-body-sm text-on-surface-variant">
            Account protection is ready. It works automatically on this device.
          </p>
        )}
      </div>

      {phase === 'done' ? (
        <Button onClick={onNext} className="w-full">
          Continue to profile
        </Button>
      ) : (
        <Button disabled className="w-full">
          {phase === 'error' ? 'Account setup failed' : 'Setting up your account...'}
        </Button>
      )}

      {phase === 'error' && (
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="min-h-8 rounded-full px-2 text-body-md text-on-surface-variant transition-colors hover:bg-state-hover hover:text-on-surface"
        >
          Try account setup again
        </button>
      )}
    </div>
  )
}
