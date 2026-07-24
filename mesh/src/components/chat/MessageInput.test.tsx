import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriEvents = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (
    eventName: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    tauriEvents.handlers.set(eventName, handler)
    return () => {
      if (tauriEvents.handlers.get(eventName) === handler) {
        tauriEvents.handlers.delete(eventName)
      }
    }
  }),
}))

import * as bridge from '../../lib/bridge'
import { MessageInput } from './MessageInput'
import type { StagedFile } from './FileAttachment'

function clipboardFile(name: string, type: string, bytes: number[]): File {
  return {
    name,
    type,
    size: bytes.length,
    arrayBuffer: vi.fn(async () => new Uint8Array(bytes).buffer),
  } as unknown as File
}

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => window.setTimeout(resolve, 0))
}

describe('MessageInput attachment UX', () => {
  let container: HTMLDivElement
  let root: Root
  let stageCounter: number

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    stageCounter = 0
    tauriEvents.handlers.clear()
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'setTyping').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'broadcastTyping').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'discardStagedAttachment').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'discardAttachmentGrant').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'acceptAttachmentDropGrants').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'stageAttachmentBytes').mockImplementation(async (_name, bytes) => {
      stageCounter += 1
      return {
        token: `token-${stageCounter}`,
        grant: `token-${stageCounter}`,
        name: _name,
        size: bytes.length,
        contentType: 'image/png',
      }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  async function render(onSend = vi.fn()) {
    await act(async () => {
      root.render(
        <MessageInput
          channelId="!room:mesh.test"
          channelName="general"
          onSend={onSend}
        />,
      )
    })
    return container.querySelector('textarea') as HTMLTextAreaElement
  }

  async function paste(textarea: HTMLTextAreaElement, files: File[]) {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files } })
    await act(async () => {
      textarea.dispatchEvent(event)
      await flushAsyncWork()
    })
  }

  it('shows a private pending preview and removes its native staging file accessibly', async () => {
    const textarea = await render()
    await paste(textarea, [clipboardFile('cat.gif', 'image/gif', [1, 2, 3])])

    expect(container.textContent).toContain('cat.gif')
    expect(container.textContent).toContain('3 B')
    expect(container.textContent).toContain('1 attachment pending')

    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove cat.gif"]')
    expect(remove).not.toBeNull()
    await act(async () => {
      remove?.click()
      await flushAsyncWork()
    })

    expect(container.textContent).not.toContain('cat.gif')
    expect(bridge.discardStagedAttachment).toHaveBeenCalledWith('token-1')
    expect(document.activeElement).toBe(textarea)
  })

  it('keeps only unsent attachments after a partial Matrix failure', async () => {
    let attempt = 0
    const onSend = vi.fn(async (
      _content: string,
      files: StagedFile[],
      onAttachmentSent?: (file: StagedFile, contentConsumed: boolean) => void | Promise<void>,
    ) => {
      attempt += 1
      if (attempt === 1) {
        await onAttachmentSent?.(files[0], true)
        throw new Error('homeserver upload interrupted')
      }
      await onAttachmentSent?.(files[0], false)
    })
    const textarea = await render(onSend)
    await paste(textarea, [
      clipboardFile('first.png', 'image/png', [1]),
      clipboardFile('second.png', 'image/png', [2]),
    ])

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set
      valueSetter?.call(textarea, 'caption')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsyncWork()
    })

    expect(onSend).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('second.png')
    expect(textarea.value).toBe('')
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('homeserver upload interrupted')
    expect(bridge.discardStagedAttachment).toHaveBeenCalledWith('token-1')
    expect(bridge.discardStagedAttachment).not.toHaveBeenCalledWith('token-2')

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsyncWork()
    })
    expect(onSend).toHaveBeenCalledTimes(2)
    expect(onSend.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ name: 'second.png', stagingToken: 'token-2' }),
    ])
    expect(bridge.discardStagedAttachment).toHaveBeenCalledWith('token-2')
  })

  it('removes the last pending attachment with Escape when the message is empty', async () => {
    const textarea = await render()
    await paste(textarea, [clipboardFile('screen.png', 'image/png', [1, 2])])

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushAsyncWork()
    })

    expect(container.textContent).not.toContain('screen.png')
    expect(bridge.discardStagedAttachment).toHaveBeenCalledWith('token-1')
  })

  it('discards a slow clipboard copy instead of moving it into the next room', async () => {
    let finishStaging: ((value: {
      token: string
      grant: string
      name: string
      size: number
      contentType: string
    }) => void) | undefined
    vi.mocked(bridge.stageAttachmentBytes).mockImplementationOnce(() => new Promise((resolve) => {
      finishStaging = resolve
    }))
    const textarea = await render()
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { files: [clipboardFile('room-a.png', 'image/png', [1])] },
    })
    await act(async () => textarea.dispatchEvent(pasteEvent))

    await act(async () => {
      root.render(
        <MessageInput
          channelId="!other:mesh.test"
          channelName="other"
          onSend={vi.fn()}
        />,
      )
      await flushAsyncWork()
    })
    await act(async () => {
      finishStaging?.({
        token: 'stale-token',
        grant: 'stale-token',
        name: 'room-a.png',
        size: 1,
        contentType: 'image/png',
      })
      await flushAsyncWork()
    })

    expect(container.textContent).not.toContain('room-a.png')
    expect(bridge.discardStagedAttachment).toHaveBeenCalledWith('stale-token')
  })

  it('caps a bulk paste before bytes are copied across IPC', async () => {
    const textarea = await render()
    const files = Array.from({ length: 12 }, (_, index) => (
      clipboardFile(`image-${index}.png`, 'image/png', [index])
    ))
    await paste(textarea, files)

    expect(bridge.stageAttachmentBytes).toHaveBeenCalledTimes(10)
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('up to 10 pending attachments')
  })

  it('revokes a native drop that finishes after switching rooms', async () => {
    await render()
    await act(async () => {
      await flushAsyncWork()
      tauriEvents.handlers.get('mesh-native-attachment-drop-start')?.({
        payload: {
          dropId: 'drop-room-a',
          position: { x: 0, y: 0 },
        },
      })
    })

    await act(async () => {
      root.render(
        <MessageInput
          channelId="!room-b:mesh.test"
          channelName="room-b"
          onSend={vi.fn()}
        />,
      )
      await flushAsyncWork()
    })

    await act(async () => {
      tauriEvents.handlers.get('mesh-native-attachment-drop')?.({
        payload: {
          dropId: 'drop-room-a',
          position: { x: 0, y: 0 },
          files: [{
            grant: 'grant-room-a',
            name: 'room-a-secret.png',
            size: 42,
            contentType: 'image/png',
          }],
          errors: [],
        },
      })
      await flushAsyncWork()
    })

    expect(container.textContent).not.toContain('room-a-secret.png')
    expect(bridge.acceptAttachmentDropGrants).not.toHaveBeenCalledWith(['grant-room-a'])
    expect(bridge.discardAttachmentGrant).toHaveBeenCalledWith('grant-room-a')
  })

  it('lets an in-flight send finish without deleting or mutating the next room draft', async () => {
    let finishSend: (() => Promise<void>) | undefined
    const onSend = vi.fn((
      _content: string,
      files: StagedFile[],
      onAttachmentSent?: (file: StagedFile, contentConsumed: boolean) => void | Promise<void>,
    ) => new Promise<void>((resolve) => {
      finishSend = async () => {
        await onAttachmentSent?.(files[0], true)
        resolve()
      }
    }))
    const textarea = await render(onSend)
    await paste(textarea, [clipboardFile('room-a.png', 'image/png', [1])])
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsyncWork()
    })

    await act(async () => {
      root.render(
        <MessageInput
          channelId="!other:mesh.test"
          channelName="other"
          onSend={vi.fn()}
        />,
      )
      await flushAsyncWork()
    })
    expect(bridge.discardStagedAttachment).not.toHaveBeenCalledWith('token-1')

    const otherTextarea = container.querySelector('textarea') as HTMLTextAreaElement
    await paste(otherTextarea, [clipboardFile('room-b.png', 'image/png', [2])])
    await act(async () => {
      await finishSend?.()
      await flushAsyncWork()
    })

    expect(bridge.discardStagedAttachment).toHaveBeenCalledWith('token-1')
    expect(container.textContent).toContain('room-b.png')
    expect(container.textContent).not.toContain('room-a.png')
  })
})
