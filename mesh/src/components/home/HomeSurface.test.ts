import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingInvitationMetadata } from '../../types/ipc'
import * as bridge from '../../lib/bridge'
import { useShellStore } from '../../store/shell'
import { discardSavedInvitation, safeActivitySummary } from './HomeSurface'

beforeEach(() => {
  vi.restoreAllMocks()
  useShellStore.setState({
    pendingInvitation: null,
    foregroundInvitationHandle: null,
  })
})

describe('Home privacy summaries', () => {
  it('hides message content when notification previews are off', () => {
    expect(safeActivitySummary(false, 3, 'Meet in the hidden room', 'Maya')).toBe(
      'New activity',
    )
  })

  it('shows bounded content only when previews are allowed', () => {
    const summary = safeActivitySummary(true, 1, `  ${'a'.repeat(160)}  `, 'Maya')
    expect(summary.startsWith('Maya: ')).toBe(true)
    expect(summary).toHaveLength('Maya: '.length + 120)
  })

  it('uses a neutral fallback when there is no visible message', () => {
    expect(safeActivitySummary(true, 0)).toBe('Open conversation')
    expect(safeActivitySummary(false, 2)).toBe('New activity')
  })
})

describe('Home invitation actions', () => {
  it('clears the native invitation before removing its renderer summary', async () => {
    const pending = pendingInvitation('saved-invitation')
    useShellStore.getState().setPendingInvitation(pending)
    vi.spyOn(bridge, 'clearPendingInvitation').mockResolvedValue()

    await expect(discardSavedInvitation(pending.handle)).resolves.toBe(true)
    expect(bridge.clearPendingInvitation).toHaveBeenCalledWith(pending.handle)
    expect(useShellStore.getState().pendingInvitation).toBeNull()
  })

  it('does not clear a newer invitation when an older native discard finishes', async () => {
    const older = pendingInvitation('older-invitation')
    const newer = pendingInvitation('newer-invitation')
    useShellStore.getState().setPendingInvitation(older)
    vi.spyOn(bridge, 'clearPendingInvitation').mockImplementation(async () => {
      useShellStore.getState().setPendingInvitation(newer)
    })

    await expect(discardSavedInvitation(older.handle)).resolves.toBe(false)
    expect(useShellStore.getState().pendingInvitation).toEqual(newer)
  })
})

function pendingInvitation(handle: string): PendingInvitationMetadata {
  return {
    handle,
    roomOrAlias: '#party:example.org',
    via: ['example.org'],
    service: null,
    admissionService: null,
    communityName: 'Canyon Crew',
    storedAt: 1_786_000_000_000,
    expiresAt: 1_786_086_400_000,
  }
}
