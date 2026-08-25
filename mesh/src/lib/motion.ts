import type { Transition, Variants } from 'framer-motion'

/**
 * Re-exported so component files can type a variant map without importing
 * `framer-motion` directly. The eslint boundary that keeps the LazyMotion
 * split intact uses core `no-restricted-imports`, which has no
 * `allowTypeImports` escape, so a bare type import is a lint error even
 * though it emits nothing.
 */
export type { Transition, Variants }

type CubicBezier = [number, number, number, number]

export interface MotionTokens {
  none: number
  press: number
  micro: number
  fast: number
  base: number
  deliberate: number
  maximum: number
  offsetTight: number
  offsetSubtle: number
  offsetPanel: number
  offsetDock: number
  scaleRecede: number
  scalePress: number
  scaleHover: number
  arriveEasing: CubicBezier
  emphasizeEasing: CubicBezier
  repositionEasing: CubicBezier
  progressEasing: CubicBezier
}

const FALLBACK_TOKENS: MotionTokens = {
  none: 0,
  press: 0.05,
  micro: 0.1,
  fast: 0.15,
  base: 0.2,
  deliberate: 0.25,
  maximum: 0.3,
  offsetTight: 4,
  offsetSubtle: 6,
  offsetPanel: 8,
  offsetDock: 20,
  scaleRecede: 0.9,
  scalePress: 0.96,
  scaleHover: 1.04,
  arriveEasing: [0.165, 0.84, 0.44, 1],
  emphasizeEasing: [0.23, 1, 0.32, 1],
  repositionEasing: [0.645, 0.045, 0.355, 1],
  progressEasing: [0, 0, 1, 1],
}

const CSS_EASINGS: Record<string, CubicBezier> = {
  ease: [0.25, 0.1, 0.25, 1],
  linear: [0, 0, 1, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
}

function durationSeconds(value: string, fallback: number) {
  const match = value.trim().match(/^(-?\d*\.?\d+)(ms|s)$/i)
  if (!match) return fallback
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 0) return fallback
  return match[2].toLowerCase() === 'ms' ? amount / 1_000 : amount
}

function easingCurve(value: string, fallback: CubicBezier): CubicBezier {
  const normalized = value.trim().toLowerCase()
  if (CSS_EASINGS[normalized]) return CSS_EASINGS[normalized]

  const match = normalized.match(
    /^cubic-bezier\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)$/,
  )
  if (!match) return fallback
  const curve = match.slice(1).map(Number) as CubicBezier
  return curve.every(Number.isFinite) ? curve : fallback
}

function pixelLength(value: string, fallback: number) {
  const match = value.trim().match(/^(-?\d*\.?\d+)px$/i)
  if (!match) return fallback
  const amount = Number(match[1])
  return Number.isFinite(amount) ? amount : fallback
}

function unitNumber(value: string, fallback: number) {
  const normalized = value.trim()
  if (!normalized) return fallback
  const amount = Number(normalized)
  return Number.isFinite(amount) ? amount : fallback
}

export function readMotionTokens(
  style: Pick<CSSStyleDeclaration, 'getPropertyValue'> | undefined =
    typeof document === 'undefined'
      ? undefined
      : getComputedStyle(document.documentElement),
): MotionTokens {
  if (!style) return FALLBACK_TOKENS
  return {
    none: durationSeconds(style.getPropertyValue('--motion-dur-none'), FALLBACK_TOKENS.none),
    press: durationSeconds(style.getPropertyValue('--motion-dur-press'), FALLBACK_TOKENS.press),
    micro: durationSeconds(style.getPropertyValue('--motion-dur-micro'), FALLBACK_TOKENS.micro),
    fast: durationSeconds(style.getPropertyValue('--motion-dur-fast'), FALLBACK_TOKENS.fast),
    base: durationSeconds(style.getPropertyValue('--motion-dur-base'), FALLBACK_TOKENS.base),
    deliberate: durationSeconds(
      style.getPropertyValue('--motion-dur-deliberate'),
      FALLBACK_TOKENS.deliberate,
    ),
    maximum: durationSeconds(
      style.getPropertyValue('--motion-dur-maximum'),
      FALLBACK_TOKENS.maximum,
    ),
    offsetTight: pixelLength(
      style.getPropertyValue('--motion-offset-tight'),
      FALLBACK_TOKENS.offsetTight,
    ),
    offsetSubtle: pixelLength(
      style.getPropertyValue('--motion-offset-subtle'),
      FALLBACK_TOKENS.offsetSubtle,
    ),
    offsetPanel: pixelLength(
      style.getPropertyValue('--motion-offset-panel'),
      FALLBACK_TOKENS.offsetPanel,
    ),
    offsetDock: pixelLength(
      style.getPropertyValue('--motion-offset-dock'),
      FALLBACK_TOKENS.offsetDock,
    ),
    scaleRecede: unitNumber(
      style.getPropertyValue('--motion-scale-recede'),
      FALLBACK_TOKENS.scaleRecede,
    ),
    scalePress: unitNumber(
      style.getPropertyValue('--motion-scale-press'),
      FALLBACK_TOKENS.scalePress,
    ),
    scaleHover: unitNumber(
      style.getPropertyValue('--motion-scale-hover'),
      FALLBACK_TOKENS.scaleHover,
    ),
    arriveEasing: easingCurve(
      style.getPropertyValue('--motion-ease-arrive'),
      FALLBACK_TOKENS.arriveEasing,
    ),
    emphasizeEasing: easingCurve(
      style.getPropertyValue('--motion-ease-emphasize'),
      FALLBACK_TOKENS.emphasizeEasing,
    ),
    repositionEasing: easingCurve(
      style.getPropertyValue('--motion-ease-reposition'),
      FALLBACK_TOKENS.repositionEasing,
    ),
    progressEasing: easingCurve(
      style.getPropertyValue('--motion-ease-progress'),
      FALLBACK_TOKENS.progressEasing,
    ),
  }
}

export const motionTokens = readMotionTokens()

export const motionDurations = {
  none: motionTokens.none,
  press: motionTokens.press,
  micro: motionTokens.micro,
  fast: motionTokens.fast,
  base: motionTokens.base,
  deliberate: motionTokens.deliberate,
  maximum: motionTokens.maximum,
} as const

export const motionOffsets = {
  tight: motionTokens.offsetTight,
  subtle: motionTokens.offsetSubtle,
  panel: motionTokens.offsetPanel,
  dock: motionTokens.offsetDock,
} as const

export const motionScales = {
  recede: motionTokens.scaleRecede,
  press: motionTokens.scalePress,
  hover: motionTokens.scaleHover,
} as const

export const transitions = {
  reduced: { duration: motionTokens.none } satisfies Transition,
  none: { duration: motionTokens.none } satisfies Transition,
  press: {
    duration: motionTokens.press,
    ease: motionTokens.arriveEasing,
  } satisfies Transition,
  micro: {
    duration: motionTokens.micro,
    ease: motionTokens.arriveEasing,
  } satisfies Transition,
  fast: {
    duration: motionTokens.fast,
    ease: motionTokens.arriveEasing,
  } satisfies Transition,
  base: {
    duration: motionTokens.base,
    ease: motionTokens.arriveEasing,
  } satisfies Transition,
  deliberate: {
    duration: motionTokens.deliberate,
    ease: motionTokens.emphasizeEasing,
  } satisfies Transition,
  maximum: {
    duration: motionTokens.maximum,
    ease: motionTokens.emphasizeEasing,
  } satisfies Transition,
  reposition: {
    duration: motionTokens.base,
    ease: motionTokens.repositionEasing,
  } satisfies Transition,
  progress: {
    duration: motionTokens.none,
    ease: motionTokens.progressEasing,
  } satisfies Transition,
  // Compatibility aliases now point only to approved Party Response tokens.
  enter: {
    duration: motionTokens.base,
    ease: motionTokens.arriveEasing,
  } satisfies Transition,
  exit: {
    duration: motionTokens.fast,
    ease: motionTokens.arriveEasing,
  } satisfies Transition,
  failure: {
    duration: motionTokens.fast,
    ease: motionTokens.arriveEasing,
  } satisfies Transition,
  move: {
    duration: motionTokens.base,
    ease: motionTokens.repositionEasing,
  } satisfies Transition,
  instant: {
    duration: motionTokens.press,
    ease: motionTokens.arriveEasing,
  } satisfies Transition,
}

export function createMotionVariants(tokens: MotionTokens) {
  const micro = { duration: tokens.micro, ease: tokens.arriveEasing } satisfies Transition
  const fast = { duration: tokens.fast, ease: tokens.arriveEasing } satisfies Transition
  const base = { duration: tokens.base, ease: tokens.arriveEasing } satisfies Transition
  const reposition = {
    duration: tokens.base,
    ease: tokens.repositionEasing,
  } satisfies Transition

  const messageEnter = {
    initial: { opacity: 0, y: tokens.offsetTight },
    animate: { opacity: 1, y: 0, transition: fast },
    exit: { opacity: 0, transition: fast },
  } satisfies Variants

  return {
    /*
     * First paint and route-level shell swaps do not animate the whole app.
     *
     * Deliberate no-op, kept as one: the onboarding steps and the App shell
     * swap run it under `AnimatePresence mode="wait"` with
     * `onAnimationComplete={focusCurrentStepHeading}`, so any duration here
     * becomes a delay on the step heading's focus transfer, and an exit
     * duration delays the next step mounting at all. A first-run arrival
     * belongs on the step container, not on the shared shell variant.
     */
    screen: {
      initial: { opacity: 1 },
      animate: { opacity: 1 },
      exit: { opacity: 1 },
    } satisfies Variants,
    panel: {
      initial: { opacity: 0, x: -tokens.offsetPanel },
      animate: { opacity: 1, x: 0, transition: base },
      exit: { opacity: 0, x: -tokens.offsetPanel, transition: fast },
    } satisfies Variants,
    messageEnter,
    message: messageEnter,
    overlay: {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: base },
      exit: { opacity: 0, transition: fast },
    } satisfies Variants,
    modal: {
      initial: { opacity: 0, y: tokens.offsetPanel },
      animate: { opacity: 1, y: 0, transition: base },
      exit: { opacity: 0, y: tokens.offsetPanel, transition: fast },
    } satisfies Variants,
    /*
     * Menu and tooltip arrival, the 150ms row of the motion table. Opacity
     * only: a popover is already anchored to its trigger, so travel would add
     * a second story about where it came from, and an opacity-only arrival
     * needs no reduced-motion branch.
     */
    popover: {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: fast },
      exit: { opacity: 0, transition: fast },
    } satisfies Variants,
    toast: {
      initial: { opacity: 0, y: tokens.offsetPanel },
      animate: { opacity: 1, y: 0, transition: base },
      exit: { opacity: 0, y: -tokens.offsetTight, transition: fast },
    } satisfies Variants,
    listItem: {
      initial: { opacity: 0, y: tokens.offsetTight },
      animate: { opacity: 1, y: 0, transition: reposition },
      exit: { opacity: 0, transition: fast },
    } satisfies Variants,
    /*
     * A count that has been cleared. Micro, because this is a small state
     * acknowledgement and nothing waits on it. The collapse is a transform
     * from the trailing edge rather than an animated width, so it never asks
     * the row it sits in for a layout pass, and reduced motion drops it to the
     * opacity change alone.
     */
    countBadge: {
      initial: { opacity: 0, scaleX: 0 },
      animate: { opacity: 1, scaleX: 1, transition: micro },
      exit: { opacity: 0, scaleX: 0, transition: micro },
    } satisfies Variants,
  }
}

export const variants = createMotionVariants(motionTokens)
