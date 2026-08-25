import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BetaFeedbackDialog, BetaInfoPanel } from './BetaCenter'

describe('Beta center', () => {
  let container: HTMLDivElement
  let root: Root
  let originalClipboard: Clipboard

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    originalClipboard = navigator.clipboard
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    })
    vi.unstubAllGlobals()
  })

  it('shows version, known issues, update path, and privacy path on one page', async () => {
    const onOpenFeedback = vi.fn()
    await act(async () => root.render(<BetaInfoPanel onOpenFeedback={onOpenFeedback} />))

    expect(container.textContent).toContain('Version 0.2.0')
    expect(container.textContent).toContain('Known issues')
    expect(container.textContent).toContain('Automatic updates are not included')
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://mesh.dhawal.org/download/"]')).not.toBeNull()
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://mesh.dhawal.org/privacy/"]')).not.toBeNull()

    const feedbackButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Send feedback'),
    )
    await act(async () => feedbackButton?.click())
    expect(onOpenFeedback).toHaveBeenCalledTimes(1)
  })

  it('copies a portable report with automatic context and no private identifiers', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    await act(async () => root.render(
      <BetaFeedbackDialog
        open
        onClose={() => {}}
        context={{ area: 'Direct messages', callActive: true, platform: 'Windows' }}
      />,
    ))

    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set
      setValue?.call(textarea, 'The reply button did not respond.')
      textarea?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const copyButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Copy feedback',
    )
    await act(async () => {
      copyButton?.click()
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledTimes(1)
    const report = writeText.mock.calls[0]?.[0]
    expect(report).toContain('Version: 0.2.0 beta')
    expect(report).toContain('Area: Direct messages')
    expect(report).toContain('Call active: Yes')
    expect(report).toContain('added no account address')
    expect(document.body.textContent).toContain('Feedback copied')
  })
})
