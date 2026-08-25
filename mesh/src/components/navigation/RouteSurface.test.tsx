import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCommunityStore } from '../../store/communities'
import { RouteSurface } from './RouteSurface'

vi.mock('../community/CommunitySettings', () => ({
  CommunitySettings: ({ activeSection }: { activeSection: string }) => (
    <p>Administration body for {activeSection}</p>
  ),
}))

describe('community administration route', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    useCommunityStore.setState({
      communityEntities: {
        'community-1': {
          id: 'community-1',
          name: 'Lantern Guild',
          description: '',
          avatarUrl: null,
          memberCount: 4,
          role: 'owner',
          joinedAt: '2026-07-25T12:00:00.000Z',
        },
      },
      communityOrder: ['community-1'],
      activeCommunityId: 'community-1',
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function renderAdmin(section: 'general' | 'discovery-access') {
    await act(async () => {
      root.render(
        <RouteSurface
          route={{ kind: 'community-admin', communityId: 'community-1', section }}
          onSignInRequired={() => {}}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('opens the join-request review instead of falling back to General', async () => {
    await renderAdmin('discovery-access')

    const selected = container.querySelector('[role="tab"][aria-selected="true"]')
    expect(selected?.textContent).toContain('Join requests')
    expect(container.textContent).toContain('Administration body for discovery-access')
  })

  it('lists join requests between invitations and moderation on both navigations', async () => {
    await renderAdmin('general')

    const tabTitles = Array.from(container.querySelectorAll('[role="tab"] span:first-child'))
      .map((title) => title.textContent)
    expect(tabTitles).toEqual([
      'General',
      'People and roles',
      'Rooms and voice',
      'Invitations',
      'Join requests',
      'Moderation',
      'Danger',
    ])
    expect(Array.from(container.querySelectorAll('option')).map((option) => option.value))
      .toContain('discovery-access')
  })

  /*
    The Communities masthead carried a sentence naming the three things you can
    do here, directly above the three controls that do them, each of which
    already names itself and then explains itself again on selection. Three
    layers of the same list; the controls are the one a person can click.
  */
  it('does not narrate the community actions above the community actions', async () => {
    await act(async () => {
      root.render(
        <RouteSurface
          route={{ kind: 'communities', mode: 'join' }}
          onSignInRequired={() => {}}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Find a community')
    expect(container.textContent).toContain('Join with an invitation')
    expect(container.textContent).toContain('Create a community')
    expect(container.textContent).not.toContain('open an invitation, or start your own')
  })

  it('renders the section body as a named tab panel, not a nested main landmark', async () => {
    await renderAdmin('general')

    expect(container.querySelector('main')).toBeNull()
    const panel = container.querySelector('[role="tabpanel"]')
    expect(panel?.id).toBe('mesh-community-admin-panel')
    expect(panel?.getAttribute('tabindex')).toBe('0')

    const selected = container.querySelector('[role="tab"][aria-selected="true"]')
    expect(panel?.getAttribute('aria-labelledby')).toBe(selected?.id)
    expect(selected?.id).toBeTruthy()
    for (const tab of container.querySelectorAll('[role="tab"]')) {
      expect(tab.getAttribute('aria-controls')).toBe('mesh-community-admin-panel')
    }
  })
})
