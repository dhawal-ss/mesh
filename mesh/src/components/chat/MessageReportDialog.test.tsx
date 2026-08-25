import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageReportDialog } from './MessageReportDialog'

/*
  This surface had no test of any kind, which is a poor place for that to be
  true: it is how a person reports abuse, and every failure mode here is silent
  from the reporter's side. A regressed submit handler looks exactly like a sent
  report unless something asserts otherwise.
*/

const bridgeMocks = vi.hoisted(() => ({
  reportMessage: vi.fn(),
  getBackendStatusSnapshot: vi.fn(() => null),
  getMatrixUserId: vi.fn(() => null),
}))
const toastMocks = vi.hoisted(() => ({ showToast: vi.fn() }))

vi.mock('../../lib/bridge', () => ({
  reportMessage: bridgeMocks.reportMessage,
  getBackendStatusSnapshot: bridgeMocks.getBackendStatusSnapshot,
  getMatrixUserId: bridgeMocks.getMatrixUserId,
}))
vi.mock('../ui/Toast', () => ({ showToast: toastMocks.showToast }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function button(label: string) {
  return Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes(label))
}

function setTextareaValue(value: string) {
  const textarea = document.body.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set
  setter?.call(textarea, value)
  textarea?.dispatchEvent(new Event('input', { bubbles: true }))
  return textarea
}

describe('MessageReportDialog', () => {
  let container: HTMLDivElement
  let root: Root
  const onClose = vi.fn()

  async function render(open = true) {
    await act(async () => {
      root.render(
        <MessageReportDialog
          open={open}
          roomId="!room:mesh.test"
          eventId="$event:mesh.test"
          onClose={onClose}
        />,
      )
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    bridgeMocks.reportMessage.mockReset()
    toastMocks.showToast.mockReset()
    onClose.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.querySelectorAll('[data-radix-portal]').forEach((portal) => portal.remove())
  })

  it('renders nothing until it is opened', async () => {
    await render(false)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(bridgeMocks.reportMessage).not.toHaveBeenCalled()
  })

  it('says plainly that this does not reach the community moderators', async () => {
    await render()
    // The routing is the thing a reporter is most likely to be wrong about, and
    // report_content goes to the homeserver administrator rather than to anyone
    // running the community.
    expect(document.body.textContent).toContain('not to community moderators')
  })

  it('sends the report through the bridge, then closes and confirms', async () => {
    bridgeMocks.reportMessage.mockResolvedValueOnce(undefined)
    await render()
    setTextareaValue('Harassing another member')

    await act(async () => { button('Send report')?.click() })

    expect(bridgeMocks.reportMessage).toHaveBeenCalledWith(
      '$event:mesh.test',
      '!room:mesh.test',
      'Harassing another member',
    )
    expect(onClose).toHaveBeenCalledOnce()
    expect(toastMocks.showToast).toHaveBeenCalledWith(
      'Report sent to your account service.',
      'success',
    )
  })

  it('keeps the dialog open and announces the failure when the report does not send', async () => {
    bridgeMocks.reportMessage.mockRejectedValueOnce(new Error('service unavailable'))
    await render()

    await act(async () => { button('Send report')?.click() })

    // The failure has to be visible and the dialog has to stay: a report that
    // silently vanished would look identical to one that was delivered.
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent?.length).toBeGreaterThan(0)
    expect(onClose).not.toHaveBeenCalled()
    expect(toastMocks.showToast).not.toHaveBeenCalled()
  })

  it('refuses an empty reason without reaching the bridge', async () => {
    await render()
    setTextareaValue('   ')

    expect(button('Send report')?.disabled).toBe(true)
    await act(async () => { button('Send report')?.click() })
    expect(bridgeMocks.reportMessage).not.toHaveBeenCalled()
  })

  it('will not close while a report is in flight', async () => {
    const pending = deferred<void>()
    bridgeMocks.reportMessage.mockReturnValueOnce(pending.promise)
    await render()

    await act(async () => { button('Send report')?.click() })
    expect(button('Cancel')?.disabled).toBe(true)
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
