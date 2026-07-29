import { beforeEach, describe, expect, it, vi } from 'vitest'

const deepLinkMocks = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-deep-link', () => deepLinkMocks)

import { installDeepLinkHandler, routeInviteUrls } from './deep-links'

describe('deep-link routing', () => {
  beforeEach(() => {
    deepLinkMocks.getCurrent.mockReset()
    deepLinkMocks.onOpenUrl.mockReset()
  })

  it('routes only validated Mesh join links', () => {
    const handler = vi.fn()
    routeInviteUrls(
      [
        'https://example.org',
        'mesh://settings',
        'mesh://join?v=3&kind=matrix&room=!room:mesh.example&via=mesh.example',
      ],
      handler,
    )

    expect(handler).toHaveBeenCalledWith(
      'mesh://join?v=3&kind=matrix&room=!room:mesh.example&via=mesh.example',
    )
  })

  it('handles cold-start and later warm-start URLs, including reopening the same invite', async () => {
    const link = 'mesh://join?v=3&kind=matrix&room=!room:mesh.example&via=mesh.example'
    let warmStartHandler: ((urls: string[]) => void) | undefined
    const unlisten = vi.fn()
    deepLinkMocks.getCurrent.mockResolvedValue([link])
    deepLinkMocks.onOpenUrl.mockImplementation(async (handler) => {
      warmStartHandler = handler
      return unlisten
    })
    const handler = vi.fn()

    await expect(installDeepLinkHandler(handler)).resolves.toBe(unlisten)
    warmStartHandler?.([link])

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledWith(link)
  })
})
