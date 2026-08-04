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
      '--motion-dur-none': '0ms',
      '--motion-dur-press': '50ms',
      '--motion-dur-micro': '100ms',
      '--motion-dur-fast': '150ms',
      '--motion-dur-base': '0.2s',
      '--motion-dur-deliberate': '250ms',
      '--motion-dur-maximum': '300ms',
      '--motion-ease-arrive': 'cubic-bezier(0.165, 0.84, 0.44, 1)',
      '--motion-ease-emphasize': 'cubic-bezier(0.23, 1, 0.32, 1)',
      '--motion-ease-reposition': 'cubic-bezier(0.645, 0.045, 0.355, 1)',
      '--motion-ease-progress': 'linear',
    }

    expect(readMotionTokens({
      getPropertyValue: (name) => values[name] ?? '',
    })).toEqual({
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
    })
  })

  it('falls back safely when CSS motion tokens are unavailable', () => {
    expect(readMotionTokens(undefined)).toEqual({
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
      none: 0,
      press: 0.04,
      micro: 0.08,
      fast: 0.08,
      base: 0.16,
      deliberate: 0.24,
      maximum: 0.3,
      arriveEasing: [0, 0, 0.58, 1],
      emphasizeEasing: [0.23, 1, 0.32, 1],
      repositionEasing: [0.645, 0.045, 0.355, 1],
      progressEasing: [0, 0, 1, 1],
    })
    expect(custom.panel.animate).toMatchObject({
      transition: { duration: 0.16 },
    })
    expect(custom.panel.exit).toMatchObject({
      transition: { duration: 0.08 },
    })
    expect(transitions.enter.duration).toBeGreaterThanOrEqual(0.14)
    expect(transitions.enter.duration).toBeLessThanOrEqual(0.22)
    expect(transitions.exit.duration).toBe(0.15)
    expect(transitions.deliberate.duration).toBe(0.25)
    expect(transitions.maximum.duration).toBe(0.3)
    expect(transitions).not.toHaveProperty('reaction')
    expect(transitions).not.toHaveProperty('ambientLoop')
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
