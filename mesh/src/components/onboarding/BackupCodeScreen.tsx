import { useId, useMemo, useState } from 'react'
import { Button } from '../ui/Button'

export interface BackupCodeReminderSignal {
  kind: 'backup-code-reminder'
  recurringWarning: true
}

export interface BackupCodeScreenProps {
  backupCode: string
  onCopy: (backupCode: string) => void | Promise<void>
  onSaveFile: (backupCode: string) => void | Promise<void>
  onPrint: (backupCode: string) => void | Promise<void>
  onContinue: () => void
  onSkip: (signal: BackupCodeReminderSignal) => void
  challengeIndices?: readonly [number, number, number]
}

type ActionName = 'copy' | 'save' | 'print'

export function BackupCodeScreen({
  backupCode,
  onCopy,
  onSaveFile,
  onPrint,
  onContinue,
  onSkip,
  challengeIndices,
}: BackupCodeScreenProps) {
  const generatedId = useId()
  const titleId = `${generatedId}-title`
  const confirmationHelpId = `${generatedId}-confirmation-help`
  const segments = useMemo(() => backupSegments(backupCode), [backupCode])
  const challenge = useMemo(
    () => validateChallenge(challengeIndices, segments.length)
      ?? deterministicChallenge(backupCode, segments.length),
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
      setAnnouncement('That did not work. Please try again.')
    } finally {
      setBusyAction(null)
    }
  }

  const submitConfirmation = () => {
    setAttempted(true)
    if (complete) onContinue()
  }

  return (
    <main aria-labelledby={titleId} className="space-y-6">
      <header className="space-y-2">
        <p className="text-caption uppercase tracking-eyebrow text-content-muted">Protect your messages</p>
        <h1 id={titleId} className="text-lg font-semibold tracking-tight text-content">
          Save your backup code
        </h1>
        <p className="max-w-lg text-sm leading-6 text-content-secondary">
          Your messages are locked so only you can read them. Not even we can see them. That also
          means if you lose this device, this code is the only way back in.
        </p>
      </header>

      <section aria-label="Your backup code" className="space-y-4">
        <output
          aria-label="Backup code"
          className="block break-all rounded-lg border border-border bg-surface-sunken px-4 py-5 text-center font-mono text-base font-semibold tracking-wide text-content"
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
          <Button
            variant="secondary"
            disabled={busyAction !== null}
            onClick={() => void runAction('save', onSaveFile, 'Backup code file saved.')}
          >
            Save as file
          </Button>
          <Button
            variant="secondary"
            disabled={busyAction !== null}
            onClick={() => void runAction('print', onPrint, 'Backup code ready to print.')}
          >
            Print
          </Button>
        </div>
        <p role="status" aria-live="polite" className="min-h-5 text-xs text-content-secondary">
          {announcement}
        </p>
      </section>

      {!confirming ? (
        <div className="space-y-3">
          <Button className="w-full" onClick={() => setConfirming(true)}>
            I saved it — continue
          </Button>
          <button
            type="button"
            className="w-full rounded-md px-3 py-2 text-sm text-content-secondary transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => onSkip({ kind: 'backup-code-reminder', recurringWarning: true })}
          >
            Remind me later (you could lose your messages)
          </button>
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
            <legend className="text-base font-semibold text-content">Confirm your backup code</legend>
            <p id={confirmationHelpId} className="text-sm leading-6 text-content-secondary">
              Enter the three requested parts to make sure your saved copy is readable.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {challenge.map((segmentIndex) => (
                <label
                  key={segmentIndex}
                  htmlFor={`${generatedId}-segment-${segmentIndex}`}
                  className="text-xs font-medium text-content-secondary"
                >
                  Part {segmentIndex + 1}
                  <input
                    id={`${generatedId}-segment-${segmentIndex}`}
                    value={answers[segmentIndex] ?? ''}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    aria-invalid={attempted && !complete ? true : undefined}
                    className="mt-1.5 block w-full rounded-md border border-border bg-surface-sunken px-3 py-2 font-mono text-sm uppercase text-content outline-none focus:border-accent"
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
            <p role="alert" className="rounded-md bg-status-danger/10 px-3 py-2 text-sm text-status-danger">
              Those parts do not match. Check your saved copy and try again.
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
    </main>
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
    !indices
    || new Set(indices).size !== 3
    || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= segmentCount)
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
    seed = ((seed * 31) + character.charCodeAt(0)) >>> 0
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
