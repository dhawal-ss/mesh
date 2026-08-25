import { useId } from 'react'
import {
  MAX_RUNTIME_ERROR_RECORDS,
  MAX_RUNTIME_ERROR_REPORT_BYTES,
} from '../../lib/runtime-error-reporting'

/**
 * What Mesh commits to, stated where a person can read it.
 *
 * Every line here is a behaviour actually implemented in this repository. A
 * commitment that is merely intended does not belong in this panel: an unkept
 * promise stated in product is worse than no statement at all.
 *
 * Two lines exist specifically because they surprise people:
 *
 *   - Mesh's window is excluded from screen capture, so a user who streams or
 *     records cannot show Mesh and cannot screenshot it to file a bug.
 *   - A Rust panic writes a local crash marker even while error reporting is
 *     off. That is the one thing Mesh records without being asked, so it is
 *     stated rather than omitted.
 */

interface Commitment {
  id: string
  statement: string
  /** Kept short on purpose: this is the reason a reader can trust the line. */
  basis: string
}

const WHAT_MESH_DOES: readonly Commitment[] = [
  {
    id: 'account-service',
    statement: 'You choose which account service holds your account.',
    basis: 'Offered during sign-in, including a custom service address.',
  },
  {
    id: 'export',
    statement: 'You can export your own data whenever you want it.',
    basis: 'Security and devices, under "Your personal data".',
  },
  {
    id: 'content-protection',
    statement:
      'Mesh excludes its own window from screen capture and screen sharing.',
    basis:
      'Checked before release. Recorders see a blank area, and you cannot screenshot Mesh.',
  },
]

const WHAT_MESH_DOES_NOT_DO: readonly Commitment[] = [
  {
    id: 'no-ads',
    statement: 'Mesh ships no advertising or analytics software.',
    basis: 'No advertising or analytics package is built into the app.',
  },
  {
    id: 'no-mining',
    statement: 'Nothing Mesh records contains your messages or files.',
    basis:
      'Contents are protected before they leave your device, and no diagnostic Mesh writes carries them.',
  },
  {
    id: 'no-reputation',
    statement:
      'Mesh does not score your reputation or make automated judgements about you.',
    basis: 'Moderation stays with ordinary tools and rate limits.',
  },
]

function formatKibibytes(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`
}

export function GovernedCommitmentsPanel() {
  const headingId = useId()
  const doesId = useId()
  const doesNotId = useId()
  const reportingId = useId()

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div>
        <h3 id={headingId} className="text-md font-semibold text-content-primary">
          What Mesh commits to
        </h3>
        <p className="mt-1 text-xs text-muted">
          How Mesh already behaves, not what it intends to do later.
        </p>
      </div>

      <CommitmentList
        headingId={doesId}
        title="What Mesh does"
        commitments={WHAT_MESH_DOES}
      />

      <CommitmentList
        headingId={doesNotId}
        title="What Mesh does not do"
        commitments={WHAT_MESH_DOES_NOT_DO}
      />

      <section
        aria-labelledby={reportingId}
        className="space-y-2 rounded-panel border border-border-subtle bg-surface-sunken p-4"
      >
        <h4 id={reportingId} className="text-sm font-semibold text-primary">
          If something goes wrong
        </h4>
        <ul className="space-y-1.5 text-xs text-secondary">
          <li>Error reporting is off until you turn it on.</li>
          <li>
            While it is on, Mesh records the type of an error, when it happened, and which part of
            the app it came from, never error messages, stack traces, or anything you wrote.
          </li>
          <li>
            It keeps at most {MAX_RUNTIME_ERROR_RECORDS} recent entries, and a saved report is
            capped at {formatKibibytes(MAX_RUNTIME_ERROR_REPORT_BYTES)}.
          </li>
          <li>
            Nothing is uploaded on its own. You save a report and decide who sees it.
          </li>
          {/*
            The one thing Mesh records without being asked. Shortened, never
            dropped: the panic hook writes this whatever the toggle says.
          */}
          <li>
            If Mesh stops unexpectedly it writes a small crash note holding the app version and the
            file and line it stopped at. It stays on this device even when error reporting is off.
          </li>
        </ul>
      </section>
    </section>
  )
}

function CommitmentList({
  headingId,
  title,
  commitments,
}: {
  headingId: string
  title: string
  commitments: readonly Commitment[]
}) {
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h4 id={headingId} className="text-sm font-semibold text-primary">{title}</h4>
      <ul className="space-y-2">
        {commitments.map((commitment) => (
          <li key={commitment.id} className="text-xs">
            <span className="block font-medium text-secondary">{commitment.statement}</span>
            <span className="block text-muted">{commitment.basis}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
