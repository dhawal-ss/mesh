import { useId, useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import type {
  MatrixRecoverySecureStorageState,
  MatrixRecoveryVerificationState,
} from '../../types/ipc'

export interface BackupCodeReminderSignal {
  kind: 'backup-code-reminder'
  recurringWarning: true
}

export interface BackupCodeScreenProps {
  backupCode: string
  secureStorageState?: MatrixRecoverySecureStorageState
  verificationState?: MatrixRecoveryVerificationState
  onCopy: (backupCode: string) => void | Promise<void>
  onPrint?: (backupCode: string) => void | Promise<void>
  onContinue: () => void
  onSkip: (signal: BackupCodeReminderSignal) => void
  challengeIndices?: readonly [number, number, number]
  embedded?: boolean
}

type ActionName = 'copy' | 'print'

export function BackupCodeScreen({
  backupCode,
  secureStorageState,
  verificationState,
  onCopy,
  onPrint,
  onContinue,
  onSkip,
  challengeIndices,
  embedded = false,
}: BackupCodeScreenProps) {
  const generatedId = useId()
  const titleId = `${generatedId}-title`
  const confirmationHelpId = `${generatedId}-confirmation-help`
  const segments = useMemo(() => backupSegments(backupCode), [backupCode])
  const challenge = useMemo(
    () =>
      validateChallenge(challengeIndices, segments.length) ??
      deterministicChallenge(backupCode, segments.length),
    [backupCode, challengeIndices, segments.length],
  )
  const [confirming, setConfirming] = useState(false)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [attempted, setAttempted] = useState(false)
  const [busyAction, setBusyAction] = useState<ActionName | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const complete = challenge.every(
    (index) => normalizeSegment(answers[index] ?? '') === normalizeSegment(segments[index]),
  )

  const runAction = async (
    actionName: ActionName,
    action: (code: string) => void | Promise<void>,
    successMessage: string,
  ) => {
    setBusyAction(actionName)
    setAnnouncement('')
    try {
      await action(backupCode)
      setAnnouncement(successMessage)
    } catch {
      setAnnouncement('That did not work. Try again.')
    } finally {
      setBusyAction(null)
    }
  }

  const submitConfirmation = () => {
    setAttempted(true)
    if (complete) onContinue()
  }

  return (
    /* Was <main>, nested inside the shell's own <main>: two main landmarks is
       invalid and broke landmark navigation on the most safety-critical screen. */
    <section aria-labelledby={titleId} className="space-y-6">
      <header className="space-y-2">
        {!embedded && (
          <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">
            Protect your messages
          </p>
        )}
        {embedded ? (
          <h3 id={titleId} className="text-body-lg font-semibold text-on-surface">
            Save your backup code
          </h3>
        ) : (
          <h1 id={titleId} className="text-headline-md font-semibold text-on-surface">
            Save your backup code
          </h1>
        )}
        <p className="max-w-lg text-body-md text-on-surface-variant">
          This code restores your protected messages on another device, and Mesh shows it only
          until you finish this step.
        </p>
      </header>

      {secureStorageState && (
        <div
          role="status"
          className={`rounded-xl border px-3 py-3 text-body-md ${
            secureStorageState === 'saved'
              ? 'border-primary-container-line bg-primary-container text-on-primary-container'
              : 'border-marker-container-line bg-marker-container text-on-marker-container'
          }`}
        >
          {/*
            D20: the Windows disclosure keeps the fact that somebody able to use
            this Windows account may be able to ask Mesh to use the saved copy,
            and that the copy stays on this device. One sentence, warning first.
          */}
          {secureStorageState === 'saved'
            ? 'Mesh saved another copy in Windows Credential Manager on this device, and someone who can use this Windows account may be able to ask Mesh to use it.'
            : 'Mesh could not save another copy. Copy or print the code before leaving.'}
          {verificationState === 'verified' && (
            <span> Mesh checked the code against your message backup.</span>
          )}
          {verificationState === 'failed' && (
            <span>
              {' '}
              Mesh could not complete the backup check, so check it again in Your devices before
              you rely on a new device.
            </span>
          )}
        </div>
      )}

      <section aria-label="Your backup code" className="space-y-4">
        <output
          aria-label="Backup code"
          className="block break-all rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-5 text-center font-code text-body-lg font-semibold tracking-wide text-on-surface"
        >
          {backupCode}
        </output>

        <div className="flex flex-wrap gap-2" aria-label="Backup code actions">
          <Button
            variant="secondary"
            disabled={busyAction !== null}
            onClick={() => void runAction('copy', onCopy, 'Backup code copied.')}
          >
            Copy
          </Button>
          {onPrint && (
            <Button
              variant="secondary"
              disabled={busyAction !== null}
              onClick={() => void runAction('print', onPrint, 'Backup code ready to print.')}
            >
              Print
            </Button>
          )}
        </div>
        <p className="text-body-sm text-on-surface-variant">
          Mesh does not download an unprotected backup file, so keep a copied or printed code
          private.
        </p>
        <p role="status" aria-live="polite" className="min-h-5 text-body-sm text-on-surface-variant">
          {announcement}
        </p>
      </section>

      {!confirming ? (
        <div className="space-y-3">
          <Button className="w-full" onClick={() => setConfirming(true)}>
            I saved it
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => onSkip({ kind: 'backup-code-reminder', recurringWarning: true })}
          >
            Remind me later (you could lose your messages)
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            submitConfirmation()
          }}
        >
          <fieldset className="space-y-3" aria-describedby={confirmationHelpId}>
            <legend className="text-body-lg font-semibold text-on-surface">
              Confirm your backup code
            </legend>
            <p id={confirmationHelpId} className="text-body-md text-on-surface-variant">
              Enter the three requested parts.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {challenge.map((segmentIndex) => (
                <label
                  key={segmentIndex}
                  htmlFor={`${generatedId}-segment-${segmentIndex}`}
                  className="text-body-sm font-medium text-on-surface-variant"
                >
                  Part {segmentIndex + 1}
                  <input
                    id={`${generatedId}-segment-${segmentIndex}`}
                    value={answers[segmentIndex] ?? ''}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    aria-invalid={attempted && !complete ? true : undefined}
                    className="mt-1.5 block w-full rounded-md border border-outline bg-surface-container-lowest px-3 py-2 font-code text-body-md text-on-surface outline-none focus:border-primary"
                    onChange={(event) => {
                      setAttempted(false)
                      setAnswers((current) => ({
                        ...current,
                        [segmentIndex]: event.target.value,
                      }))
                    }}
                  />
                </label>
              ))}
            </div>
          </fieldset>

          {attempted && !complete && (
            <p
              role="alert"
              className="rounded-full border border-error-container-line bg-error-container px-3 py-2 text-body-md text-on-error-container"
            >
              Those parts do not match your saved copy.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit">Continue</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Back
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

function backupSegments(backupCode: string): string[] {
  const segments = backupCode
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
  const codeSegments = segments[0]?.toUpperCase() === 'MESH' ? segments.slice(1) : segments
  if (codeSegments.length < 3) {
    throw new Error('BackupCodeScreen requires a code with at least three parts.')
  }
  return codeSegments
}

function normalizeSegment(value: string): string {
  return value.trim().toUpperCase()
}

function validateChallenge(
  indices: BackupCodeScreenProps['challengeIndices'],
  segmentCount: number,
): readonly [number, number, number] | null {
  if (
    !indices ||
    new Set(indices).size !== 3 ||
    indices.some((index) => !Number.isInteger(index) || index < 0 || index >= segmentCount)
  ) {
    return null
  }
  return indices
}

function deterministicChallenge(
  backupCode: string,
  segmentCount: number,
): readonly [number, number, number] {
  let seed = 0
  for (const character of backupCode) {
    seed = (seed * 31 + character.charCodeAt(0)) >>> 0
  }

  const selected: number[] = []
  let cursor = seed % segmentCount
  while (selected.length < 3) {
    if (!selected.includes(cursor)) selected.push(cursor)
    cursor = (cursor + 1 + (seed % Math.max(1, segmentCount - 1))) % segmentCount
    if (selected.length < 3 && selected.includes(cursor)) {
      cursor = (cursor + 1) % segmentCount
    }
  }
  return selected as unknown as readonly [number, number, number]
}
