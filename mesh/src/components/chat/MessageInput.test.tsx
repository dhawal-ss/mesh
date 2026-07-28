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
import type { MemberRecord } from '../../store/membership'
import { useDraftStore } from '../../store/drafts'
import { useServerEmojiStore } from '../../store/custom-emoji'

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
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    useDraftStore.setState({ drafts: {} })
    useServerEmojiStore.setState({
      byCommunity: {},
      loading: {},
      load: vi.fn(async () => {}),
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    stageCounter = 0
    tauriEvents.handlers.clear()
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'setTyping').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'broadcastTyping').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'discardStagedAttachment').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'discardAttachmentGrant').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'acceptAttachmentDropGrants').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'loadComposerDraft').mockResolvedValue(null)
    vi.spyOn(bridge, 'saveComposerDraft').mockResolvedValue(undefined)
    vi.spyOn(bridge, 'clearComposerDraft').mockResolvedValue(undefined)
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
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function render(
    onSend = vi.fn(),
    mentionProps: Pick<React.ComponentProps<typeof MessageInput>, 'communityId' | 'members'> = {},
  ) {
    await act(async () => {
      root.render(
        <MessageInput
          channelId="!room:mesh.test"
          channelName="general"
          onSend={onSend}
          {...mentionProps}
        />,
      )
    })
    return container.querySelector('textarea') as HTMLTextAreaElement
  }

  async function setComposerValue(textarea: HTMLTextAreaElement, value: string) {
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set
      valueSetter?.call(textarea, value)
      textarea.setSelectionRange(value.length, value.length)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
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

  it('reuses the original transfer id on retry but mints a fresh one for a new attachment', async () => {
    let transferIdCounter = 0
    vi.spyOn(bridge, 'createMatrixTransferId').mockImplementation(() => `transfer-${++transferIdCounter}`)

    let attempt = 0
    const transferIdsByAttempt: Array<Array<string | undefined>> = []
    const onSend = vi.fn(async (
      _content: string,
      files: StagedFile[],
      onAttachmentSent?: (file: StagedFile, contentConsumed: boolean) => void | Promise<void>,
    ) => {
      attempt += 1
      transferIdsByAttempt.push(files.map((file) => file.transferId))
      if (attempt === 1) {
        // The upload finished server-side, but the client never received the
        // success response (dropped connection, app killed mid-flight, etc).
        throw new Error('response lost after upload completed')
      }
      for (const file of files) await onAttachmentSent?.(file, true)
    })

    const textarea = await render(onSend)
    await paste(textarea, [clipboardFile('proof.png', 'image/png', [1, 2, 3])])

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsyncWork()
    })
    expect(onSend).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('proof.png')

    // A second, unrelated attachment staged before the retry must still mint
    // its own id rather than inheriting the retried one.
    await paste(textarea, [clipboardFile('unrelated.png', 'image/png', [4, 5])])

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsyncWork()
    })
    expect(onSend).toHaveBeenCalledTimes(2)

    const [firstAttemptIds, retryIds] = transferIdsByAttempt
    expect(firstAttemptIds).toHaveLength(1)
    expect(firstAttemptIds[0]).toBeDefined()
    expect(retryIds).toHaveLength(2)
    expect(retryIds[0]).toBe(firstAttemptIds[0])
    expect(retryIds[1]).not.toBe(firstAttemptIds[0])
    // One id minted per distinct attachment (at staging time), not one per
    // handleSubmit call -- proves the retry reused rather than regenerated.
    expect(bridge.createMatrixTransferId).toHaveBeenCalledTimes(2)
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

  it('opens the last message for editing with ArrowUp in an empty composer', async () => {
    const onEditLastMessage = vi.fn()
    await act(async () => {
      root.render(
        <MessageInput
          channelId="!room:mesh.test"
          channelName="general"
          onSend={vi.fn()}
          onEditLastMessage={onEditLastMessage}
        />,
      )
    })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })

    expect(onEditLastMessage).toHaveBeenCalledOnce()
  })

  it('filters and inserts a selected community member mention from the keyboard', async () => {
    const members: MemberRecord[] = [
      {
        publicKey: '@alice:mesh.test',
        displayName: 'Alice',
        avatarColor: '#111111',
        role: 'member',
        joinStatus: 'joined',
        banStatus: 'none',
        lastSeen: null,
      },
      {
        publicKey: '@alicia:mesh.test',
        displayName: 'Alicia',
        avatarColor: '#222222',
        role: 'member',
        joinStatus: 'joined',
        banStatus: 'none',
        lastSeen: null,
      },
      {
        publicKey: '@bob:mesh.test',
        displayName: 'Bob',
        avatarColor: '#333333',
        role: 'member',
        joinStatus: 'joined',
        banStatus: 'none',
        lastSeen: null,
      },
    ]
    const textarea = await render(vi.fn(), { communityId: '!community:mesh.test', members })

    await setComposerValue(textarea, 'hello @ali')

    const suggestions = container.querySelector('[role="listbox"]')
    expect(suggestions?.textContent).toContain('Alice')
    expect(suggestions?.textContent).toContain('Alicia')
    expect(suggestions?.textContent).not.toContain('Bob')

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await flushAsyncWork()
    })
    await act(async () => {
      const secondSuggestion = container.querySelectorAll<HTMLElement>('[role="option"]')[1]
      secondSuggestion?.click()
      await flushAsyncWork()
    })

    expect(textarea.value).toBe('hello @alicia:mesh.test ')
    expect(container.querySelector('[role="listbox"]')).toBeNull()
  })

  it('does not open mention autocomplete outside a valid populated community context', async () => {
    const member: MemberRecord = {
      publicKey: '@alice:mesh.test',
      displayName: 'Alice',
      avatarColor: '#111111',
      role: 'member',
      joinStatus: 'joined',
      banStatus: 'none',
      lastSeen: null,
    }
    const textarea = await render(vi.fn(), { members: [member] })

    await setComposerValue(textarea, '@')
    expect(container.querySelector('[role="listbox"]')).toBeNull()

    await act(async () => {
      root.render(
        <MessageInput
          channelId="!room:mesh.test"
          channelName="general"
          onSend={vi.fn()}
          communityId="!community:mesh.test"
          members={[]}
        />,
      )
    })
    const emptyRosterInput = container.querySelector('textarea') as HTMLTextAreaElement
    await setComposerValue(emptyRosterInput, '@')
    expect(container.querySelector('[role="listbox"]')).toBeNull()

    await act(async () => {
      root.render(
        <MessageInput
          channelId="!room:mesh.test"
          channelName="general"
          onSend={vi.fn()}
          communityId="!community:mesh.test"
          members={[{ ...member, publicKey: 'not-a-user-id' }]}
        />,
      )
    })
    const invalidRosterInput = container.querySelector('textarea') as HTMLTextAreaElement
    await setComposerValue(invalidRosterInput, '@')
    expect(container.querySelector('[role="listbox"]')).toBeNull()

    await act(async () => {
      root.render(
        <MessageInput
          channelId="!room:mesh.test"
          channelName="general"
          onSend={vi.fn()}
          communityId="!community:mesh.test"
          members={[member]}
        />,
      )
    })
    const validRosterInput = container.querySelector('textarea') as HTMLTextAreaElement
    await setComposerValue(validRosterInput, 'email@alice')
    expect(container.querySelector('[role="listbox"]')).toBeNull()
  })

  it('discovers and inserts community emoji from the keyboard', async () => {
    useServerEmojiStore.setState({
      byCommunity: {
        '!community:mesh.test': [{
          shortcode: 'party_parrot',
          body: 'Party parrot',
          mxcUri: 'mxc://mesh.test/party',
          contentType: 'image/png',
          width: 32,
          height: 32,
          sizeBytes: 128,
          imageUrl: 'blob:party-parrot',
        }],
      },
    })
    const textarea = await render(vi.fn(), {
      communityId: '!community:mesh.test',
      members: [],
    })

    await setComposerValue(textarea, 'celebrate :party')
    expect(container.querySelector('[aria-label="Community emoji"]')?.textContent)
      .toContain(':party_parrot:')

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsyncWork()
    })

    expect(textarea.value).toBe('celebrate :party_parrot: ')
    expect(container.querySelector('[aria-label="Community emoji"]')).toBeNull()
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

  it('restores a session draft when returning to a channel and clears it after send', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    const textarea = await render(onSend)
    await setComposerValue(textarea, 'draft for general')

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
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('')

    await act(async () => {
      root.render(
        <MessageInput
          channelId="!room:mesh.test"
          channelName="general"
          onSend={onSend}
        />,
      )
      await flushAsyncWork()
    })
    const restored = container.querySelector('textarea') as HTMLTextAreaElement
    expect(restored.value).toBe('draft for general')

    await act(async () => {
      restored.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsyncWork()
    })
    expect(onSend).toHaveBeenCalledWith('draft for general')
    expect(useDraftStore.getState().drafts['!room:mesh.test']).toBeUndefined()
    expect(restored.value).toBe('')
    expect(bridge.clearComposerDraft).toHaveBeenCalledWith('!room:mesh.test')
  })

  it('restores an encrypted local draft after process memory is empty', async () => {
    vi.mocked(bridge.loadComposerDraft).mockResolvedValueOnce('restart-safe draft')

    const textarea = await render()
    await act(async () => {
      await flushAsyncWork()
    })

    expect(textarea.value).toBe('restart-safe draft')
    expect(useDraftStore.getState().drafts['!room:mesh.test']).toBe(
      'restart-safe draft',
    )
  })

  it('retains the durable draft when message delivery is not acknowledged', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('network unavailable'))
    const textarea = await render(onSend)
    await setComposerValue(textarea, 'do not lose this')

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsyncWork()
    })

    expect(textarea.value).toBe('do not lose this')
    expect(useDraftStore.getState().drafts['!room:mesh.test']).toBe(
      'do not lose this',
    )
    expect(bridge.clearComposerDraft).not.toHaveBeenCalled()
  })

  it('does not let a stale durable load overwrite newer typing', async () => {
    let finishLoad: ((value: string | null) => void) | undefined
    vi.mocked(bridge.loadComposerDraft).mockImplementationOnce(() => (
      new Promise((resolve) => {
        finishLoad = resolve
      })
    ))
    const textarea = await render()
    await setComposerValue(textarea, 'newer local draft')

    await act(async () => {
      finishLoad?.('stale saved draft')
      await flushAsyncWork()
    })

    expect(textarea.value).toBe('newer local draft')
    expect(useDraftStore.getState().drafts['!room:mesh.test']).toBe(
      'newer local draft',
    )
  })

  it('debounces durable saves and offers a retry without losing the draft', async () => {
    vi.useFakeTimers()
    vi.mocked(bridge.saveComposerDraft)
      .mockRejectedValueOnce(new Error('secure store unavailable'))
      .mockResolvedValueOnce(undefined)
    const textarea = await render()
    await setComposerValue(textarea, 'keep this private draft')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(bridge.saveComposerDraft).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(
      'Your draft is still here, but it is not saved for restart.',
    )

    const retryButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry')
    expect(retryButton).not.toBeNull()
    await act(async () => {
      retryButton?.click()
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(bridge.saveComposerDraft).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('not saved for restart')
    expect(textarea.value).toBe('keep this private draft')
  })

  it('keeps multibyte composer state inside the UTF-8 draft limit', async () => {
    const textarea = await render()
    await setComposerValue(textarea, '😀'.repeat(4097))

    expect(new TextEncoder().encode(textarea.value)).toHaveLength(16 * 1024)
    expect(textarea.value.endsWith('😀')).toBe(true)
    expect(useDraftStore.getState().drafts['!room:mesh.test']).toBe(textarea.value)
  })

  it('expands local slash commands before invoking the send callback', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    const textarea = await render(onSend)
    await setComposerValue(textarea, '/me waves')

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsyncWork()
    })

    expect(onSend).toHaveBeenCalledWith('*waves*')
  })

  it('makes local slash commands discoverable and keyboard-selectable', async () => {
    const textarea = await render()
    await setComposerValue(textarea, '/')

    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox).not.toBeNull()
    expect(listbox?.getAttribute('aria-label')).toBe('Slash commands')
    expect(listbox?.textContent).toContain('/shrug')
    expect(listbox?.textContent).toContain('Add a shrug to your message')
    expect(listbox?.textContent).toContain('/me')

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await flushAsyncWork()
    })
    expect(container.querySelectorAll('[role="option"]')[1]?.getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsyncWork()
    })
    expect(textarea.value).toBe('/me ')
    expect(container.querySelector('[role="listbox"]')).toBeNull()

    await setComposerValue(textarea, '/')
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushAsyncWork()
    })
    expect(container.querySelector('[role="listbox"]')).toBeNull()
  })

  it('formats the selected draft text from the keyboard-reachable toolbar', async () => {
    const textarea = await render()
    await setComposerValue(textarea, 'hello world')
    textarea.setSelectionRange(0, 5)

    const bold = container.querySelector<HTMLButtonElement>('button[aria-label="Bold"]')
    expect(bold).not.toBeNull()
    await act(async () => {
      bold?.click()
      await flushAsyncWork()
    })

    expect(textarea.value).toBe('**hello** world')
    expect(textarea.selectionStart).toBe(2)
    expect(textarea.selectionEnd).toBe(7)
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
