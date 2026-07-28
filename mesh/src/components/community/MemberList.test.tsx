import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as bridge from '../../lib/bridge'
import { useCommunityStore } from '../../store/communities'
import { MemberList } from './MemberList'

describe('MemberList actions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    useCommunityStore.setState({
      communityEntities: {
        'community-1': {
          id: 'community-1',
          name: 'Mesh',
          description: '',
          memberCount: 3,
          role: 'owner',
          joinedAt: '2026-07-25T12:00:00.000Z',
        },
      },
      communityOrder: ['community-1'],
      communities: [{
        id: 'community-1',
        name: 'Mesh',
        description: '',
        memberCount: 3,
        role: 'owner',
        joinedAt: '2026-07-25T12:00:00.000Z',
      }],
      activeCommunityId: 'community-1',
    })
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@me:mesh.im')
    vi.spyOn(bridge, 'getBackendCapabilities').mockReturnValue({
      encryptedText: true,
      encryptedAttachments: true,
      directMessages: true,
      voice: false,
      durableTimeouts: false,
      deviceManagement: true,
      recovery: true,
      legacyMigration: false,
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((element) => element.remove())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses recognizable role labels and full-size keyboard actions', async () => {
    await act(async () => {
      root.render(
        <MemberList
          isOpen
          embedded
          onClose={() => {}}
          members={[
            {
              publicKey: '@me:mesh.im',
              displayName: 'Ana',
              avatarColor: '#6c8f76',
              role: 'owner',
              online: true,
            },
            {
              publicKey: '@bob:example.org',
              displayName: 'Bob',
              avatarColor: '#8f765f',
              role: 'admin',
              online: true,
            },
          ]}
        />,
      )
    })

    expect(container.textContent).toContain('Owner')
    expect(container.textContent).toContain('Admin')
    const messageButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Message Bob"]',
    )
    const moreButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions for Bob"]',
    )
    expect(messageButton?.className).toContain('h-8')
    expect(messageButton?.className).toContain('w-8')
    expect(moreButton?.className).toContain('h-8')
    expect(moreButton?.className).toContain('w-8')

    await act(async () => {
      moreButton?.focus()
      moreButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Make member')
    expect(document.body.textContent).toContain('Remove from community')
    expect(document.body.textContent).toContain('Ban from community')
  })
})
