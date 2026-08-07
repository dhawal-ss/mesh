import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginNewcomerChecklist,
  clearNewcomerChecklistsForAccount,
  deriveNewcomerChecklistSteps,
  markNewcomerDraftOpened,
  NEWCOMER_CHECKLIST_STORAGE_KEY,
  newcomerChecklistScopeKey,
  readNewcomerChecklist,
  setNewcomerChecklistDismissed,
} from './onboarding-checklist'

describe('newcomer onboarding checklist', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts only after a confirmed invitation join and scopes facts by account and community', () => {
    expect(markNewcomerDraftOpened({
      accountId: '@alice:accounts.example',
      communityId: '!garden:community.example',
      occurredAt: 90,
    })).toBeNull()

    const started = beginNewcomerChecklist({
      accountId: '@alice:accounts.example',
      communityId: '!garden:community.example',
      occurredAt: 100,
    })

    expect(started).toMatchObject({
      accountId: '@alice:accounts.example',
      communityId: '!garden:community.example',
      invitationResolvedAt: 100,
      draftOpenedAt: null,
      dismissed: false,
    })
    expect(readNewcomerChecklist('@bob:accounts.example', '!garden:community.example'))
      .toBeNull()
    expect(readNewcomerChecklist('@alice:accounts.example', '!other:community.example'))
      .toBeNull()
    expect(newcomerChecklistScopeKey('@alice:accounts.example', '!garden:community.example'))
      .not.toBe(newcomerChecklistScopeKey('@bob:accounts.example', '!garden:community.example'))
  })

  it('records local draft focus, dismissal, and reopening without rewriting network facts', () => {
    beginNewcomerChecklist({
      accountId: '@alice:accounts.example',
      communityId: '!garden:community.example',
      occurredAt: 100,
    })
    markNewcomerDraftOpened({
      accountId: '@alice:accounts.example',
      communityId: '!garden:community.example',
      occurredAt: 200,
    })
    setNewcomerChecklistDismissed({
      accountId: '@alice:accounts.example',
      communityId: '!garden:community.example',
      dismissed: true,
      occurredAt: 300,
    })
    expect(readNewcomerChecklist('@alice:accounts.example', '!garden:community.example'))
      .toMatchObject({
        invitationResolvedAt: 100,
        draftOpenedAt: 200,
        dismissed: true,
      })

    setNewcomerChecklistDismissed({
      accountId: '@alice:accounts.example',
      communityId: '!garden:community.example',
      dismissed: false,
      occurredAt: 400,
    })
    expect(readNewcomerChecklist('@alice:accounts.example', '!garden:community.example'))
      .toMatchObject({ dismissed: false, invitationResolvedAt: 100, draftOpenedAt: 200 })
  })

  it('derives network completion only from current authoritative facts', () => {
    expect(deriveNewcomerChecklistSteps({
      accountSignedIn: true,
      invitationResolved: true,
      communityJoined: false,
      channelOpened: false,
      draftOpened: false,
    })).toEqual([
      { id: 'account-ready', label: 'Account ready', complete: true },
      { id: 'invitation-ready', label: 'Invitation confirmed', complete: true },
      { id: 'community-ready', label: 'Community joined', complete: false },
      { id: 'room-opened', label: 'Room opened', complete: false },
      { id: 'draft-opened', label: 'Start a message', complete: false },
    ])
  })

  it('removes only the departing account and tolerates denied storage', () => {
    beginNewcomerChecklist({
      accountId: '@alice:accounts.example',
      communityId: '!garden:community.example',
      occurredAt: 100,
    })
    beginNewcomerChecklist({
      accountId: '@bob:accounts.example',
      communityId: '!garden:community.example',
      occurredAt: 200,
    })

    expect(clearNewcomerChecklistsForAccount('@alice:accounts.example')).toBe(true)
    expect(readNewcomerChecklist('@alice:accounts.example', '!garden:community.example'))
      .toBeNull()
    expect(readNewcomerChecklist('@bob:accounts.example', '!garden:community.example'))
      .not.toBeNull()

    const denied = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(() => readNewcomerChecklist('@bob:accounts.example', '!garden:community.example'))
      .not.toThrow()
    expect(readNewcomerChecklist('@bob:accounts.example', '!garden:community.example'))
      .toBeNull()
    denied.mockRestore()
  })

  it('fails closed and clears malformed or oversized storage records', () => {
    localStorage.setItem(NEWCOMER_CHECKLIST_STORAGE_KEY, '{not-json')
    expect(readNewcomerChecklist('@alice:accounts.example', '!garden:community.example'))
      .toBeNull()
    expect(localStorage.getItem(NEWCOMER_CHECKLIST_STORAGE_KEY)).toBeNull()

    localStorage.setItem(NEWCOMER_CHECKLIST_STORAGE_KEY, 'x'.repeat(64 * 1024 + 1))
    expect(readNewcomerChecklist('@alice:accounts.example', '!garden:community.example'))
      .toBeNull()
    expect(localStorage.getItem(NEWCOMER_CHECKLIST_STORAGE_KEY)).toBeNull()
  })
})
