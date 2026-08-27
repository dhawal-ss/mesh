import {
  useCallback,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import clsx from 'clsx'

import { trustRailLabel, type TrustTone } from '../../lib/trust'

/*
  The Quiet Structure primitive set.

  Everything below is composition material for the nine screens: an eyebrow, a
  screen title, a numbered row, a plane chip, a hairline segmented control, the
  trust rail, a state tick and the one ambient line a screen is allowed. They
  live in their own module rather than in Primitives.tsx because they are a
  vocabulary rather than a widget library -- a screen built out of these should
  read as a list of structural decisions, and that is easier to see when the
  imports say so.

  Two rules are enforced here rather than left to call sites:

  An eyebrow, a count and a caption always take --content-secondary. The mock's
  greys are 2.31:1 and 4.00:1; at 9.5px the first is not text at all and the
  second is below the 4.5:1 body-text floor. Nothing in this file lets a caller
  pass a dimmer ink for text that carries information.

  A plane is square and takes near-black ink. The canvas on the structural
  accent measures 5.9:1; white on it is 3.1:1 and fails. --content-on-accent
  already says this, and PlaneChip and NumberedRow are the only things here
  that need to know.
*/

/* -------------------------------------------------------------------------
   Eyebrow
   ------------------------------------------------------------------------- */

export interface EyebrowProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * Tints the eyebrow with the structural accent.
   *
   * Reserved for the one continuation target on a screen. An eyebrow that is
   * merely labelling a section is never accented -- if every label is accented
   * then the accent has stopped pointing at anything.
   */
  accent?: boolean
  /**
   * Renders as a heading at this level.
   *
   * Omit where the section already has its own heading element and this is
   * only its visible label.
   */
  headingLevel?: 2 | 3 | 4
}

/**
 * The mono section label: 9.5px, 0.16em, secondary ink.
 *
 * This is one of the four jobs mono has in Quiet Structure. Inter is never
 * uppercased, so an label is always this component.
 */
export function Eyebrow({ accent, headingLevel, className, ...props }: EyebrowProps) {
  return (
    <span
      role={headingLevel ? 'heading' : undefined}
      aria-level={headingLevel}
      className={clsx(
        'text-label-sm font-medium ',
        accent ? 'text-primary' : 'text-on-surface-variant',
        className,
      )}
      {...props}
    />
  )
}

/* -------------------------------------------------------------------------
   RowIndex and NumberedRow
   ------------------------------------------------------------------------- */

/**
 * Zero-pads a positional index to two digits.
 *
 * The number is positional, not an identifier: it renumbers on reorder and is
 * never persisted. Past 99 it stops padding rather than truncating, because a
 * wrong number is worse than a wide one.
 */
export function rowNumber(index: number): string {
  /*
    Named `position` rather than the obvious alternative: Tailwind's content
    scanner matches bare words wherever they appear, and that name was enough
    to make it emit a font-variant-numeric utility nothing here asks for. IBM
    Plex Mono is monospaced, so its figures are already tabular.
  */
  const position = index + 1
  return position < 10 ? `0${position}` : String(position)
}

/* -------------------------------------------------------------------------
   SegmentedControl
   ------------------------------------------------------------------------- */

export interface SegmentedOption<Value extends string> {
  value: Value
  label: string
  /** Optional mono lineage or hint under the label. */
  hint?: string
}

export interface SegmentedControlProps<Value extends string> {
  label: string
  value: Value
  options: readonly SegmentedOption<Value>[]
  onChange: (value: Value) => void
  className?: string
}

/**
 * A hairline-divided group whose selection is a flat plane.
 *
 * The group carries a 7px outer radius and the selection keeps square inner
 * corners, which is the radius rule in miniature: the group is a control you
 * touch, the selection is a structural mark.
 *
 * Roving focus, so the group is one tab stop and the arrows move the
 * selection, matching the native radiogroup behaviour people already have.
 */
export function SegmentedControl<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: SegmentedControlProps<Value>) {
  const groupRef = useRef<HTMLDivElement>(null)

  const move = useCallback(
    (delta: number) => {
      const current = options.findIndex((option) => option.value === value)
      if (current < 0) return
      const next = options[(current + delta + options.length) % options.length]
      onChange(next.value)
      const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      buttons?.[options.indexOf(next)]?.focus()
    },
    [onChange, options, value],
  )

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      className={clsx(
        'inline-flex overflow-hidden rounded-full border border-rule border-outline',
        className,
      )}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        }
      }}
    >
      {options.map((option, position) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={clsx(
              'flex min-h-control-sm flex-col items-center justify-center gap-0.5 rounded-full px-3 py-1.5',
              'text-title-md font-medium transition-colors duration-instant',
              position > 0 && 'border-l border-rule border-outline-variant',
              selected
                ? 'bg-primary text-on-primary'
                : 'text-on-surface-variant hover:bg-state-hover hover:text-on-surface',
            )}
          >
            {option.label}
            {option.hint ? (
              <span
                className={clsx(
                  'text-label-sm font-medium ',
                  selected ? 'text-on-primary' : 'text-on-surface-variant',
                )}
              >
                {option.hint}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------
   TrustRail
   ------------------------------------------------------------------------- */

export interface TrustRailProps {
  tone: TrustTone
  /** The origin homeserver, for the accessible name. */
  server?: string | null
  className?: string
}

/**
 * The 2px bar in the timeline gutter, spanning a message group's full height.
 *
 * `data-trust` is the hook a test and a screenshot read, and the accessible
 * name is the second channel the colour owes: green, chrome and vermilion are
 * indistinguishable to a person who cannot see them, so each rail says which
 * state it is in words.
 */
export function TrustRail({ tone, server, className }: TrustRailProps) {
  return (
    <span
      role="img"
      data-trust={tone}
      aria-label={trustRailLabel(tone, server ?? null)}
      className={clsx(
        'mesh-trust-rail block w-trust-rail flex-none self-stretch rounded-full',
        className,
      )}
    />
  )
}

/* -------------------------------------------------------------------------
   StateTick
   ------------------------------------------------------------------------- */

export interface StateTickProps {
  /** `pending` is the faint rule; the rest are the status triad. */
  state: 'pending' | 'ok' | 'warning' | 'danger'
  /** The word this tick stands for, so the colour is never alone. */
  label: string
  className?: string
}

/**
 * A 14x2 rule that stands in for a state: latency, key generation, readiness.
 *
 * It replaces a spinner, a badge and a coloured dot with the same mark the
 * rest of the system already uses, and it is always paired with the word it
 * represents.
 */
export function StateTick({ state, label, className }: StateTickProps) {
  return (
    <span
      role="img"
      data-state={state}
      aria-label={label}
      className={clsx('mesh-state-tick block h-trust-rail w-3.5 flex-none rounded-full', className)}
    />
  )
}

/* -------------------------------------------------------------------------
   ExceptionLine
   ------------------------------------------------------------------------- */

export interface ExceptionLineProps {
  tone?: 'warning' | 'danger'
  children: ReactNode
  className?: string
}

/**
 * The only text a message is allowed to gain.
 *
 * Reserved for an unverified device, an undecryptable event, a failed
 * federation send and a withheld key. Never for "encrypted OK", "verified", or
 * the origin server -- those are the rail's job, and saying them here is what
 * the whole system exists to stop.
 */
export function ExceptionLine({ tone = 'warning', children, className }: ExceptionLineProps) {
  return (
    <p
      className={clsx(
        'mt-1 flex items-center gap-1.5 text-label-sm font-semibold tracking-label-md',
        tone === 'warning' ? 'text-marker' : 'text-error',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'h-1 w-1 flex-none rounded-full',
          tone === 'warning' ? 'bg-marker' : 'bg-error',
        )}
      />
      {children}
    </p>
  )
}

/* -------------------------------------------------------------------------
   AmbientNote
   ------------------------------------------------------------------------- */

export interface AmbientNoteProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Prefixes the note with a green tick.
   *
   * Used where the note is a statement about encryption rather than a legend
   * about the marks on the screen.
   */
  confirmed?: boolean
  children: ReactNode
}

/**
 * One caption per screen, pinned to the bottom rule. Never one per message.
 *
 * This is the third and least prominent of the three carriers, and it is the
 * only one that uses words in the normal case. If a screen wants a second one
 * of these, the answer is that it wants a different sentence, not two.
 */
export function AmbientNote({ confirmed, className, children, ...props }: AmbientNoteProps) {
  return (
    <div
      className={clsx(
        'flex items-center gap-2 border-t border-rule border-outline-variant px-shell-gutter py-2',
        'text-label-sm normal-case tracking-normal text-on-surface-variant',
        className,
      )}
      {...props}
    >
      {confirmed ? (
        <StateTick state="ok" label="Encrypted" />
      ) : null}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}
