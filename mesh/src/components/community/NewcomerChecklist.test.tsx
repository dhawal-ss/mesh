import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginNewcomerChecklist,
  markNewcomerDraftOpened,
} from '../../lib/onboarding-checklist'
import { NewcomerChecklist } from './NewcomerChecklist'

describe('NewcomerChecklist', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    beginNewcomerChecklist({
      accountId: '@alice:accounts.example',
      communityId: '!garden:community.example',
      occurredAt: 100,
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function renderChecklist({
    accountId = '@alice:accounts.example',
    communityJoined = true,
    channelOpened = false,
  }: {
    accountId?: string
    communityJoined?: boolean
    channelOpened?: boolean
  } = {}) {
    await act(async () => {
      root.render(
        <NewcomerChecklist
          accountId={accountId}
          communityId="!garden:community.example"
          communityName="Garden Party"
          accountSignedIn
          communityJoined={communityJoined}
          channelOpened={channelOpened}
        />,
      )
    })
  }

  it('shows authoritative and local progress without treating a selected room as a draft', async () => {
    await renderChecklist({ channelOpened: true })

    const progress = container.querySelector('[role="progressbar"]')
    expect(progress?.getAttribute('aria-valuenow')).toBe('4')
    expect(progress?.getAttribute('aria-valuetext')).toBe('4 of 5 steps complete')
    expect(container.textContent).toContain('Welcome to Garden Party')
    expect(container.textContent).toContain('Start a message not complete')

    await act(async () => {
      markNewcomerDraftOpened({
        accountId: '@alice:accounts.example',
        communityId: '!garden:community.example',
        occurredAt: 200,
      })
    })
    expect(progress?.getAttribute('aria-valuenow')).toBe('5')
    expect(container.textContent).toContain('Start a message complete')
  })

  it('can be dismissed and reopened with keyboard-operable controls', async () => {
    await renderChecklist()
    const hide = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide getting started"]',
    )
    expect(hide).not.toBeNull()

    await act(async () => hide?.click())
    const reopen = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Show getting started'))
    expect(reopen).toBeDefined()
    expect(document.activeElement).toBe(reopen)

    await act(async () => reopen?.click())
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull()
    expect(document.activeElement).toBe(container.querySelector(
      'button[aria-label="Hide getting started"]',
    ))
  })

  it('renders nothing when the active account does not own the local checklist', async () => {
    await renderChecklist({ accountId: '@bob:accounts.example' })
    expect(container.textContent).toBe('')
  })
})
