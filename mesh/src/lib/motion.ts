import type { Transition, Variants } from 'framer-motion'

export const transitions = {
  instant: { duration: 0.1, ease: [0.4, 0, 0.2, 1] } satisfies Transition,
  softSpring: {
    type: 'spring',
    stiffness: 300,
    damping: 30,
    mass: 0.8,
  } satisfies Transition,
  panelSpring: {
    type: 'spring',
    stiffness: 300,
    damping: 32,
    mass: 0.9,
  } satisfies Transition,
  livelySpring: {
    type: 'spring',
    stiffness: 400,
    damping: 28,
    mass: 0.7,
  } satisfies Transition,
}

export const variants = {
  screen: {
    initial: { opacity: 0, scale: 0.98 },
    animate: {
      opacity: 1,
      scale: 1,
      transition: { duration: 0.15, ease: [0.4, 0, 0.2, 1] },
    },
    exit: {
      opacity: 0,
      scale: 0.98,
      transition: transitions.instant,
    },
  } satisfies Variants,
  panel: {
    initial: { opacity: 0, x: -8 },
    animate: {
      opacity: 1,
      x: 0,
      transition: { duration: 0.15, ease: [0.4, 0, 0.2, 1] },
    },
    exit: {
      opacity: 0,
      x: -8,
      transition: transitions.instant,
    },
  } satisfies Variants,
  message: {
    initial: { opacity: 0, y: 6 },
    animate: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.12, ease: [0.4, 0, 0.2, 1] },
    },
    exit: {
      opacity: 0,
      y: -4,
      transition: transitions.instant,
    },
  } satisfies Variants,
  overlay: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.1 } },
    exit: { opacity: 0, transition: { duration: 0.08 } },
  } satisfies Variants,
  modal: {
    initial: { opacity: 0, y: 8, scale: 0.98 },
    animate: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: transitions.softSpring,
    },
    exit: {
      opacity: 0,
      y: 8,
      scale: 0.98,
      transition: transitions.instant,
    },
  } satisfies Variants,
}
