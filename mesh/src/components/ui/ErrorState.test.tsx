import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../lib/errors'
import { ErrorState } from './ErrorState'

describe('ErrorState', () => {
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
    vi.restoreAllMocks()
  })

  it('renders accessible friendly copy with collapsed technical details', async () => {
    await act(async () => {
      root.render(
        <ErrorState
          error={new AppError('network_unavailable', 'connection refused at 127.0.0.1:8008')}
          context={{ operation: 'load diagnostics' }}
        />,
      )
    })

    const alert = container.querySelector('[role="alert"]')
    const heading = container.querySelector('h3')
    const details = container.querySelector('details')
    expect(alert).toBeTruthy()
    expect(alert?.getAttribute('aria-labelledby')).toBe(heading?.id)
    expect(heading?.textContent).toBe('Connection interrupted')
    expect(heading?.textContent).not.toContain('127.0.0.1')
    expect(details?.hasAttribute('open')).toBe(false)
    expect(details?.textContent).toContain('connection refused')
  })

  it('runs the primary action using the translated action label', async () => {
    const onAction = vi.fn()
    await act(async () => {
      root.render(
        <ErrorState
          error={new AppError('network_unavailable', 'offline')}
          context={{ operation: 'send this attachment' }}
          onAction={onAction}
        />,
      )
    })

    const action = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    )
    expect(action).toBeTruthy()
    await act(async () => action?.click())
    expect(onAction).toHaveBeenCalledOnce()
  })

  it('copies only the sanitized disclosure detail and announces success', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    await act(async () => {
      root.render(
        <ErrorState
          error={new AppError('unknown', 'failed at C:\\Users\\alice\\secret.txt token=hunter2')}
        />,
      )
    })

    const copy = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Copy details',
    )
    await act(async () => {
      copy?.click()
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledOnce()
    const copied = writeText.mock.calls[0][0]
    expect(copied).toContain('[local path]')
    expect(copied).toContain('token=[redacted]')
    expect(copied).not.toContain('hunter2')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Copied')
  })
})
