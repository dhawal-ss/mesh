import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }))
vi.mock('../../lib/bridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/bridge')>(),
  listCommunityInvites: vi.fn(async () => []),
  discardPendingInvitation: vi.fn(async () => true),
}))

import { HomeSurface } from './HomeSurface'
import { useChannelStore } from '../../store/channels'
import { useCommunityStore } from '../../store/communities'
import { useMessageStore } from '../../store/messages'
import { useMeshNavigationStore } from '../../store/navigation'
import { useShellStore } from '../../store/shell'

const COMMUNITY_ID = '+lantern:mesh.test'

const voiceRoom = {
  id: '!voice:mesh.test',
  communityId: COMMUNITY_ID,
  name: 'hangout',
  topic: '',
  channelType: 'voice' as const,
  unreadCount: 0,
  joined: true,
}

function seedTwoRooms() {
  useCommunityStore.setState({
    communityEntities: {
      [COMMUNITY_ID]: {
        id: COMMUNITY_ID,
        name: 'Lantern Guild',
        handle: 'lantern',
        memberCount: 15,
      },
    },
  } as never)
  const rooms = ['!one:mesh.test', '!two:mesh.test', '!three:mesh.test'].map((id, index) => ({
    id,
    communityId: COMMUNITY_ID,
    name: ['concept-art', 'trail-talk', 'dev-log'][index],
    topic: '',
    channelType: 'text' as const,
    unreadCount: 0,
    joined: true,
  }))
  useChannelStore.setState({
    channels: rooms,
    channelEntities: Object.fromEntries(rooms.map((room) => [room.id, room])),
  } as never)
  useMessageStore.setState({
    messages: Object.fromEntries(rooms.map((room) => [
      room.id,
      [{
        id: `$msg-${room.id}`,
        channelId: room.id,
        authorId: '@maya:mesh.test',
        authorDisplayName: 'Maya Chen',
        content: 'The warmer pass is ready for another look.',
        timestamp: 1_700_000_000_000,
      }],
    ])),
  } as never)
  useMeshNavigationStore.setState({
    recents: rooms.map((room, index) => ({
      route: { kind: 'room', communityId: COMMUNITY_ID, roomId: room.id },
      lastOpenedAt: 1_700_000_000_000 - index * 1000,
    })),
  } as never)
}

describe('HomeSurface', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useShellStore.setState({ pendingInvitation: null } as never)
    seedTwoRooms()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  async function renderHome() {
    await act(async () => {
      root.render(<HomeSurface />)
      await Promise.resolve()
    })
    return container
  }

  it('gives the route its poster masthead, and leaves the editorial lead at reading size', async () => {
    const home = await renderHome()

    const heading = home.querySelector('[data-mesh-route-heading]')
    expect(heading?.className).toContain('text-display-sm')
    expect(heading?.className).not.toContain('text-headline-md')

    // The lead quotes what somebody said. Prose set at poster scale and clamped
    // to two lines makes the loudest thing on the surface a truncated fragment.
    const lead = home.querySelector('.mesh-home-feature-title')
    if (lead) {
      expect(lead.className).toContain('text-headline-md')
      expect(lead.className).not.toContain('text-headline-lg')
    }
  })

  /*
    A masthead greets nobody. "Good to see you, Taylor." sat between the route
    title and the first thing a person came here to act on, and told them their
    own name; the surface below it is a list of places to resume, and every
    pixel spent above that list is a pixel of it pushed off screen.
  */
  it('spends the masthead on the route rather than on a greeting', async () => {
    const home = await renderHome()

    expect(home.textContent).not.toContain('Good to see you')
    expect(home.querySelector('[data-mesh-route-heading]')?.textContent).toBe('Home')
  })

  /*
    Nobody is in a call almost all of the time, and Home spent its first section
    on saying so: a heading, a zero, and two lines whose only offered action was
    "Keep chatting", which is the name of the very next section. The rule is
    already written beside the Invitations section; Live now is cited there as
    the precedent for it while not actually following it.
  */
  it('collapses the live section instead of announcing that nobody is in a call', async () => {
    const home = await renderHome()

    expect(home.textContent).not.toContain('Nobody in voice yet')
    expect(home.textContent).not.toContain('Live now')
    // The resumption target the surface exists for still leads.
    expect(home.textContent).toContain('Continue')
  })

  /*
    With one room open there is a continuation card and nothing else, and the
    index below it still drew its rule, its heading, and a zero, to say "You
    are caught up. More recent rooms and direct messages will collect here."
    directly under the card that is the only thing there is to do.
  */
  it('collapses the index when the continuation card is already the whole list', async () => {
    const only = useChannelStore.getState().channels[0]
    useMeshNavigationStore.setState({
      recents: [{
        route: { kind: 'room', communityId: COMMUNITY_ID, roomId: only.id },
        lastOpenedAt: 1_700_000_000_000,
      }],
    } as never)

    const home = await renderHome()

    expect(home.textContent).toContain('Continue')
    expect(home.textContent).not.toContain('Also going on')
    expect(home.textContent).not.toContain('will collect here')
  })

  /*
    Changed deliberately from "leads a community with the thing to do": the card
    led with "Choose a room", which is identical on every community card, while
    the name that tells them apart sat in the support line. The kicker directly
    above already reads "Community", so the instruction restated the kicker, and
    a room with no message resolved right next to it by leading with its name.
    This is that rule applied to the one destination still exempt from it.
  */
  it('leads a community card with the community, not with an instruction', async () => {
    useMeshNavigationStore.setState({
      recents: [{
        route: { kind: 'community', communityId: COMMUNITY_ID },
        lastOpenedAt: 1_700_000_000_000,
      }],
    } as never)

    const home = await renderHome()

    const title = home.querySelector('.mesh-home-feature-title')
    expect(title?.textContent).toBe('Lantern Guild')
    expect(home.querySelector('[data-home-feature-source]')?.textContent).toBe('15 members')
    expect(home.querySelector('.mesh-home-feature-index')?.textContent).toContain('Community')
    expect(home.textContent).not.toContain('Choose a room')
  })

  it('leaves no empty invitations shell above the continuation target', async () => {
    const home = await renderHome()

    expect(home.textContent).not.toContain('Invitations you save for later will appear here')
  })

  it('still offers a saved invitation when one is waiting', async () => {
    useShellStore.setState({
      pendingInvitation: { handle: 'lantern', communityName: 'Lantern Guild' },
    } as never)

    const home = await renderHome()

    expect(home.textContent).toContain('Review the destination')
  })

  it('leads the continuation target with the waiting message, not the room slug', async () => {
    const home = await renderHome()

    const title = home.querySelector('.mesh-home-feature-title')
    expect(title?.textContent).toBe('Maya Chen: The warmer pass is ready for another look.')
  })

  it('names the room and community under the continuation target', async () => {
    const home = await renderHome()

    const support = home.querySelector('[data-home-feature-source]')
    expect(support?.textContent).toBe('concept-art in Lantern Guild')
  })

  /*
    The support line already ends in the room name, so a voice room that leads
    with its name too reads "hangout" over "hangout in Lantern Guild" and never
    says what kind of room it is.
  */
  it('leads a voice room with what it is rather than repeating its name', async () => {
    useChannelStore.setState({
      channels: [voiceRoom],
      channelEntities: { [voiceRoom.id]: voiceRoom },
    } as never)
    useMeshNavigationStore.setState({
      recents: [{
        route: { kind: 'voice', communityId: COMMUNITY_ID, roomId: voiceRoom.id },
        lastOpenedAt: 1_700_000_000_000,
      }],
    } as never)

    const home = await renderHome()

    expect(home.querySelector('.mesh-home-feature-title')?.textContent).toBe('Voice room')
    expect(home.querySelector('[data-home-feature-source]')?.textContent)
      .toBe('hangout in Lantern Guild')
  })

  it('greets the person instead of instructing them', async () => {
    const home = await renderHome()

    expect(home.textContent).not.toContain('Choose where to start')
  })

  it('invites you back in rather than naming a document type', async () => {
    const home = await renderHome()

    const kicker = home.querySelector('.mesh-home-feature-index')
    expect(kicker?.textContent).toContain('Continue')
    expect(kicker?.textContent).not.toContain('Conversation')
  })

  it('does not file the rest of the surface under conversations', async () => {
    const home = await renderHome()

    expect(home.textContent).not.toContain('More conversations')
    expect(home.textContent).toContain('Also going on')
  })

  it('names the destination when there is no message worth quoting', async () => {
    useMessageStore.setState({ messages: {} } as never)

    const home = await renderHome()

    const title = home.querySelector('.mesh-home-feature-title')
    expect(title?.textContent).toBe('concept-art')
    expect(title?.textContent).not.toContain('All caught up')
    // The support line names where the room is and stops. It used to append
    // "All caught up", which was the absence of the unread count said in words
    // directly beneath the destination the card exists to send somebody to.
    const support = home.querySelector('[data-home-feature-source]')
    expect(support?.textContent).toBe('Lantern Guild')
  })

  /*
    The numbering is gone with the gutter it sat in. A numeral said where a row
    was in a list somebody can already see, cost 34px of every label, and made
    two adjacent lists read as one sequence -- which is what this asserted. A
    Material 3 list item leads with a glyph or a mark instead.
  */
  it('leads its rows with a name rather than a position', async () => {
    const home = await renderHome()

    expect(home.querySelectorAll('[data-home-index]')).toHaveLength(0)
    expect(home.textContent).toContain('Lantern Guild')
  })
})
