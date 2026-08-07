import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadyScreen } from './ReadyScreen'

describe('ReadyScreen', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('never claims account recovery or security without real recovery state', async () => {
    await act(async () => {
      root.render(
        <ReadyScreen
          backendKind="matrix"
          onComplete={() => {}}
          onBootstrap={async (update) => {
            update({ phase: 'ready', label: 'Ready', progress: 100 })
          }}
        />,
      )
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Signed in')
    expect(container.textContent).toContain('Conversations ready')
    expect(container.textContent).not.toContain('Account secured')
    expect(container.textContent?.toLowerCase()).not.toContain('recovery')
    expect(container.textContent).not.toContain('encrypted history restored')
    expect(container.querySelector('.bg-accent')).toBeTruthy()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Ready')
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100')
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toBe('Ready, 100%')
  })

  it('preserves the separate legacy peer setup checklist', async () => {
    await act(async () => {
      root.render(
        <ReadyScreen
          backendKind="legacy-p2p"
          onComplete={() => {}}
          onBootstrap={vi.fn(async (update) => {
            update({ phase: 'ready', label: 'Ready', progress: 100 })
          })}
        />,
      )
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Identity secured')
    expect(container.textContent).toContain('Peers discovered')
    expect(container.textContent).toContain('Rooms synced')
  })

  it('always offers a retry when final account setup is interrupted', async () => {
    const onBootstrap = vi.fn()
      .mockRejectedValueOnce({
        code: 'permission_denied',
        detail: 'M_FORBIDDEN from /_matrix/client',
        retryable: false,
      })
      .mockImplementationOnce(async (update) => {
        update({ phase: 'ready', label: 'Ready', progress: 100 })
      })

    await act(async () => {
      root.render(
        <ReadyScreen
          backendKind="matrix"
          onComplete={() => {}}
          onBootstrap={onBootstrap}
        />,
      )
      await Promise.resolve()
    })

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    )
    const errorSummary = Array.from(container.querySelectorAll('h3, p'))
      .map((element) => element.textContent ?? '')
      .join(' ')
    expect(retry).toBeTruthy()
    expect(errorSummary).not.toContain('M_FORBIDDEN')
    expect(errorSummary).not.toContain('/_matrix/client')
    expect(container.querySelector('details')?.open).toBe(false)

    await act(async () => {
      retry?.click()
      await Promise.resolve()
    })

    expect(onBootstrap).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Ready')
  })
})
