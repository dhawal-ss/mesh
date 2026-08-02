import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as bridge from '../../lib/bridge'
import type { CommunityPermissionProjection } from '../../lib/community-permissions'
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
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
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

  it('uses the compact empty state when the community has no members', async () => {
    await act(async () => {
      root.render(
        <MemberList
          isOpen
          embedded
          onClose={() => {}}
          members={[]}
        />,
      )
    })

    expect(container.textContent).toContain('No members yet')
    expect(container.textContent).toContain('People who join will appear here.')
    expect(container.querySelector('section')?.className).toContain('py-5')
  })

  it('confirms a named moderation action and keeps failures visible', async () => {
    const kickUser = vi.spyOn(bridge, 'kickUser').mockRejectedValue(new Error('offline'))
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
              role: 'member',
              online: true,
            },
          ]}
        />,
      )
    })

    await act(async () => {
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="More actions for Bob"]',
      )
      trigger?.focus()
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await Promise.resolve()
    })
    const removeItem = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent === 'Remove from community')
    expect(removeItem).toBeDefined()
    await act(async () => {
      removeItem?.focus()
      removeItem?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })

    // Removal is intentionally delayed until the named confirmation is accepted.
    expect(kickUser).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Remove Bob?')
    expect(document.body.textContent).toContain('may be able to rejoin later')

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Remove member')
        ?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(kickUser).toHaveBeenCalledWith('community-1', '@bob:example.org')
    expect(document.body.textContent).toContain('Connection interrupted')
  })

  it('previews effective Matrix permissions before applying a role change', async () => {
    const updateMemberRole = vi.spyOn(bridge, 'updateMemberRole').mockResolvedValue(null)
    const refreshPermissions = vi.fn()
    await act(async () => {
      root.render(
        <MemberList
          isOpen
          embedded
          onClose={() => {}}
          rolePermissionProjection={permissionProjection()}
          onRetryRolePermissions={refreshPermissions}
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
              role: 'member',
              online: true,
            },
          ]}
        />,
      )
    })

    await act(async () => {
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="More actions for Bob"]',
      )
      trigger?.focus()
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await Promise.resolve()
    })
    const roleItem = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent === 'Make administrator')
    await act(async () => {
      roleItem?.focus()
      roleItem?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })

    expect(updateMemberRole).not.toHaveBeenCalled()
    expect(refreshPermissions).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Make Bob an administrator?')
    expect(document.body.textContent).toContain('Proposed Administrator permissions')
    expect(document.body.textContent).toContain('Based on current Matrix state')
    expect(document.body.textContent).toContain('Manage roles and security')
    expect(document.body.textContent).toContain('Not granted')

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Apply role')
        ?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(updateMemberRole).toHaveBeenCalledWith(
      'community-1',
      '@bob:example.org',
      'admin',
    )
    expect(refreshPermissions).toHaveBeenCalledTimes(2)
  })

  it('keeps a five-thousand-member community DOM bounded with ordered list metadata', async () => {
    const members = Array.from({ length: 5_000 }, (_, index) => ({
      publicKey: `@member-${index}:example.org`,
      displayName: `Member ${index.toString().padStart(4, '0')}`,
      avatarColor: '#6c8f76',
      role: 'member' as const,
      online: index < 2_500,
    }))
    await act(async () => {
      root.render(
        <MemberList isOpen embedded onClose={() => {}} members={members} />,
      )
    })

    const renderedMembers = container.querySelectorAll('[role="listitem"]')
    expect(renderedMembers.length).toBeGreaterThan(0)
    expect(renderedMembers.length).toBeLessThan(100)
    expect(renderedMembers[0]?.getAttribute('aria-posinset')).toBe('1')
    expect(renderedMembers[0]?.getAttribute('aria-setsize')).toBe('5002')

    const list = container.querySelector<HTMLElement>(
      '[role="list"][aria-label="Community members"]',
    )
    await act(async () => {
      if (list) list.scrollTop = 200_056
      list?.dispatchEvent(new Event('scroll', { bubbles: true }))
      await Promise.resolve()
    })
    const finalMember = [...container.querySelectorAll('[role="listitem"]')]
      .find((member) => member.getAttribute('aria-posinset') === '5002')
    expect(finalMember).toBeDefined()
    expect(finalMember?.getAttribute('aria-setsize')).toBe('5002')
  })
})

function permissionProjection(): CommunityPermissionProjection {
  const policy = {
    users: {
      '@me:mesh.im': 100,
      '@bob:example.org': 0,
    },
    usersDefault: 0,
    events: { 'm.room.power_levels': 100 },
    eventsDefault: 0,
    stateDefault: 50,
    ban: 50,
    kick: 50,
    invite: 0,
    redact: 50,
    notifications: { room: 50 },
    creatorUserIds: ['@me:mesh.im'],
    privilegedCreatorUserIds: [],
    joinedUserIds: ['@me:mesh.im', '@bob:example.org'],
  }
  return {
    communityId: '!community:mesh.im',
    subjectUserId: '@me:mesh.im',
    discoveryComplete: true,
    discoveryFailureReason: null,
    aggregate: [],
    rooms: [{
      roomId: '!community:mesh.im',
      roomName: 'Mesh',
      roomKind: 'space',
      status: 'loaded',
      policy,
      failureReason: null,
    }],
  }
}
