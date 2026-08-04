import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ui/Avatar', () => ({
  Avatar: ({ name }: { name: string }) => <div>{name}</div>,
}))

vi.mock('./MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <p>{content}</p>,
}))

vi.mock('./ReactionPicker', () => ({
  ReactionPicker: () => null,
}))

const copyTextMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../lib/notifications', () => ({
  copyText: copyTextMock,
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    span: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span {...props}>{children}</span>
    ),
  },
}))

import type { Message } from '../../types/ipc'
import type { RoomTrustSnapshot } from '../../hooks/useRoomTrust'
import * as bridge from '../../lib/bridge'
import { useRoomPinStore } from '../../store/room-pins'
import { useShellStore } from '../../store/shell'
import { useMessageStore } from '../../store/messages'
import { FileAttachmentCard, MessageComponent } from './Message'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function malformedMessage(): Message {
  return {
    id: 'message-1',
    channelId: 'channel-1',
    authorPublicKey: '@alice:example.org',
    authorDisplayName: 'Alice',
    authorAvatarColor: '#52b5f4',
    content: 'Federated message',
    attachments: [],
    reactions: {},
    timestamp: 'not-a-timestamp',
    signature: '',
  }
}

function previewAttachment(): Message['attachments'][number] {
  return {
    fileHash: 'matrix-sha256:file',
    filename: 'private-image.png',
    size: 1024,
    chunks: 1,
    sourcePeerId: 'matrix',
    contentType: 'image/png',
    thumbnail: {
      fileHash: 'matrix-sha256:thumbnail',
      size: 8,
      width: 320,
      height: 180,
      contentType: 'image/png',
    },
  }
}

function undecryptableMessage(reason: NonNullable<Message['undecryptable']>['reason']): Message {
  return {
    ...malformedMessage(),
    id: '$encrypted-1:example.org',
    authorPublicKey: '@bob:example.org',
    authorDisplayName: 'Bob',
    content: '',
    timestamp: '2026-07-29T12:00:00.000Z',
    undecryptable: {
      eventId: '$encrypted-1:example.org',
      sender: '@bob:example.org',
      originServerTs: 1_725_000_000_000,
      reason,
    },
  }
}

const securityAttentionTrust: RoomTrustSnapshot = {
  matrixMode: true,
  protection: 'protected',
  communityMemberCount: 1,
  services: [],
  devices: [],
  devicesNeedReview: 1,
  verifiedDevices: 0,
  backup: {
    recoveryState: 'disabled',
    backupState: 'unknown',
    backupExistsOnServer: false,
    backupEnabled: false,
    healthy: false,
    checkedAt: '2026-07-29T00:00:00Z',
    lastSuccessfulTestAt: null,
    secureStorageState: 'missing',
    warnings: ['Recovery is not set up'],
  },
  accountId: '@alice:example.org',
  homeService: 'example.org',
  syncRunning: true,
  loadingAccountTrust: false,
}

describe('MessageComponent federated timestamps', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    useRoomPinStore.setState({
      roomId: null,
      eventIds: [],
      messages: [],
      unavailableEventIds: [],
      canManage: false,
      loading: false,
      loadFailed: false,
    })
    useMessageStore.setState({ matrixQueueStates: {} })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([false, true])(
    'renders honest fallback copy for malformed %s-group timestamps',
    async (isGrouped) => {
      await expect(
        act(async () => {
          root.render(<MessageComponent message={malformedMessage()} isGrouped={isGrouped} />)
        }),
      ).resolves.toBeUndefined()

      expect(container.textContent).toContain('Time unavailable')
      expect(container.textContent).not.toContain('Invalid Date')
    },
  )

  it('keeps DM edit typing local to the edited shared row', async () => {
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@alice:example.org')
    let firstRowUpdates = 0
    let secondRowUpdates = 0

    await act(async () => {
      root.render(
        <>
          <Profiler
            id="first"
            onRender={(_id, phase) => {
              if (phase === 'update') firstRowUpdates += 1
            }}
          >
            <MessageComponent
              message={{
                ...malformedMessage(),
                timestamp: '2026-07-30T12:00:00.000Z',
              }}
              isGrouped={false}
              surface="dm"
              onEdit={vi.fn()}
            />
          </Profiler>
          <Profiler
            id="second"
            onRender={(_id, phase) => {
              if (phase === 'update') secondRowUpdates += 1
            }}
          >
            <MessageComponent
              message={{
                ...malformedMessage(),
                id: 'message-2',
                content: 'Second message',
                timestamp: '2026-07-30T12:01:00.000Z',
              }}
              isGrouped={false}
              surface="dm"
              onEdit={vi.fn()}
            />
          </Profiler>
        </>,
      )
    })

    const editButtons = container.querySelectorAll<HTMLButtonElement>('[aria-label="Edit message"]')
    await act(async () => editButtons[0]?.click())
    firstRowUpdates = 0
    secondRowUpdates = 0

    const editor = container.querySelector<HTMLTextAreaElement>('textarea')
    await act(async () => {
      if (!editor) return
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set
      valueSetter?.call(editor, 'Federated message updated')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(firstRowUpdates).toBeGreaterThan(0)
    expect(secondRowUpdates).toBe(0)
  })

  it('preserves failed edit text and retries without double submission', async () => {
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@alice:example.org')
    const onEdit = vi.fn()
      .mockRejectedValueOnce(new Error('service unavailable'))
      .mockResolvedValueOnce(undefined)

    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            timestamp: '2026-07-30T12:00:00.000Z',
          }}
          isGrouped={false}
          surface="dm"
          onEdit={onEdit}
        />,
      )
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Edit message"]')?.click()
    })
    const editor = container.querySelector<HTMLTextAreaElement>('textarea')
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set
      valueSetter?.call(editor, 'Keep this edited text')
      editor?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'save')
        ?.click()
      await Promise.resolve()
    })

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value)
      .toBe('Keep this edited text')
    expect(container.textContent).toContain('Save edit failed')

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Retry')
        ?.click()
      await Promise.resolve()
    })

    expect(onEdit).toHaveBeenCalledTimes(2)
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('deduplicates rapid edit submissions while the current attempt is pending', async () => {
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@alice:example.org')
    const pendingEdit = deferred<void>()
    const onEdit = vi.fn(() => pendingEdit.promise)

    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            timestamp: '2026-07-30T12:00:00.000Z',
          }}
          isGrouped={false}
          surface="dm"
          onEdit={onEdit}
        />,
      )
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Edit message"]')?.click()
    })
    const editor = container.querySelector<HTMLTextAreaElement>('textarea')
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set
      valueSetter?.call(editor, 'One durable edit')
      editor?.dispatchEvent(new Event('input', { bubbles: true }))
      editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true)

    await act(async () => {
      pendingEdit.resolve()
      await pendingEdit.promise
    })
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('deduplicates rapid reaction mutations while the current attempt is pending', async () => {
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@alice:example.org')
    const pendingReaction = deferred<void>()
    const onReact = vi.fn(() => pendingReaction.promise)

    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            timestamp: '2026-07-30T12:00:00.000Z',
            reactions: { 'ðŸ‘': ['@bob:example.org'] },
          }}
          isGrouped={false}
          surface="dm"
          onReact={onReact}
        />,
      )
    })
    const reaction = container.querySelector<HTMLButtonElement>('[aria-label*="reaction"]')
    await act(async () => {
      reaction?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      reaction?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(onReact).toHaveBeenCalledTimes(1)

    await act(async () => {
      pendingReaction.resolve()
      await pendingReaction.promise
    })
  })

  it.each([
    ['sent-before-device', 'before this device could receive it'],
    ['keys-not-shared', 'message keys were not shared'],
    ['waiting-for-keys', 'Waiting for the message keys'],
    ['could-not-decrypt', "couldn't decrypt this message"],
  ] as const)('renders a visible placeholder for %s events', async (reason, copy) => {
    await act(async () => {
      root.render(<MessageComponent message={undecryptableMessage(reason)} isGrouped={false} />)
    })

    expect(container.querySelector('[data-undecryptable-message="true"]')).not.toBeNull()
    expect(container.textContent).toContain(copy)
    expect(container.querySelector('p')?.textContent).not.toBe('')
    expect(container.querySelector('[aria-label^="React to message"]')).toBeNull()
    expect(container.textContent).not.toContain('Time unavailable')
  })

  it('renders a redaction as a tombstone instead of an empty row', async () => {
    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            timestamp: '2026-07-29T12:00:00.000Z',
            content: '',
            deletedAt: '2026-07-29T12:05:00.000Z',
            reactions: { '👍': ['@bob:example.org'] },
          }}
          isGrouped={false}
        />,
      )
    })

    // A redaction clears the body; without a tombstone the row read as a
    // rendering bug, and its reactions outlived the message they belonged to.
    expect(container.textContent).toContain('Message deleted')
    expect(container.querySelector('[aria-label*="reaction"]')).toBeNull()
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toContain(
      'message deleted',
    )
  })

  it('exposes reaction state without relying on colour', async () => {
    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            timestamp: '2026-07-29T12:00:00.000Z',
            reactions: { '👍': ['@bob:example.org', '@carol:example.org'] },
          }}
          isGrouped={false}
        />,
      )
    })

    const reaction = container.querySelector('[aria-label*="reaction"]')
    expect(reaction).not.toBeNull()
    expect(reaction?.getAttribute('aria-label')).toContain('2 reactions')
    // aria-pressed carries "did I react" independently of the accent tint.
    expect(reaction?.getAttribute('aria-pressed')).toBe('false')
  })

  it('emits a machine-readable timestamp', async () => {
    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            timestamp: '2026-07-29T12:00:00.000Z',
          }}
          isGrouped={false}
        />,
      )
    })

    const time = container.querySelector('time')
    expect(time).not.toBeNull()
    expect(time?.getAttribute('datetime')).toBe('2026-07-29T12:00:00.000Z')
  })

  it('links an actionable decryption gap to Security & Devices', async () => {
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    useShellStore.setState({ securityOpen: false })

    await act(async () => {
      root.render(
        <MessageComponent
          message={undecryptableMessage('waiting-for-keys')}
          isGrouped={false}
          trust={securityAttentionTrust}
        />,
      )
    })

    const review = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Review message security'),
    )
    expect(review).toBeDefined()
    await act(async () => review?.click())
    expect(useShellStore.getState().securityOpen).toBe(true)
  })

  it.each([false, true])(
    'shows protected saved state for %s-group queued messages',
    async (isGrouped) => {
      await act(async () => {
        useMessageStore.setState({
          matrixQueueStates: {
            'channel-1': {
              'txn-1': { state: 'pending' },
            },
          },
        })
        root.render(
          <MessageComponent
            message={{
              ...malformedMessage(),
              id: 'txn-1',
              transactionId: 'txn-1',
              deliveryStatus: 'pending',
            }}
            isGrouped={isGrouped}
          />,
        )
      })

      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        'Saved for later',
      )
      expect(container.getAttribute('aria-label')).toBeNull()
      expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
      expect(container.querySelector('[aria-label^="React to message"]')).toBeNull()
    },
  )

  it('offers accessible retry, copy, and remove without exposing event-only actions', async () => {
    const onRetry = vi.fn()
    const onCancel = vi.fn()
    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            id: 'txn-1',
            transactionId: 'txn-1',
            deliveryStatus: 'failed',
          }}
          isGrouped
          onRetry={onRetry}
          onCancel={onCancel}
        />,
      )
    })

    // Intentionally role="status", not role="alert": inside the virtualized
    // timeline an assertive region re-announces every time the row scrolls back
    // into view, interrupting the user repeatedly for an already-known failure.
    const alert = [...container.querySelectorAll('[role="status"]')].find((node) =>
      node.textContent?.includes('Could not send'),
    )
    expect(alert?.textContent).toContain('Could not send')
    const retry = [...alert!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Try again')
    const copy = [...alert!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Copy text')
    const remove = [...alert!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Remove')
    await act(async () => {
      retry?.click()
      copy?.click()
      remove?.click()
      await Promise.resolve()
    })
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(copyTextMock).toHaveBeenCalledWith('Federated message')
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
  })

  it('pins a message through native room state when the member has permission', async () => {
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@me:example.org')

    const message = {
      ...malformedMessage(),
      id: '$message-1:example.org',
      timestamp: '2026-07-28T09:41:00.000Z',
    }
    const togglePin = vi.spyOn(bridge, 'matrixToggleRoomPin').mockResolvedValue({
      roomId: message.channelId,
      eventIds: [message.id],
      messages: [message],
      unavailableEventIds: [],
      canManage: true,
    })
    useRoomPinStore.setState({
      roomId: message.channelId,
      eventIds: [],
      messages: [],
      unavailableEventIds: [],
      canManage: true,
      loading: false,
      loadFailed: false,
    })
    await act(async () => {
      root.render(<MessageComponent message={message} isGrouped={false} />)
    })

    const pin = container.querySelector<HTMLButtonElement>('[aria-label="Pin message"]')
    expect(pin).not.toBeNull()
    await act(async () => {
      pin?.click()
      await Promise.resolve()
    })

    expect(togglePin).toHaveBeenCalledWith(message.channelId, message.id)
    expect(container.querySelector('[aria-label="Unpin message"]')).not.toBeNull()
  })

  it('rolls back a failed pin and offers an in-row retry', async () => {
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@me:example.org')
    const message = {
      ...malformedMessage(),
      id: '$message-pin-retry:example.org',
      timestamp: '2026-07-28T09:42:00.000Z',
    }
    const togglePin = vi.spyOn(bridge, 'matrixToggleRoomPin')
      .mockRejectedValueOnce(new Error('pin update offline'))
      .mockResolvedValueOnce({
        roomId: message.channelId,
        eventIds: [message.id],
        messages: [message],
        unavailableEventIds: [],
        canManage: true,
      })
    useRoomPinStore.setState({
      roomId: message.channelId,
      eventIds: [],
      messages: [],
      unavailableEventIds: [],
      canManage: true,
      loading: false,
      loadFailed: false,
    })
    await act(async () => {
      root.render(<MessageComponent message={message} isGrouped={false} />)
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Pin message"]')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[aria-label="Unpin message"]')).toBeNull()
    expect(container.textContent).toContain('Pin message failed')

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Retry')
        ?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(togglePin).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[aria-label="Unpin message"]')).not.toBeNull()
  })

  it('reports Matrix messages to the selected account service from limited-action views', async () => {
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'getMatrixUserId').mockReturnValue('@me:matrix.org')
    const report = vi.spyOn(bridge, 'reportMessage').mockResolvedValue()
    const message = {
      ...malformedMessage(),
      id: '$message-1:example.org',
      timestamp: '2026-07-28T09:41:00.000Z',
    }
    await act(async () => {
      root.render(<MessageComponent message={message} isGrouped={false} limitedActions />)
    })

    const row = container.querySelector<HTMLElement>('[role="group"]')
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    const reportAction = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes('Report message'))
    expect(reportAction).toBeDefined()
    await act(async () => reportAction?.click())

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('not end-to-end encrypted')
    expect(
      dialog?.querySelector<HTMLAnchorElement>('a[href="https://matrix.org/contact/"]'),
    ).not.toBeNull()
    expect(dialog?.textContent).toContain('Mesh does not operate this service')
    const send = [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Send report'),
    )
    await act(async () => {
      send?.click()
      await Promise.resolve()
    })

    expect(report).toHaveBeenCalledWith(
      '$message-1:example.org',
      'channel-1',
      'Spam or abusive content',
    )
  })

  it('keeps encrypted thumbnail plaintext out of the renderer', async () => {
    const createObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'onMatrixTransferProgress').mockResolvedValue(() => {})
    const loadThumbnail = vi.spyOn(bridge, 'matrixLoadAttachmentThumbnail')

    await act(async () => {
      root.render(
        <FileAttachmentCard
          attachment={previewAttachment()}
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
        />,
      )
    })

    expect(container.textContent).toContain('Encrypted preview stays protected')
    expect(container.querySelector('img')).toBeNull()
    expect(loadThumbnail).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
