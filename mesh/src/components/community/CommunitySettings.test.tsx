import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/bridge', () => ({
  isMatrixBackend: vi.fn(() => true),
  getMatrixUserId: vi.fn(() => '@taylor:mesh.test'),
  getBackendCapabilities: vi.fn(() => ({ directMessages: true })),
  getBackendStatusSnapshot: vi.fn(() => null),
  getCommunityApplications: vi.fn(async () => []),
  communityAccessSettings: vi.fn(async () => ({
    alias: null,
    discoverable: false,
    joinRule: 'invite',
  })),
  getModerationAudit: vi.fn(async () => []),
  respondToCommunityApplication: vi.fn(async () => undefined),
  updateCommunityMetadata: vi.fn(),
  matrixSetCommunityIcon: vi.fn(),
  matrixClearCommunityIcon: vi.fn(),
  // Avatar resolves an mxc address through this; the community image is one.
  matrixLoadProfileAvatar: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
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
          avatarUrl: null,
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
        avatarUrl: null,
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
          topic: '',
          channelType: 'text',
          unreadCount: 2,
          joined: true,
        },
        'room-voice': {
          id: 'room-voice',
          communityId: 'community-1',
          name: 'Lounge',
          topic: '',
          channelType: 'voice',
          unreadCount: 0,
          joined: true,
        },
      },
      channelOrder: ['room-text', 'room-voice'],
      channels: [
        {
          id: 'room-text',
          communityId: 'community-1',
          name: 'announcements',
          topic: '',
          channelType: 'text',
          unreadCount: 2,
          joined: true,
        },
        {
          id: 'room-voice',
          communityId: 'community-1',
          name: 'Lounge',
          topic: '',
          channelType: 'voice',
          unreadCount: 0,
          joined: true,
        },
      ],
      activeChannelId: 'room-text',
    })
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

    await act(async () => setInputValue(inputForLabel('Community name'), 'Design Club offline'))
    await act(async () => {
      findButton('Save changes').click()
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

    await act(async () => findButton('Leave community').click())
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

    expect(document.body.textContent).toContain('Community profile')
    expect(document.body.textContent).toContain('Community owner')
    expect(document.body.textContent).toContain('3 members')
    expect(document.body.textContent).toContain('Community service')
    expect(document.body.textContent).toContain('Up to date')
    expect(findButton('Save changes').disabled).toBe(true)

    await act(async () => setInputValue(inputForLabel('Community name'), 'Design Circle'))
    expect(document.body.textContent).toContain('Unsaved')
    expect(document.body.textContent).toContain('Review your changes before saving.')
    expect(findButton('Save changes').disabled).toBe(false)

    await act(async () => {
      findButton('Save changes').click()
      await Promise.resolve()
    })
    expect(bridge.updateCommunityMetadata).toHaveBeenCalledWith(
      'community-1',
      'Design Circle',
      'A thoughtful place',
    )
    expect(document.body.textContent).toContain('Community details saved.')
    expect(document.body.textContent).toContain('Up to date')
    expect(findButton('Save changes').disabled).toBe(true)
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
    // The card describes what it is for; it never sits next to a control and denies it.
    expect(document.body.textContent).toContain(
      'Membership and moderation actions confirm before they run.',
    )
    expect(document.body.textContent).not.toContain('stay unavailable')
    expect(document.body.textContent).not.toContain('ownership transfer')
    expect(document.body.textContent).toContain('Current roster')
    expect(document.body.textContent).toContain('3 in the community')
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
    // The rule that is enforced is stated once; no roadmap promise stands in for a feature.
    expect(document.body.textContent).not.toContain('A future update')
    expect(document.body.textContent).not.toContain('Leave community')
    expect(document.body.textContent).not.toContain('Delete community')
  })

  it('surfaces a failed owner deletion after explicit confirmation', async () => {
    vi.mocked(bridge.isMatrixBackend).mockReturnValue(false)
    vi.mocked(bridge.deleteCommunity).mockRejectedValue(new Error('offline'))
    await renderSettings()

    await act(async () => findButton('Delete community').click())
    expect(bridge.deleteCommunity).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Delete Design Club?')
    await act(async () => {
      findButton('Delete').click()
      await Promise.resolve()
    })

    expect(bridge.deleteCommunity).toHaveBeenCalledWith('community-1')
    expect(document.body.textContent).toContain("Mesh couldn't delete Design Club")
  })

  it('keeps join-request review and custom emoji administration while removing public discovery', async () => {
    await renderSettings()

    expect(document.body.textContent).toContain('Join requests')
    expect(document.body.textContent).not.toContain('Publicly listed')
    expect(document.body.textContent).not.toContain('List this community publicly')
    // Custom emoji administration is a deliberate owner/admin surface again.
    expect(document.body.textContent).toContain('Custom emoji')
  })

  it('reaches custom emoji administration from the routed general section', async () => {
    await act(async () => {
      root.render(
        <CommunitySettings embedded isOpen activeSection="general" onClose={() => {}} />,
      )
      await Promise.resolve()
    })

    /*
      Emoji management was gated on a section the router can never select, so its Add
      and Remove controls shipped as unreachable code. It belongs with the rest of
      community identity and customization.
    */
    expect(document.body.textContent).toContain('Custom emoji')
    expect(findButton('Add emoji').disabled).toBe(true)
    await act(async () => setInputValue(inputForLabel('Emoji name'), 'party_parrot'))
    expect(findButton('Add emoji').disabled).toBe(false)
  })

  it('confirms join-request decisions without exposing public discovery controls', async () => {
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

    expect(document.body.textContent).toContain('Join requests')
    expect(document.body.textContent).not.toContain('Publicly listed')
    expect(document.body.textContent).toContain('1 waiting')

    // The account address is shown beside the requester-chosen display name,
    // because approving on a name alone is how an impersonator gets in.
    expect(document.body.textContent).toContain('@avery:remote.example')

    await act(async () => {
      findButton('Approve').click()
      await Promise.resolve()
    })

    /*
      Approval grants access to every room and cannot be undone from here, so it
      is confirmed. It used to be a single unconfirmed click, while the
      reversible act of removing a member was already behind a confirmation.
    */
    expect(document.body.textContent).toContain('Approve Avery Stone?')
    expect(bridge.respondToCommunityApplication).not.toHaveBeenCalled()

    await act(async () => {
      findButton('Approve request').click()
      await Promise.resolve()
    })

    expect(bridge.respondToCommunityApplication).toHaveBeenCalledWith(
      'community-1',
      '@avery:remote.example',
      true,
      undefined,
    )
    expect(document.body.textContent).toContain('Avery Stone approved.')
    expect(document.body.textContent).toContain('No pending requests')
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
      'Mesh does not keep a complete administrator-action history across every account service.',
    )
    expect(document.body.textContent).toContain(
      'The result shows what changed in each room.',
    )
    /*
      The reader command fails closed by design, so a history panel could only ever
      render an error. It is gone, and nothing asks the backend for it.
    */
    expect(document.body.textContent).not.toContain('Recent confirmed outcomes')
    expect(document.body.textContent).not.toContain('Run a moderation action')
    expect(bridge.getModerationAudit).not.toHaveBeenCalled()
  })

  it('bounds editable community and room names before native calls', async () => {
    await renderSettings()

    const communityName = inputForLabel('Community name')
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
    expect(findButton('Save changes').disabled).toBe(true)
    findButton('Save changes').click()
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
    /*
      Voice routes are closed in this build, so the navigation hides voice rooms. This
      screen counts and lists exactly what the navigation can open, or the two disagree
      about a room made by another client.
    */
    expect(document.body.textContent).not.toContain('Lounge')
    expect(document.body.textContent).not.toContain('Voice rooms')
    expect(document.body.textContent).toContain('1 total')

    await act(async () => findButton('Create room').click())
    expect(document.body.textContent).toContain('Text room')
    expect(document.body.textContent).not.toContain('Voice room creation')
    expect(document.body.textContent).not.toContain('coming soon')
    expect(Array.from(document.body.querySelectorAll('button')).some(
      (button) => button.textContent?.trim() === 'Voice room',
    )).toBe(false)
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
      'Mesh does not keep a complete administrator-action history across every account service.',
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
      'An invitation never changes where someone keeps their account.',
    )
    expect(document.body.textContent).not.toContain('Overview')
    expect(findButton('Create invite link')).toBeDefined()
  })

  /*
    The drawer used to stack nine 22px headings, so nothing in it read as
    subordinate to anything else. The drawer title owns 22px; every group
    inside it sits on the 18px section step.
  */
  it('keeps one 22px heading per surface and puts groups on the section step', async () => {
    await renderSettings()

    const titles = [...document.body.querySelectorAll('[class*="text-title"]')]
    expect(titles).toHaveLength(1)
    expect(titles[0]?.textContent).toBe('Community settings')

    for (const label of ['Public details', 'Join requests', 'Rooms and voice', 'Custom emoji']) {
      const group = [...document.body.querySelectorAll('h3')].find(
        (heading) => heading.textContent?.trim() === label,
      )
      expect(group).toBeDefined()
      expect(group?.className).toContain('text-md')
    }
  })

  describe('community image', () => {
    function chooseFile(file: File) {
      const input = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="Choose a community image"]',
      )
      if (!input) throw new Error('The community image file input is not rendered')
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'crest.png', {
      type: 'image/png',
    })

    it('uploads a chosen image and shows it without waiting for the next sync', async () => {
      vi.mocked(bridge.matrixSetCommunityIcon).mockResolvedValue('mxc://mesh.test/crest')
      await renderSettings()

      await act(async () => {
        chooseFile(png())
        await Promise.resolve()
      })

      expect(bridge.matrixSetCommunityIcon).toHaveBeenCalledWith(
        'community-1',
        'crest.png',
        'image/png',
        expect.any(Uint8Array),
      )
      /*
        Patched locally the way saving name and description already is. Without
        this the rail and the summary card keep the generated mark until
        something else refreshes the community, which reads as the upload having
        silently failed.
      */
      expect(useCommunityStore.getState().communityEntities['community-1'].avatarUrl)
        .toBe('mxc://mesh.test/crest')
      /*
        The privacy disclosure has to survive the success notice. A first draft
        rendered both through one element with `iconNotice ?? disclosure`, which
        removed "everyone who can see this community can see the image" at the
        exact moment an image existed for them to see.
      */
      expect(document.body.textContent).toContain('Community image updated.')
      expect(document.body.textContent)
        .toContain('Everyone who can see this community can see the image')
    })

    it('removes the image and returns the community to its generated mark', async () => {
      setCommunityImage('mxc://mesh.test/crest')
      vi.mocked(bridge.matrixClearCommunityIcon).mockResolvedValue(undefined)
      await renderSettings()

      await act(async () => {
        findButton('Remove').click()
        await Promise.resolve()
      })

      expect(bridge.matrixClearCommunityIcon).toHaveBeenCalledWith('community-1')
      expect(useCommunityStore.getState().communityEntities['community-1'].avatarUrl).toBeNull()
    })

    it('reports a refused upload and leaves the community image alone', async () => {
      vi.mocked(bridge.matrixSetCommunityIcon).mockRejectedValue(
        new Error('your current role cannot change this image'),
      )
      await renderSettings()

      await act(async () => {
        chooseFile(png())
        await Promise.resolve()
      })

      // Not patched to a value the room never accepted.
      expect(useCommunityStore.getState().communityEntities['community-1'].avatarUrl).toBeNull()
      /*
        ErrorState names the operation and a next action rather than echoing the
        backend's sentence, which is the shell-wide rule: raw protocol detail
        stays behind an explicit disclosure.
      */
      expect(document.body.textContent).toContain("Mesh couldn't change the community image")
    })

    it('offers no image control to an ordinary member', async () => {
      /*
        The real gate is in Rust: `user_can_update_room_avatar` refuses the
        state write whatever the renderer shows. This only checks that a member
        is not offered an action that would fail.
      */
      setCommunityRole('member')
      await renderSettings()

      expect(
        document.body.querySelector('input[aria-label="Choose a community image"]'),
      ).toBeNull()
      expect(document.body.textContent).not.toContain('Community image')
    })

    function setCommunityImage(avatarUrl: string | null) {
      const current = useCommunityStore.getState().communityEntities['community-1']
      const next = { ...current, avatarUrl }
      useCommunityStore.setState({
        communityEntities: { 'community-1': next },
        communities: [next],
      })
    }
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
