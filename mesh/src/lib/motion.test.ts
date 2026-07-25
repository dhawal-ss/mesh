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
      '--duration-fast': '90ms',
      '--duration-normal': '0.18s',
      '--ease-standard': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    }

    expect(readMotionTokens({
      getPropertyValue: (name) => values[name] ?? '',
    })).toEqual({
      fast: 0.09,
      normal: 0.18,
      easing: [0.2, 0.8, 0.2, 1],
    })
  })

  it('falls back safely when CSS motion tokens are unavailable', () => {
    expect(readMotionTokens(undefined)).toEqual({
      fast: 0.1,
      normal: 0.2,
      easing: [0.25, 0.1, 0.25, 1],
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
      easing: [0, 0, 0.58, 1],
    })
    expect(custom.screen.animate).toMatchObject({
      transition: { duration: 0.16 },
    })
    expect(custom.screen.exit).toMatchObject({
      transition: { duration: 0.08 },
    })
    expect(transitions.enter.duration).toBeGreaterThanOrEqual(0.14)
    expect(transitions.enter.duration).toBeLessThanOrEqual(0.22)
    expect(transitions.exit.duration).toBeGreaterThanOrEqual(0.08)
    expect(transitions.exit.duration).toBeLessThanOrEqual(0.14)
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
