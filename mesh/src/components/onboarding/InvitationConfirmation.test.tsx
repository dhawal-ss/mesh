import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingInvitationMetadata } from '../../types/ipc'
import { InvitationConfirmation } from './InvitationConfirmation'

describe('InvitationConfirmation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('requires confirmation before an approval-required invitation can run', async () => {
    const onConfirm = vi.fn()
    await render({
      communityName: 'Garden Club',
      inviterDisplayName: 'Alice',
      joinRule: 'knock',
      communityServiceDisplayName: 'Community Accounts',
    }, onConfirm)

    expect(onConfirm).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Garden Club')
    expect(document.body.textContent).toContain('Invited by Alice')
    expect(document.body.textContent).toContain('Requires administrator approval')
    expect(document.body.textContent).toContain('Community Accounts')

    await act(async () => findButton('Request to join').click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('degrades gracefully when inviter and access details are unknown', async () => {
    const onConfirm = vi.fn()
    await render({}, onConfirm)

    expect(document.body.textContent).toContain('Invited community')
    expect(document.body.textContent).toContain('Inviter information is not available')
    expect(document.body.textContent).toContain('Mesh will check access after you confirm')
    expect(document.body.textContent).not.toContain('undefined')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  async function render(
    overrides: Partial<PendingInvitationMetadata>,
    onConfirm: () => void,
  ) {
    const pending: PendingInvitationMetadata = {
      handle: 'pending-1',
      roomOrAlias: '!garden:community.example',
      via: ['community.example'],
      service: 'https://matrix.community.example',
      admissionService: null,
      storedAt: 1_752_000_000_000,
      expiresAt: 1_754_592_000_000,
      ...overrides,
    }
    await act(async () => {
      root.render(
        <InvitationConfirmation
          pending={pending}
          onConfirm={onConfirm}
          onDiscard={() => {}}
        />,
      )
    })
  }

  function findButton(label: string): HTMLButtonElement {
    const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === label)
    if (!button) throw new Error(`Button not found: ${label}`)
    return button
  }
})
