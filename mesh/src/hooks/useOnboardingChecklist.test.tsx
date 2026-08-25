import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useOnboardingChecklist, type OnboardingChecklistView } from './useOnboardingChecklist'
import { onboardingChecklistStorageKey } from '../lib/onboarding-checklist'
import { useChannelStore } from '../store/channels'
import { useCommunityStore } from '../store/communities'
import { useDraftStore } from '../store/drafts'
import { useIdentityStore } from '../store/identity'
import { useMessageStore } from '../store/messages'
import { useOnboardingChecklistStore } from '../store/onboarding-checklist'

const ACCOUNT = '@ada:example.org'
const ROOM = '!general:example.org'
const COMMUNITY = '+mesh:example.org'

let view: OnboardingChecklistView | null = null

function Probe() {
  view = useOnboardingChecklist()
  return null
}

function stepComplete(id: string): boolean {
  return view?.steps.find((step) => step.id === id)?.complete ?? false
}

describe('useOnboardingChecklist', () => {
  let container: HTMLDivElement
  let root: Root

  async function mount() {
    await act(() => {
      root.render(<Probe />)
    })
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    window.localStorage.clear()
    view = null
    useOnboardingChecklistStore.getState().resetForAccountTransition()
    useIdentityStore.getState().clear()
    useCommunityStore.setState({ communityEntities: {}, communityOrder: [], communities: [] })
    useChannelStore.setState({ activeChannelId: null })
    useMessageStore.setState({ messages: {}, messageOrder: {}, hasAuthoredMessage: false })
    useDraftStore.setState({ drafts: {} })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function signIn(avatarUrl: string | null = null) {
    useIdentityStore.getState().setIdentity({
      publicKey: ACCOUNT,
      displayName: 'Ada',
      avatarColor: '#000000',
      avatarUrl,
    })
  }

  it('stays out of the way until the snapshot and the account have loaded', async () => {
    await mount()
    expect(view?.active).toBe(false)

    await act(async () => {
      useOnboardingChecklistStore.getState().initialize(ACCOUNT)
    })
    // Hydrated, but nothing is known about the account yet.
    expect(view?.active).toBe(false)

    await act(async () => {
      signIn()
    })
    expect(view?.active).toBe(true)
  })

  /*
   * The gate that keeps a finished checklist from appearing to somebody who
   * finished it long ago. A room that has never been read looks message-free,
   * and the first steps would show as undone for as long as that read takes.
   */
  it('waits for the open room to be read before judging anything', async () => {
    await act(async () => {
      useOnboardingChecklistStore.getState().initialize(ACCOUNT)
      signIn('mxc://example.org/face')
      useChannelStore.setState({ activeChannelId: ROOM })
    })
    await mount()
    expect(view?.active).toBe(false)

    await act(async () => {
      useMessageStore.getState().setMessages(ROOM, [])
    })
    expect(view?.active).toBe(true)
  })

  /*
   * An empty room is the newcomer case, so it has to count as read. The message
   * store keeps an empty room out of `messageOrder` entirely, since an empty
   * order equals the absent default, which is why this reads `messages`.
   */
  it('treats a room that was read and found empty as read', async () => {
    await act(async () => {
      useOnboardingChecklistStore.getState().initialize(ACCOUNT)
      signIn()
      useChannelStore.setState({ activeChannelId: ROOM })
      useMessageStore.getState().setMessages(ROOM, [])
    })
    await mount()

    expect(useMessageStore.getState().messageOrder[ROOM]).toBeUndefined()
    expect(useMessageStore.getState().messages[ROOM]).toEqual([])
    expect(view?.active).toBe(true)
    expect(stepComplete('room')).toBe(true)
  })

  it('completes membership and profile steps from what the account already has', async () => {
    await act(async () => {
      useOnboardingChecklistStore.getState().initialize(ACCOUNT)
      signIn('mxc://example.org/face')
      useCommunityStore.setState({
        communityOrder: [COMMUNITY],
        communityEntities: {
          [COMMUNITY]: {
            id: COMMUNITY,
            name: 'Mesh',
            description: '',
            avatarUrl: null,
            memberCount: 2,
            role: 'member',
            joinedAt: null,
          },
        },
      })
    })
    await mount()

    expect(stepComplete('account')).toBe(true)
    expect(stepComplete('community')).toBe(true)
    expect(stepComplete('picture')).toBe(true)
    expect(view?.steps.filter((step) => step.next).map((step) => step.id)).toEqual(['room'])
  })

  it('keeps the message step once a draft has existed, and remembers it', async () => {
    await act(async () => {
      useOnboardingChecklistStore.getState().initialize(ACCOUNT)
      signIn()
    })
    await mount()
    expect(stepComplete('message')).toBe(false)

    await act(async () => {
      useDraftStore.getState().setDraft(ROOM, 'hello')
    })
    await settle()
    expect(stepComplete('message')).toBe(true)

    // Sending clears the draft. The step does not un-complete, and the record
    // survives a restart.
    await act(async () => {
      useDraftStore.getState().clearDraft(ROOM)
    })
    expect(stepComplete('message')).toBe(true)
    expect(window.localStorage.getItem(onboardingChecklistStorageKey(ACCOUNT)))
      .toContain('message')
  })

  it('goes quiet when hidden and comes back when asked for', async () => {
    await act(async () => {
      useOnboardingChecklistStore.getState().initialize(ACCOUNT)
      signIn()
    })
    await mount()
    expect(view?.active).toBe(true)

    await act(async () => {
      useOnboardingChecklistStore.getState().dismiss()
    })
    expect(view?.active).toBe(false)

    await act(async () => {
      useOnboardingChecklistStore.getState().show()
    })
    expect(view?.active).toBe(true)
    expect(view?.collapsed).toBe(false)
  })
})
