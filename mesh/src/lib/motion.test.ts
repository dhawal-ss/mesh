import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createMotionVariants,
  readMotionTokens,
  transitions,
  variants,
} from './motion'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.tsx') ? [path] : []
  })
}

describe('motion tokens', () => {
  it('reads CSS time and easing variables into Framer Motion values', () => {
    const values: Record<string, string> = {
      '--motion-dur-fast': '150ms',
      '--motion-dur-base': '0.2s',
      '--motion-dur-slow': '250ms',
      '--motion-dur-exit': '0.15s',
      '--motion-ease-enter': 'cubic-bezier(0.165, 0.84, 0.44, 1)',
      '--motion-ease-exit': 'cubic-bezier(0.165, 0.84, 0.44, 1)',
      '--motion-ease-move': 'cubic-bezier(0.645, 0.045, 0.355, 1)',
      '--motion-ease-hover': 'ease',
    }

    expect(readMotionTokens({
      getPropertyValue: (name) => values[name] ?? '',
    })).toEqual({
      fast: 0.15,
      normal: 0.2,
      slow: 0.25,
      exit: 0.15,
      easing: [0.165, 0.84, 0.44, 1],
      exitEasing: [0.165, 0.84, 0.44, 1],
      moveEasing: [0.645, 0.045, 0.355, 1],
      hoverEasing: [0.25, 0.1, 0.25, 1],
    })
  })

  it('falls back safely when CSS motion tokens are unavailable', () => {
    expect(readMotionTokens(undefined)).toEqual({
      fast: 0.15,
      normal: 0.2,
      slow: 0.25,
      exit: 0.15,
      easing: [0.165, 0.84, 0.44, 1],
      exitEasing: [0.165, 0.84, 0.44, 1],
      moveEasing: [0.645, 0.045, 0.355, 1],
      hoverEasing: [0.25, 0.1, 0.25, 1],
    })
  })

  it('exports every recurring semantic motion pattern', () => {
    expect(Object.keys(variants)).toEqual(expect.arrayContaining([
      'screen',
      'panel',
      'messageEnter',
      'overlay',
      'modal',
      'popover',
      'toast',
      'listItem',
    ]))

    const custom = createMotionVariants({
      fast: 0.08,
      normal: 0.16,
      slow: 0.24,
      exit: 0.12,
      easing: [0, 0, 0.58, 1],
      exitEasing: [0, 0, 0.58, 1],
      moveEasing: [0.645, 0.045, 0.355, 1],
      hoverEasing: [0.25, 0.1, 0.25, 1],
    })
    expect(custom.screen.animate).toMatchObject({
      transition: { duration: 0.16 },
    })
    expect(custom.screen.exit).toMatchObject({
      transition: { duration: 0.12 },
    })
    expect(transitions.enter.duration).toBeGreaterThanOrEqual(0.14)
    expect(transitions.enter.duration).toBeLessThanOrEqual(0.22)
    expect(transitions.exit.duration).toBe(0.15)
    expect(transitions.reaction).toMatchObject({
      type: 'spring',
      duration: 0.3,
      bounce: 0.2,
    })
  })
})

describe('motion source contracts', () => {
  const componentSources = sourceFiles(resolve(process.cwd(), 'src/components'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')

  it('keeps raw numeric transition durations out of components', () => {
    expect(componentSources).not.toMatch(
      /transition\s*=\s*\{\s*\{[\s\S]{0,120}?duration\s*:\s*\d/,
    )
  })

  it('limits JS-driven animation targets to transforms and opacity', () => {
    expect(componentSources).not.toMatch(
      /(initial|animate|exit)\s*=\s*\{\s*\{[^}]*\b(height|width|filter)\s*:/,
    )
  })

  it('does not apply message-enter animation to regular message rows', () => {
    const messageSource = readFileSync(
      resolve(process.cwd(), 'src/components/chat/Message.tsx'),
      'utf8',
    )
    expect(messageSource).not.toMatch(/variants\.(message|messageEnter)\b/)
  })
})
