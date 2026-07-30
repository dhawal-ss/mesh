import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/bridge', () => ({
  isMatrixBackend: vi.fn(() => true),
  getBackendStatusSnapshot: vi.fn(() => null),
  getCommunityAccessSettings: vi.fn(async () => ({ alias: null, discoverable: false })),
  getCommunityApplications: vi.fn(async () => []),
  getModerationAudit: vi.fn(async () => []),
  listServerEmoji: vi.fn(async () => []),
  updateCommunityMetadata: vi.fn(),
  createChannel: vi.fn(),
  leaveCommunity: vi.fn(),
  deleteCommunity: vi.fn(),
}))

import * as bridge from '../../lib/bridge'
import { useCommunityStore } from '../../store/communities'
import { CommunitySettings } from './CommunitySettings'

describe('CommunitySettings mutation failures', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(true)
    useCommunityStore.setState({
      communityEntities: {
        'community-1': {
          id: 'community-1',
          name: 'Design Club',
          description: 'A thoughtful place',
          memberCount: 3,
          role: 'owner',
          joinedAt: '2026-07-25T12:00:00.000Z',
        },
      },
      communityOrder: ['community-1'],
      communities: [{
        id: 'community-1',
        name: 'Design Club',
        description: 'A thoughtful place',
        memberCount: 3,
        role: 'owner',
        joinedAt: '2026-07-25T12:00:00.000Z',
      }],
      activeCommunityId: 'community-1',
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('surfaces metadata, room creation, and leave failures without closing the sheet', async () => {
    vi.mocked(bridge.updateCommunityMetadata).mockRejectedValue(new Error('offline'))
    vi.mocked(bridge.createChannel).mockRejectedValue(new Error('offline'))
    vi.mocked(bridge.leaveCommunity).mockRejectedValue(new Error('offline'))
    await renderSettings()

    await act(async () => {
      findButton('Save Changes').click()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain("Mesh couldn't save the community details")

    await act(async () => findButton('Create room').click())
    await act(async () => setInputValue(inputForLabel('Room Name'), 'announcements'))
    await act(async () => {
      findButton('Create Room').click()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain("Mesh couldn't create the room")

    await act(async () => findButton('Leave Community').click())
    expect(bridge.leaveCommunity).not.toHaveBeenCalled()
    await act(async () => {
      findButton('Leave').click()
      await Promise.resolve()
    })
    // The failed destructive action remains visible and actionable instead of closing.
    expect(document.body.textContent).toContain("Mesh couldn't leave Design Club")
    expect(document.body.textContent).toContain('Community settings')
  })

  it('surfaces a failed owner deletion after explicit confirmation', async () => {
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(false)
    vi.mocked(bridge.deleteCommunity).mockRejectedValue(new Error('offline'))
    await renderSettings()

    await act(async () => findButton('Delete Community').click())
    expect(bridge.deleteCommunity).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Delete Design Club?')
    await act(async () => {
      findButton('Delete').click()
      await Promise.resolve()
    })

    expect(bridge.deleteCommunity).toHaveBeenCalledWith('community-1')
    expect(document.body.textContent).toContain("Mesh couldn't delete Design Club")
  })

  it('associates discovery and emoji controls with their persistent guidance', async () => {
    await renderSettings()

    const publicLink = inputForLabel('Public link')
    expect(publicLink.getAttribute('aria-describedby')).toContain(
      'community-public-link-description',
    )
    const emojiName = inputForLabel('Emoji name')
    expect(emojiName.getAttribute('aria-describedby')).toContain(
      'community-emoji-description',
    )
    const emojiFile = inputForLabel('Image')
    expect(emojiFile.getAttribute('aria-describedby')).toContain(
      'community-emoji-file-description',
    )
  })

  async function renderSettings() {
    await act(async () => {
      root.render(<CommunitySettings isOpen onClose={() => {}} />)
      await Promise.resolve()
    })
  }

  function findButton(label: string): HTMLButtonElement {
    const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === label)
    if (!button) throw new Error(`Button not found: ${label}`)
    return button
  }

  function inputForLabel(label: string): HTMLInputElement {
    const labelElement = [...document.body.querySelectorAll<HTMLLabelElement>('label')]
      .find((candidate) => candidate.textContent?.trim() === label)
    const input = labelElement?.htmlFor
      ? document.getElementById(labelElement.htmlFor)
      : labelElement?.querySelector('input')
    if (!(input instanceof HTMLInputElement)) throw new Error(`Input not found: ${label}`)
    return input
  }
})

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
