import { beforeEach, describe, expect, it } from 'vitest'
import { useShellStore } from './shell'

describe('shell navigation state', () => {
  beforeEach(() => {
    localStorage.clear()
    useShellStore.setState({
      serverModalOpen: false,
      serverModalTab: 'create',
      pendingInvitation: null,
      profileOpen: false,
      securityOpen: false,
      diagnosticsOpen: false,
    })
  })

  it('opens the join flow with a pasted first-run invite', () => {
    const pendingInvitation = {
      handle: 'a1b2c3d4',
      roomOrAlias: '#friends:example.org',
      via: ['example.org'],
      service: 'https://matrix.example.org',
      admissionService: null,
      storedAt: 1_752_000_000_000,
      expiresAt: 1_754_592_000_000,
    }
    useShellStore.getState().setPendingInvitation(pendingInvitation)
    useShellStore.getState().openServerModal('join')

    expect(useShellStore.getState()).toMatchObject({
      serverModalOpen: true,
      serverModalTab: 'join',
      pendingInvitation,
    })

    useShellStore.getState().closeServerModal()
    expect(useShellStore.getState()).toMatchObject({
      serverModalOpen: false,
      pendingInvitation,
    })
  })

  it('does not persist invitation secrets in localStorage', () => {
    useShellStore.getState().setPendingInvitation({
      handle: 'a1b2c3d4',
      roomOrAlias: '!friends:example.org',
      via: ['example.org'],
      service: null,
      admissionService: 'https://invites.example.org',
      storedAt: 1_752_000_000_000,
      expiresAt: 1_754_592_000_000,
    })

    expect(localStorage.getItem('mesh-pending-invitation')).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('opens Profile independently of the server modal', () => {
    useShellStore.getState().setProfileOpen(true)
    expect(useShellStore.getState().profileOpen).toBe(true)
    expect(useShellStore.getState().serverModalOpen).toBe(false)
  })

  it('opens device security directly from room context', () => {
    useShellStore.getState().setSecurityOpen(true)

    expect(useShellStore.getState().securityOpen).toBe(true)
    expect(useShellStore.getState().profileOpen).toBe(false)
  })

  it('opens call diagnostics from fail-closed voice', () => {
    useShellStore.getState().setDiagnosticsOpen(true)
    expect(useShellStore.getState().diagnosticsOpen).toBe(true)
  })
})
