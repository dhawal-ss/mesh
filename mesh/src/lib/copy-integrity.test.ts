import { describe, expect, it } from 'vitest'

const rendererSources = import.meta.glob('../**/*.{css,html,json,ts,tsx}', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

describe('renderer copy integrity', () => {
  it('contains no common UTF-8 mojibake markers or replacement characters', () => {
    const markers = [0x00e2, 0x00c3, 0xfffd].map((codePoint) => String.fromCodePoint(codePoint))
    const findings = Object.entries(rendererSources).flatMap(([path, source]) => (
      markers.some((marker) => source.includes(marker)) ? [path] : []
    ))

    expect(findings).toEqual([])
  })
})
