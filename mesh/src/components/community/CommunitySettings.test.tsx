import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/bridge', () => ({
  isMatrixBackend: vi.fn(() => true),
  getMatrixUserId: vi.fn(() => '@taylor:mesh.test'),
  getBackendCapabilities: vi.fn(() => ({ directMessages: true })),
  getBackendStatusSnapshot: vi.fn(() => null),
  getCommunityAccessSettings: vi.fn(async () => ({ alias: null, discoverable: false })),
  getCommunityApplications: vi.fn(async () => []),
  getModerationAudit: vi.fn(async () => []),
  listServerEmoji: vi.fn(async () => []),
  pickCustomEmojiGrant: vi.fn(async () => null),
  discardAttachmentGrant: vi.fn(async () => undefined),
  updateCommunityAccess: vi.fn(async (_communityId: string, alias: string, discoverable: boolean) => ({
    alias,
    discoverable,
    joinRule: discoverable ? 'knock' : 'invite',
  })),
  respondToCommunityApplication: vi.fn(async () => undefined),
  uploadServerEmoji: vi.fn(async () => ({
    shortcode: 'party_parrot',
    body: 'party parrot',
    mxcUri: 'mxc://example/party-parrot',
    contentType: 'image/png',
    width: 96,
    height: 96,
    sizeBytes: 1024,
  })),
  removeServerEmoji: vi.fn(async () => undefined),
  matrixSyncOnce: vi.fn(async () => undefined),
  loadServerEmojiImage: vi.fn(async () => new Uint8Array()),
  updateCommunityMetadata: vi.fn(),
  updateMemberRole: vi.fn(),
  kickUser: vi.fn(),
  banUser: vi.fn(),
  ensureDm: vi.fn(),
  getMemberPage: vi.fn(),
  createChannel: vi.fn(),
  leaveCommunity: vi.fn(),
  deleteCommunity: vi.fn(),
}))

import * as bridge from '../../lib/bridge'
import {
  CHANNEL_NAME_MAX_LENGTH,
  COMMUNITY_DESCRIPTION_MAX_LENGTH,
  COMMUNITY_NAME_MAX_LENGTH,
} from '../../lib/community-metadata-limits'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useServerEmojiStore } from '../../store/custom-emoji'
import { useMembershipStore } from '../../store/membership'
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
    vi.mocked(bridge.updateCommunityMetadata).mockResolvedValue(undefined)
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
    useChannelStore.setState({
      channelEntities: {
        'room-text': {
          id: 'room-text',
          communityId: 'community-1',
          name: 'announcements',
          channelType: 'text',
          unreadCount: 2,
        },
        'room-voice': {
          id: 'room-voice',
          communityId: 'community-1',
          name: 'Lounge',
          channelType: 'voice',
          unreadCount: 0,
        },
      },
      channelOrder: ['room-text', 'room-voice'],
      channels: [
        {
          id: 'room-text',
          communityId: 'community-1',
          name: 'announcements',
          channelType: 'text',
          unreadCount: 2,
        },
        {
          id: 'room-voice',
          communityId: 'community-1',
          name: 'Lounge',
          channelType: 'voice',
          unreadCount: 0,
        },
      ],
      activeChannelId: 'room-text',
    })
    useServerEmojiStore.setState({ byCommunity: {}, loading: {} })
    useMembershipStore.setState({
      memberEntities: {},
      memberOrder: {},
      members: {},
      rosterNextCursor: {},
      rosterStateComplete: {},
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('surfaces metadata, room creation, and leave failures without closing the sheet', async () => {
    setCommunityRole('admin')
    vi.mocked(bridge.updateCommunityMetadata).mockRejectedValue(new Error('offline'))
    vi.mocked(bridge.createChannel).mockRejectedValue(new Error('offline'))
    vi.mocked(bridge.leaveCommunity).mockRejectedValue(new Error('offline'))
    await renderSettings()

    await act(async () => setInputValue(inputForLabel('Community Name'), 'Design Club offline'))
    await act(async () => {
      findButton('Save Changes').click()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain("Mesh couldn't save the community details")

    await act(async () => findButton('Create room').click())
    await act(async () => setInputValue(inputForLabel('Room name'), 'announcements'))
    await act(async () => {
      findButton('Create room').click()
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

  it('presents community identity as verified facts and saves only changed public details', async () => {
    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="general" onClose={() => {}} />,
      )
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Community identity')
    expect(document.body.textContent).toContain('Community owner')
    expect(document.body.textContent).toContain('3 members')
    expect(document.body.textContent).toContain('Community service')
    expect(document.body.textContent).toContain('Up to date')
    expect(findButton('Save Changes').disabled).toBe(true)

    await act(async () => setInputValue(inputForLabel('Community Name'), 'Design Circle'))
    expect(document.body.textContent).toContain('Unsaved')
    expect(document.body.textContent).toContain('Review your changes before saving.')
    expect(findButton('Save Changes').disabled).toBe(false)

    await act(async () => {
      findButton('Save Changes').click()
      await Promise.resolve()
    })
    expect(bridge.updateCommunityMetadata).toHaveBeenCalledWith(
      'community-1',
      'Design Circle',
      'A thoughtful place',
    )
    expect(document.body.textContent).toContain('Community details saved.')
    expect(document.body.textContent).toContain('Up to date')
    expect(findButton('Save Changes').disabled).toBe(true)
  })

  it('summarizes roster presence and verified leadership before member actions', async () => {
    useMembershipStore.getState().setRoster('community-1', [
      {
        publicKey: '@maya:mesh.test',
        displayName: 'Maya Chen',
        avatarColor: '#f6b44c',
        role: 'owner',
        joinStatus: 'joined',
        banStatus: 'none',
        lastSeen: null,
        online: true,
      },
      {
        publicKey: '@rohan:mesh.test',
        displayName: 'Rohan',
        avatarColor: '#5cc8ff',
        role: 'admin',
        joinStatus: 'joined',
        banStatus: 'none',
        lastSeen: null,
        online: true,
      },
      {
        publicKey: '@zoe:mesh.test',
        displayName: 'Zoe',
        avatarColor: '#8c7cff',
        role: 'member',
        joinStatus: 'joined',
        banStatus: 'none',
        lastSeen: null,
        online: false,
      },
    ])

    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="people-roles" onClose={() => {}} />,
      )
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Community people')
    expect(document.body.textContent).toContain('3 people')
    expect(document.body.textContent).toContain('2 available')
    expect(document.body.textContent).toContain('2 verified roles')
    expect(document.body.textContent).toContain('Verified actions only')
    expect(document.body.textContent).toContain('Current roster')
    expect(document.body.textContent).toContain('3 shown')
    expect(document.body.textContent).toContain('Maya Chen')
    expect(document.body.textContent).toContain('Rohan')
    expect(document.body.textContent).toContain('Zoe')
  })

  it('does not invent Matrix ownership transfer, owner leave, or global deletion', async () => {
    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="danger" onClose={() => {}} />,
      )
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain("You can't leave while you're the owner")
    expect(document.body.textContent).toContain("doesn't support choosing a new owner yet")
    expect(document.body.textContent).toContain('Locked for safety')
    expect(document.body.textContent).toContain('This owner account must stay for now.')
    expect(document.body.textContent).toContain(
      'Nothing will be deleted or changed while the owner account stays',
    )
    expect(document.body.textContent).not.toContain('Leave Community')
    expect(document.body.textContent).not.toContain('Delete Community')
  })

  it('shows a bounded shared emoji library with privacy guidance and name validation', async () => {
    useServerEmojiStore.setState({
      byCommunity: {
        'community-1': [{
          shortcode: 'mesh_heart',
          body: 'Mesh heart',
          mxcUri: 'mxc://example/mesh-heart',
          contentType: 'image/png',
          width: 96,
          height: 96,
          sizeBytes: 6291,
          imageUrl: 'data:image/png;base64,preview',
        }],
      },
      loading: {},
    })

    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="emoji" onClose={() => {}} />,
      )
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Community emoji')
    expect(document.body.textContent).toContain('1 active')
    expect(document.body.textContent).toContain('Up to 100 emoji')
    expect(document.body.textContent).toContain('They are not protected like message text')
    expect(document.body.textContent).toContain(':mesh_heart:')

    const emojiName = inputForLabel('Emoji name')
    await act(async () => setInputValue(emojiName, 'has space'))
    expect(document.body.textContent).toContain('Use 2–32 letters, numbers, or underscores.')
    expect(findButton('Add emoji').disabled).toBe(true)

    const removeButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Remove mesh_heart emoji"]',
    )
    if (!removeButton) throw new Error('Remove emoji button not found')
    await act(async () => removeButton.click())
    expect(document.body.textContent).toContain('Remove :mesh_heart: for everyone in Design Club?')
    expect(document.activeElement?.textContent).toBe('Cancel')
    const confirmation = document.body.querySelector<HTMLElement>('[role="group"]')
    if (!confirmation) throw new Error('Remove emoji confirmation group not found')
    await act(async () => {
      confirmation.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
    })
    expect(document.activeElement).toBe(
      document.getElementById('community-emoji-remove-mesh_heart'),
    )
    expect(bridge.removeServerEmoji).not.toHaveBeenCalled()
  })

  it('uses a native one-use image grant for custom emoji uploads', async () => {
    const selection = {
      grant: '9dd2c034-0c90-4789-b6d7-b87d2bf66f2a',
      name: 'party-parrot.png',
      size: 4096,
      contentType: 'image/png',
    }
    vi.mocked(bridge.pickCustomEmojiGrant).mockResolvedValueOnce(selection)

    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="emoji" onClose={() => {}} />,
      )
      await Promise.resolve()
    })
    await act(async () => {
      findButton('Choose image').click()
      await Promise.resolve()
    })

    expect(bridge.pickCustomEmojiGrant).toHaveBeenCalledWith('community-1')
    expect(document.body.textContent).toContain('party-parrot.png')
    const selectionStatus = document.getElementById('community-emoji-selection')
    expect(selectionStatus?.getAttribute('role')).toBe('status')
    expect(findButton('Choose a different image').getAttribute('aria-describedby')).toContain(
      'community-emoji-selection',
    )
    await act(async () => setInputValue(inputForLabel('Emoji name'), 'party_parrot'))
    await act(async () => {
      findButton('Add emoji').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(bridge.uploadServerEmoji).toHaveBeenCalledWith(
      'community-1',
      'party_parrot',
      selection,
    )
  })

  it('preserves selection on picker cancellation and revokes replaced or removed grants', async () => {
    const first = {
      grant: '881e5ab8-d4c4-4eea-9651-bd847248496d',
      name: 'first.png',
      size: 1024,
      contentType: 'image/png',
    }
    const second = {
      grant: '5c475b0d-8382-4b03-834f-9b718cd6e50f',
      name: 'second.webp',
      size: 2048,
      contentType: 'image/webp',
    }
    vi.mocked(bridge.pickCustomEmojiGrant)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(second)
    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="emoji" onClose={() => {}} />,
      )
      await Promise.resolve()
    })
    await act(async () => {
      findButton('Choose image').click()
      await Promise.resolve()
    })
    await act(async () => {
      findButton('Choose a different image').click()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('first.png')
    expect(bridge.discardAttachmentGrant).not.toHaveBeenCalled()

    await act(async () => {
      findButton('Choose a different image').click()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('second.webp')
    expect(bridge.discardAttachmentGrant).toHaveBeenCalledWith(first.grant)

    const removeSelection = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Remove selected image"]',
    )
    if (!removeSelection) throw new Error('Remove selected image button not found')
    await act(async () => removeSelection.click())
    expect(bridge.discardAttachmentGrant).toHaveBeenCalledWith(second.grant)
    expect(findButton('Choose image')).toBeDefined()
  })

  it('keeps confirmed upload success distinct from delayed reconciliation', async () => {
    const selection = {
      grant: '3f2289e7-918e-432b-af86-09e83698cf81',
      name: 'victory.png',
      size: 2048,
      contentType: 'image/png',
    }
    vi.mocked(bridge.pickCustomEmojiGrant).mockResolvedValueOnce(selection)
    vi.mocked(bridge.matrixSyncOnce).mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="emoji" onClose={() => {}} />,
      )
      await Promise.resolve()
    })
    await act(async () => {
      findButton('Choose image').click()
      await Promise.resolve()
    })
    await act(async () => setInputValue(inputForLabel('Emoji name'), 'victory'))
    await act(async () => {
      findButton('Add emoji').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain(':victory: was added to Design Club')
    expect(document.body.textContent).toContain('It may take a moment to appear.')
    expect(document.body.textContent).not.toContain("Mesh couldn't update")
  })

  it('explains one-use grant recovery and focuses the picker after upload failure', async () => {
    const selection = {
      grant: '23c43272-d3c8-4631-a591-e0ca7111ef66',
      name: 'retry-me.png',
      size: 2048,
      contentType: 'image/png',
    }
    vi.mocked(bridge.pickCustomEmojiGrant).mockResolvedValueOnce(selection)
    vi.mocked(bridge.uploadServerEmoji).mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="emoji" onClose={() => {}} />,
      )
      await Promise.resolve()
    })
    await act(async () => {
      findButton('Choose image').click()
      await Promise.resolve()
    })
    await act(async () => setInputValue(inputForLabel('Emoji name'), 'retry_me'))
    await act(async () => {
      findButton('Add emoji').click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain(
      'retry-me.png was not uploaded. Choose the image again to retry.',
    )
    expect(findButton('Choose image again')).toBeDefined()
    expect(document.activeElement).toBe(findButton('Choose image'))
  })

  it('blocks duplicate custom emoji names before consuming an image grant', async () => {
    useServerEmojiStore.setState({
      byCommunity: {
        'community-1': [{
          shortcode: 'mesh_heart',
          body: 'Mesh heart',
          mxcUri: 'mxc://example/mesh-heart',
          contentType: 'image/png',
          width: 96,
          height: 96,
          sizeBytes: 1024,
          imageUrl: 'data:image/png;base64,preview',
        }],
      },
      loading: {},
    })
    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="emoji" onClose={() => {}} />,
      )
      await Promise.resolve()
    })
    await act(async () => setInputValue(inputForLabel('Emoji name'), 'mesh_heart'))

    expect(document.body.textContent).toContain('That emoji name is already in use.')
    expect(findButton('Add emoji').disabled).toBe(true)
    expect(bridge.uploadServerEmoji).not.toHaveBeenCalled()
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
    const emojiPicker = findButton('Choose image')
    expect(emojiPicker.getAttribute('aria-describedby')).toContain(
      'community-emoji-file-description',
    )
  })

  it('separates community discovery from account hosting and confirms join-request decisions', async () => {
    vi.mocked(bridge.getCommunityApplications).mockResolvedValueOnce([{
      userId: '@avery:remote.example',
      displayName: 'Avery Stone',
      reason: 'I would love to help with the next playtest.',
      requestedAt: '2026-08-04T21:18:00.000Z',
    }])

    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="discovery-access" onClose={() => {}} />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Discovery and joining')
    expect(document.body.textContent).toContain('Not publicly listed')
    expect(document.body.textContent).toContain('Invitation only')
    expect(document.body.textContent).toContain(
      'People can keep their account with any compatible service.',
    )
    expect(document.body.textContent).toContain('1 waiting')

    await act(async () => {
      findButton('Approve').click()
      await Promise.resolve()
    })

    expect(bridge.respondToCommunityApplication).toHaveBeenCalledWith(
      'community-1',
      '@avery:remote.example',
      true,
      undefined,
    )
    expect(document.body.textContent).toContain('Avery Stone approved.')
    expect(document.body.textContent).toContain('No requests waiting')
  })

  it('presents moderation as immediate confirmed outcomes without inventing an audit history', async () => {
    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="moderation" onClose={() => {}} />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Moderation outcomes')
    expect(document.body.textContent).toContain(
      'Action confirmation, not an administrator history',
    )
    expect(document.body.textContent).toContain(
      'Mesh does not currently provide an authoritative administrator-action history.',
    )
    expect(document.body.textContent).toContain('Unverified events are never presented as an audit log.')
    expect(document.body.textContent).toContain('No confirmed outcomes available')
  })

  it('bounds editable community and room names before native calls', async () => {
    await renderSettings()

    const communityName = inputForLabel('Community Name')
    const communityDescription = document.getElementById('community-description')
    if (!(communityDescription instanceof HTMLTextAreaElement)) {
      throw new Error('Community description not found')
    }
    expect(communityName.maxLength).toBe(COMMUNITY_NAME_MAX_LENGTH)
    expect(communityDescription.maxLength).toBe(COMMUNITY_DESCRIPTION_MAX_LENGTH)
    expect(communityDescription.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.body.textContent).toContain(
      `${COMMUNITY_NAME_MAX_LENGTH - 'Design Club'.length} characters remaining.`,
    )
    expect(document.body.textContent).toContain(
      `${COMMUNITY_DESCRIPTION_MAX_LENGTH - 'A thoughtful place'.length} characters remaining.`,
    )

    await act(async () => {
      setInputValue(communityName, 'n'.repeat(COMMUNITY_NAME_MAX_LENGTH + 1))
    })
    expect(communityName.getAttribute('aria-invalid')).toBe('true')
    expect(document.body.textContent).toContain(
      `Community name must be ${COMMUNITY_NAME_MAX_LENGTH} characters or fewer.`,
    )
    expect(findButton('Save Changes').disabled).toBe(true)
    findButton('Save Changes').click()
    expect(bridge.updateCommunityMetadata).not.toHaveBeenCalled()

    await act(async () => findButton('Create room').click())
    const roomName = inputForLabel('Room name')
    expect(roomName.maxLength).toBe(CHANNEL_NAME_MAX_LENGTH)
    await act(async () => {
      setInputValue(roomName, 'r'.repeat(CHANNEL_NAME_MAX_LENGTH + 1))
    })
    expect(roomName.getAttribute('aria-invalid')).toBe('true')
    expect(document.body.textContent).toContain(
      `Room name must be ${CHANNEL_NAME_MAX_LENGTH} characters or fewer.`,
    )
    expect(findButton('Create room').disabled).toBe(true)
    findButton('Create room').click()
    expect(bridge.createChannel).not.toHaveBeenCalled()
  })

  it('shows current room inventory and the fail-closed voice creation state', async () => {
    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="rooms-voice" onClose={() => {}} />,
      )
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Rooms and voice')
    expect(document.body.textContent).toContain('announcements')
    expect(document.body.textContent).toContain('Lounge')
    expect(document.body.textContent).toContain('2 total')

    await act(async () => findButton('Create room').click())
    expect(document.body.textContent).toContain('Voice calling is coming soon')
    expect(document.body.textContent).toContain(
      'Voice room creation returns automatically when private calling is ready.',
    )
  })

  it('searches and focuses a calm section index without hiding authority or opening destructive state', async () => {
    window.location.hash = '#community-settings-danger'
    await renderSettings()

    expect(document.body.textContent).not.toContain('Leave Design Club?')
    const search = inputForLabel('Find a settings section')
    await act(async () => setInputValue(search, 'moderation'))

    const sectionNavigation = document.body.querySelector('nav[aria-label="Community settings sections"]')
    expect(sectionNavigation?.textContent).toContain('Moderation activity')
    expect(sectionNavigation?.textContent).not.toContain('Danger zone')
    // Navigation filtering never hides the underlying authority disclosure.
    expect(document.body.textContent).toContain(
      'Mesh does not currently provide an authoritative administrator-action history.',
    )

    await act(async () => findButton('Moderation activity').click())
    expect(document.activeElement?.id).toBe('community-settings-moderation')
    window.location.hash = ''
  })

  it('renders invitations directly in the routed administration surface without nesting a dialog', async () => {
    await act(async () => {
      root.render(
        <CommunitySettings
          embedded
          isOpen
          activeSection="invitations"
          onClose={() => {}}
        />,
      )
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).toContain('Invitations for Design Club')
    expect(document.body.textContent).toContain(
      'It never changes where someone keeps their account.',
    )
    expect(document.body.textContent).not.toContain('Overview')
    expect(findButton('Create invite link')).toBeDefined()
  })

  async function renderSettings() {
    await act(async () => {
      root.render(<CommunitySettings isOpen onClose={() => {}} />)
      await Promise.resolve()
    })
  }

  function setCommunityRole(role: 'owner' | 'admin' | 'member') {
    const current = useCommunityStore.getState().communityEntities['community-1']
    const next = { ...current, role }
    useCommunityStore.setState({
      communityEntities: { 'community-1': next },
      communities: [next],
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
