import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ui/Avatar', () => ({
  // imageUrl is reflected so a row that stops passing the author's picture is a
  // failing test rather than an avatar that quietly falls back to initials.
  Avatar: ({ name, imageUrl }: { name: string; imageUrl?: string | null }) => (
    <div data-avatar-image={imageUrl ?? ''}>{name}</div>
  ),
}))

// Props are captured rather than dropped: the row decides what the renderer
// is told about a message, and a mock that keeps only `content` makes every
// other prop untestable from here.
const markdownHarness = vi.hoisted(() => ({
  lastProps: {} as Record<string, unknown>,
  // A method, not a bare assignment: assigning the literal at a call site
  // narrows the property type there and the reads stop compiling.
  forget() {
    this.lastProps = {}
  },
}))

vi.mock('./MarkdownContent', () => ({
  MarkdownContent: (props: { content: string }) => {
    markdownHarness.lastProps = props as unknown as Record<string, unknown>
    return <p>{props.content}</p>
  },
}))

vi.mock('./ReactionPicker', () => ({
  ReactionPicker: () => null,
}))

const copyTextMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../lib/notifications', () => ({
  copyText: copyTextMock,
}))

vi.mock('../../lib/lazy-motion', () => ({
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

/** Carries a thumbnail, but is not a type the image loader will decrypt. */
function documentAttachment(): Message['attachments'][number] {
  return {
    ...previewAttachment(),
    filename: 'encrypted-plan.pdf',
    contentType: 'application/pdf',
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
  recheckProtection: () => {},
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

  /*
      Whether a message notified the room is decided when it was sent, by the
      sender's power level, and the row is the only thing that knows. Without
      this the render half of that feature rested on one unasserted prop: the
      component's own tests prove it honours the flag, and the composer's tests
      prove the flag reaches the service, but nothing proved the projected
      answer reached the component.
  */
  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])('tells the renderer that mentionsRoom=%s means room-wide=%s', async (mentionsRoom, expected) => {
    markdownHarness.forget()
    await act(async () => {
      root.render(
        <MessageComponent
          message={{ ...malformedMessage(), content: '@room ship it', mentionsRoom }}
          isGrouped={false}
        />,
      )
    })

    expect(markdownHarness.lastProps.roomWideMentionsAllowed).toBe(expected)
  })

  /*
      The author's picture reaches the row it belongs to. This is the surface
      people read most, and for a long time it was the one place a profile
      picture could never appear: MessageDto carried no address for it, so every
      message showed the generated mark whatever the person had set.
  */
  it('shows the author their picture on the message row', async () => {
    await act(async () => {
      root.render(
        <MessageComponent
          message={{ ...malformedMessage(), authorAvatarUrl: 'mxc://example.org/alice' }}
          isGrouped={false}
        />,
      )
    })

    expect(container.querySelector('[data-avatar-image]')?.getAttribute('data-avatar-image'))
      .toBe('mxc://example.org/alice')
  })

  it('falls back to the generated mark for an author with no picture', async () => {
    await act(async () => {
      root.render(<MessageComponent message={malformedMessage()} isGrouped={false} />)
    })

    expect(container.querySelector('[data-avatar-image]')?.getAttribute('data-avatar-image'))
      .toBe('')
  })

  it('offers a standard thread action before the first reply exists', async () => {
    const onToggleThread = vi.fn()
    await act(async () => {
      root.render(
        <MessageComponent
          message={malformedMessage()}
          isGrouped={false}
          onToggleThread={onToggleThread}
        />,
      )
    })

    const startThread = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Start a thread from message by Alice"]',
    )
    expect(startThread).not.toBeNull()
    await act(async () => startThread?.click())
    expect(onToggleThread).toHaveBeenCalledOnce()
  })

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

  it('offers one-tap quick reactions from recent or default emoji', async () => {
    window.localStorage.clear()
    const onReact = vi.fn(async () => {})

    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            timestamp: '2026-07-30T12:00:00.000Z',
            reactions: {},
          }}
          isGrouped={false}
          surface="dm"
          onReact={onReact}
        />,
      )
    })

    const quickButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Quick react with "]'),
    )
    // The accessible name is the emoji's name, not its glyph: "React with 👍"
    // leaves the screen reader to guess at the character.
    expect(quickButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Quick react with thumbs up',
      'Quick react with red heart',
      'Quick react with face with tears of joy',
    ])
    const quick = quickButtons[0]

    await act(async () => {
      quick.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 'message-1' }), '👍')
    expect(window.localStorage.getItem('mesh:emoji:recent')).toContain('👍')
  })

  it('keeps the quick-react row full after the first reaction is remembered', async () => {
    window.localStorage.clear()
    window.localStorage.setItem('mesh:emoji:recent', JSON.stringify(['🔥']))

    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            timestamp: '2026-07-30T12:00:00.000Z',
            reactions: {},
          }}
          isGrouped={false}
          surface="dm"
          onReact={vi.fn(async () => {})}
        />,
      )
    })

    // One recent emoji must not collapse the row to one button: the rest is
    // topped up from the curated defaults.
    expect(
      Array.from(container.querySelectorAll('button[aria-label^="Quick react with "]')).map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Quick react with fire', 'Quick react with thumbs up', 'Quick react with red heart'])
    window.localStorage.clear()
  })

  it('keeps the hover actions one tab stop and moves between them with arrows', async () => {
    window.localStorage.clear()

    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            timestamp: '2026-07-30T12:00:00.000Z',
            reactions: {},
          }}
          isGrouped={false}
          surface="dm"
          onReact={vi.fn(async () => {})}
          onReply={vi.fn()}
        />,
      )
    })

    const toolbar = container.querySelector<HTMLElement>('[role="toolbar"]')
    expect(toolbar).not.toBeNull()
    const buttons = Array.from(toolbar!.querySelectorAll<HTMLButtonElement>('button'))
    // Three quick reactions, the picker, and reply: five controls, one stop.
    expect(buttons).toHaveLength(5)
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1)
    // The stop rests on the picker, where Tab landed before quick reactions
    // existed, so the pre-existing keyboard route is unchanged.
    expect(buttons[3].getAttribute('aria-label')).toBe('React to message from Alice')
    expect(buttons[3].tabIndex).toBe(0)

    await act(async () => {
      buttons[3].focus()
      toolbar!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(document.activeElement).toBe(buttons[2])
    expect(buttons[2].tabIndex).toBe(0)
    expect(buttons[3].tabIndex).toBe(-1)
    expect(buttons[2].getAttribute('aria-label')).toBe('Quick react with face with tears of joy')

    await act(async () => {
      toolbar!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(document.activeElement).toBe(buttons[0])

    // Wraps, so the bar is never a dead end in either direction.
    await act(async () => {
      toolbar!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(document.activeElement).toBe(buttons[4])
    expect(buttons[4].getAttribute('aria-label')).toBe('Reply to Alice')
  })

  /*
    The visible copy is now one mono line rather than a titled card. The
    sentence that explains what to do about it moved into the rail's tooltip,
    which is where the origin server and key state already live.
  */
  it.each([
    ['sent-before-device', 'before this device could receive it'],
    ['keys-not-shared', 'This device cannot open it yet'],
    ['waiting-for-keys', 'Waiting for protected history'],
    ['could-not-decrypt', 'Not available on this device'],
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
    // The deletion is legible in the row's own content. The row deliberately
    // carries no role or label of its own: the timeline wraps every message in
    // role="article", and a labelled group inside it announced twice.
    expect(container.querySelector('[role="group"]')).toBeNull()
    expect(container.querySelector('.mesh-message-row')?.getAttribute('aria-label')).toBeNull()
  })

  it('exposes a stable author-name id for the timeline row to name itself from', async () => {
    await act(async () => {
      root.render(
        <MessageComponent
          message={{ ...malformedMessage(), timestamp: '2026-07-29T12:00:00.000Z' }}
          isGrouped={false}
        />,
      )
    })
    expect(container.querySelector('#mesh-message-author-message-1')?.textContent).toBe('Alice')

    // A grouped row has no visible header, so the id target is provided as a
    // label-only element rather than disappearing.
    await act(async () => {
      root.render(
        <MessageComponent
          message={{ ...malformedMessage(), timestamp: '2026-07-29T12:00:00.000Z' }}
          isGrouped
          authorNameId="thread-author-1"
        />,
      )
    })
    expect(container.querySelector('#thread-author-1')?.textContent).toBe('Alice')
  })

  it('marks an unacknowledged send without dimming the words being checked', async () => {
    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            timestamp: '2026-07-29T12:00:00.000Z',
            deliveryStatus: 'pending',
          }}
          isGrouped={false}
        />,
      )
    })

    const row = container.querySelector<HTMLElement>('.mesh-message-row')
    expect(row?.className).not.toContain('opacity-60')
    expect(row?.style.boxShadow).toContain('inset')
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
      button.textContent?.includes('Review security'),
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

      // The chip is visible but is not a live region: inside a virtualized
      // timeline every re-insertion would re-announce an already-known state.
      expect(container.querySelector('[data-delivery-chip="pending"]')?.textContent).toContain(
        'Saved for later',
      )
      expect(container.querySelector('[role="status"]')).toBeNull()
      expect(container.getAttribute('aria-label')).toBeNull()
      expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
      expect(container.querySelector('[aria-label^="React to message"]')).toBeNull()
    },
  )

  it.each([
    ['not-allowed' as const, 'You are not allowed to post in this room.'],
    ['room-unavailable' as const, 'This room no longer accepts messages.'],
  ])(
    'names a %s failure and withdraws the retry that could never succeed',
    async (failure, expected) => {
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
              sendFailure: failure,
            }}
            isGrouped
            onRetry={onRetry}
            onCancel={onCancel}
          />,
        )
      })

      const chip = container.querySelector<HTMLElement>('[data-delivery-chip="failed"]')
      expect(chip?.textContent).toContain(expected)
      expect(chip?.textContent).not.toContain('Could not send')
      // The queue already gave up. A retry button here only teaches the user
      // that the app is broken, so it is withdrawn, while the two actions that
      // still do something stay.
      const labels = [...chip!.querySelectorAll('button')].map((button) => button.textContent)
      expect(labels).not.toContain('Try again')
      expect(labels).toContain('Copy text')
      expect(labels).toContain('Remove')
    },
  )

  it('keeps the retry when the backend could not name a reason', async () => {
    await act(async () => {
      root.render(
        <MessageComponent
          message={{
            ...malformedMessage(),
            id: 'txn-1',
            transactionId: 'txn-1',
            deliveryStatus: 'failed',
            sendFailure: 'unknown',
          }}
          isGrouped
          onRetry={vi.fn()}
        />,
      )
    })

    // Not knowing why is not the same as knowing it is hopeless.
    const chip = container.querySelector<HTMLElement>('[data-delivery-chip="failed"]')
    expect(chip?.textContent).toContain('Could not send')
    expect(
      [...chip!.querySelectorAll('button')].map((button) => button.textContent),
    ).toContain('Try again')
  })

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

    // Deliberately not a live region of any kind: inside the virtualized
    // timeline any live role re-announces every time the row scrolls back into
    // view, interrupting the user repeatedly for an already-known failure. The
    // timeline announces a failed send once, from its own assertive region.
    const alert = container.querySelector<HTMLElement>('[data-delivery-chip="failed"]')
    expect(alert?.textContent).toContain('Could not send')
    expect(container.querySelector('[role="status"]')).toBeNull()
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

    const row = container.querySelector<HTMLElement>('.mesh-message-row')
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    const reportAction = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes('Report message'))
    expect(reportAction).toBeDefined()
    await act(async () => reportAction?.click())

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('go to your account service')
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
    const loadImage = vi.spyOn(bridge, 'matrixLoadAttachmentImage')

    await act(async () => {
      root.render(
        <FileAttachmentCard
          attachment={documentAttachment()}
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
        />,
      )
    })

    // The encrypted thumbnail is never fetched or decrypted: an inline preview
    // is a bounded rendering of the attachment itself, and only for the types
    // the Rust image loader will decrypt.
    expect(container.textContent).toContain('Preview stays protected')
    expect(container.querySelector('img')).toBeNull()
    expect(loadThumbnail).not.toHaveBeenCalled()
    expect(loadImage).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('shows a received image inline and hands the click to the existing viewer', async () => {
    const createObjectURL = vi.fn(() => 'blob:inline-preview')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.spyOn(bridge, 'isMatrixBackend').mockReturnValue(true)
    vi.spyOn(bridge, 'onMatrixTransferProgress').mockResolvedValue(() => {})
    vi.spyOn(bridge, 'matrixLoadAttachmentImage').mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      contentType: 'image/png',
    })
    const onOpenImage = vi.fn()

    await act(async () => {
      root.render(
        <FileAttachmentCard
          attachment={previewAttachment()}
          roomId="!private:example.org"
          eventId="$image:example.org"
          attachmentIndex={0}
          onOpenImage={onOpenImage}
        />,
      )
    })

    // The preview waits for a concurrency slot and then the bridge, so let the
    // microtask chain finish before reading the DOM.
    await act(async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    })

    const preview = container.querySelector('img')
    expect(preview?.getAttribute('alt')).toBe('Preview of private-image.png')
    expect(preview?.getAttribute('src')).toBe('blob:inline-preview')
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Open private-image.png at full size"]')
        ?.click()
    })
    expect(onOpenImage).toHaveBeenCalledOnce()

    // The download row survives alongside the preview.
    expect(
      container.querySelector('[aria-label="Download private-image.png"]'),
    ).not.toBeNull()
  })
})
