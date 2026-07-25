import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Icon } from './Icon'

describe('Icon', () => {
  it.each([
    ['xs', '14'],
    ['sm', '16'],
    ['md', '20'],
    ['lg', '24'],
  ] as const)('locks the %s size to %spx', (size, pixels) => {
    const markup = renderToStaticMarkup(<Icon name="settings" size={size} />)

    expect(markup).toContain(`width="${pixels}"`)
    expect(markup).toContain(`height="${pixels}"`)
    expect(markup).toContain('stroke-width="1.75"')
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
