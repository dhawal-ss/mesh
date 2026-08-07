import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QueuedMessageSyncNotice } from './AppLayout'

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

describe('saved-message synchronization notice', () => {
  it('explains restore failure without implying saved messages were lost', async () => {
    const retry = vi.fn()
    await act(async () => root.render(
      <QueuedMessageSyncNotice status="failed" onRetry={retry} />,
    ))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Mesh couldn’t restore saved messages. They are still saved on this device.',
    )
    const button = container.querySelector<HTMLButtonElement>('button')
    expect(button?.textContent).toBe('Try again')
    await act(async () => button?.click())
    expect(retry).toHaveBeenCalledOnce()
  })

  it('uses a polite status when only live queue updates are degraded', async () => {
    await act(async () => root.render(
      <QueuedMessageSyncNotice status="degraded" onRetry={() => {}} />,
    ))

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Saved messages are visible, but their status may not update yet.',
    )
  })

  it('keeps retry feedback and focus visible while recovery is running', async () => {
    const retry = vi.fn()
    await act(async () => root.render(
      <QueuedMessageSyncNotice status="failed" onRetry={retry} />,
    ))
    const button = container.querySelector<HTMLButtonElement>('button')
    button?.focus()

    await act(async () => root.render(
      <QueuedMessageSyncNotice status="retrying-failed" onRetry={retry} />,
    ))

    const retryingButton = container.querySelector<HTMLButtonElement>('button')
    expect(retryingButton).toBe(button)
    expect(document.activeElement).toBe(retryingButton)
    expect(retryingButton?.disabled).toBe(true)
    expect(retryingButton?.textContent).toBe('Trying again…')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'They are still saved on this device.',
    )
  })

  it.each(['idle', 'loading', 'ready'] as const)('stays hidden while %s', async (status) => {
    await act(async () => root.render(
      <QueuedMessageSyncNotice status={status} onRetry={() => {}} />,
    ))
    expect(container.textContent).toBe('')
  })
})
