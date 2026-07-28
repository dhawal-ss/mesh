import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Icon } from './Icon'

describe('Icon', () => {
  it.each([
    ['xs', 14, 1.5],
    ['sm', 16, 1.5],
    ['md', 20, 1.5],
    ['lg', 24, 1.75],
  ] as const)('locks the %s size to %spx with a %spx optical stroke', (size, pixels, opticalStroke) => {
    const markup = renderToStaticMarkup(<Icon name="settings" size={size} />)
    const coordinateStroke = Number(markup.match(/stroke-width="([^"]+)"/)?.[1])

    expect(markup).toContain(`width="${pixels}"`)
    expect(markup).toContain(`height="${pixels}"`)
    expect(coordinateStroke * pixels / 24).toBeCloseTo(opticalStroke)
  })

  it('hides decorative icons from assistive technology', () => {
    const markup = renderToStaticMarkup(<Icon name="activity" />)

    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('focusable="false"')
  })

  it('exposes an explicitly labelled standalone icon as an image', () => {
    const markup = renderToStaticMarkup(<Icon name="triangleAlert" aria-label="Warning" />)

    expect(markup).toContain('aria-label="Warning"')
    expect(markup).toContain('role="img"')
    expect(markup).not.toContain('aria-hidden')
  })
})
