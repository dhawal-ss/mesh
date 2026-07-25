import type { Transition, Variants } from 'framer-motion'

type CubicBezier = [number, number, number, number]

export interface MotionTokens {
  fast: number
  normal: number
  easing: CubicBezier
}

const FALLBACK_TOKENS: MotionTokens = {
  fast: 0.1,
  normal: 0.2,
  easing: [0.25, 0.1, 0.25, 1],
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
    fast: durationSeconds(
      style.getPropertyValue('--duration-fast'),
      FALLBACK_TOKENS.fast,
    ),
    normal: durationSeconds(
      style.getPropertyValue('--duration-normal'),
      FALLBACK_TOKENS.normal,
    ),
    easing: easingCurve(
      style.getPropertyValue('--ease-standard'),
      FALLBACK_TOKENS.easing,
    ),
  }
}

export const motionTokens = readMotionTokens()

export const motionDurations = {
  fast: motionTokens.fast,
  normal: motionTokens.normal,
  staggerFast: motionTokens.fast * 0.8,
  stagger: motionTokens.fast * 1.2,
  celebration: motionTokens.normal * 3.5,
  ambientLoop: motionTokens.normal * 5.75,
} as const

export const transitions = {
  reduced: {
    duration: 0,
  } satisfies Transition,
  enter: {
    duration: motionTokens.normal,
    ease: motionTokens.easing,
  } satisfies Transition,
  exit: {
    duration: motionTokens.fast,
    ease: motionTokens.easing,
  } satisfies Transition,
  fast: {
    duration: motionTokens.fast,
    ease: motionTokens.easing,
  } satisfies Transition,
  directSpring: {
    type: 'spring',
    stiffness: 300,
    damping: 30,
    mass: 0.8,
  } satisfies Transition,
  celebration: {
    duration: motionDurations.celebration,
    ease: motionTokens.easing,
  } satisfies Transition,
  ambientLoop: {
    duration: motionDurations.ambientLoop,
    repeat: Infinity,
    ease: 'linear',
  } satisfies Transition,
  // Compatibility name for call sites that treat a short exit as instant.
  instant: {
    duration: motionTokens.fast,
    ease: motionTokens.easing,
  } satisfies Transition,
}

export function createMotionVariants(tokens: MotionTokens) {
  const enter = { duration: tokens.normal, ease: tokens.easing } satisfies Transition
  const exit = { duration: tokens.fast, ease: tokens.easing } satisfies Transition

  const messageEnter = {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0, transition: enter },
    exit: { opacity: 0, transition: exit },
  } satisfies Variants

  return {
    screen: {
      initial: { opacity: 0, scale: 0.98 },
      animate: { opacity: 1, scale: 1, transition: enter },
      exit: { opacity: 0, scale: 0.98, transition: exit },
    } satisfies Variants,
    panel: {
      initial: { opacity: 0, x: -8 },
      animate: { opacity: 1, x: 0, transition: enter },
      exit: { opacity: 0, x: -8, transition: exit },
    } satisfies Variants,
    messageEnter,
    // Backwards-compatible alias. Message-list rows deliberately do not consume it.
    message: messageEnter,
    overlay: {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: enter },
      exit: { opacity: 0, transition: exit },
    } satisfies Variants,
    modal: {
      initial: { opacity: 0, y: 8, scale: 0.98 },
      animate: { opacity: 1, y: 0, scale: 1, transition: enter },
      exit: { opacity: 0, y: 8, scale: 0.98, transition: exit },
    } satisfies Variants,
    popover: {
      initial: { opacity: 0, y: -4, scale: 0.98 },
      animate: { opacity: 1, y: 0, scale: 1, transition: enter },
      exit: { opacity: 0, y: -2, scale: 0.98, transition: exit },
    } satisfies Variants,
    toast: {
      initial: { opacity: 0, y: 8 },
      animate: { opacity: 1, y: 0, transition: enter },
      exit: { opacity: 0, y: -4, transition: exit },
    } satisfies Variants,
    listItem: {
      initial: { opacity: 0, y: 4 },
      animate: { opacity: 1, y: 0, transition: enter },
      exit: { opacity: 0, transition: exit },
    } satisfies Variants,
  }
}

export const variants = createMotionVariants(motionTokens)
