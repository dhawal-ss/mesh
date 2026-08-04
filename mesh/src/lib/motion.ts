import type { Transition, Variants } from 'framer-motion'

type CubicBezier = [number, number, number, number]

export interface MotionTokens {
  none: number
  press: number
  micro: number
  fast: number
  base: number
  deliberate: number
  maximum: number
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
  const fast = { duration: tokens.fast, ease: tokens.arriveEasing } satisfies Transition
  const base = { duration: tokens.base, ease: tokens.arriveEasing } satisfies Transition
  const reposition = {
    duration: tokens.base,
    ease: tokens.repositionEasing,
  } satisfies Transition

  const messageEnter = {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0, transition: fast },
    exit: { opacity: 0, transition: fast },
  } satisfies Variants

  return {
    // First paint and route-level shell swaps do not animate the whole app.
    screen: {
      initial: { opacity: 1 },
      animate: { opacity: 1 },
      exit: { opacity: 1 },
    } satisfies Variants,
    panel: {
      initial: { opacity: 0, x: -8 },
      animate: { opacity: 1, x: 0, transition: base },
      exit: { opacity: 0, x: -8, transition: fast },
    } satisfies Variants,
    messageEnter,
    message: messageEnter,
    overlay: {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: base },
      exit: { opacity: 0, transition: fast },
    } satisfies Variants,
    modal: {
      initial: { opacity: 0, y: 8 },
      animate: { opacity: 1, y: 0, transition: base },
      exit: { opacity: 0, y: 8, transition: fast },
    } satisfies Variants,
    popover: {
      initial: { opacity: 1 },
      animate: { opacity: 1 },
      exit: { opacity: 0, transition: fast },
    } satisfies Variants,
    toast: {
      initial: { opacity: 0, y: 8 },
      animate: { opacity: 1, y: 0, transition: base },
      exit: { opacity: 0, y: -4, transition: fast },
    } satisfies Variants,
    listItem: {
      initial: { opacity: 0, y: 4 },
      animate: { opacity: 1, y: 0, transition: reposition },
      exit: { opacity: 0, transition: fast },
    } satisfies Variants,
  }
}

export const variants = createMotionVariants(motionTokens)
