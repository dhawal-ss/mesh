import { beforeEach, describe, expect, it } from 'vitest'
import { useShellStore } from './shell'

describe('shell navigation state', () => {
  beforeEach(() => {
    useShellStore.setState({
      serverModalOpen: false,
      serverModalTab: 'create',
      inviteDraft: '',
      profileOpen: false,
    })
  })

  it('opens the join flow with a pasted first-run invite', () => {
    useShellStore.getState().openServerModal('join', 'https://mesh.app/i/aB3xK9')

    expect(useShellStore.getState()).toMatchObject({
      serverModalOpen: true,
      serverModalTab: 'join',
      inviteDraft: 'https://mesh.app/i/aB3xK9',
    })

    useShellStore.getState().closeServerModal()
    expect(useShellStore.getState()).toMatchObject({
      serverModalOpen: false,
      inviteDraft: '',
    })
  })

  it('opens Profile independently of the server modal', () => {
    useShellStore.getState().setProfileOpen(true)
    expect(useShellStore.getState().profileOpen).toBe(true)
    expect(useShellStore.getState().serverModalOpen).toBe(false)
  })
})
