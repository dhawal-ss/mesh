import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../types/ipc'

const sound = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../lib/interface-sounds', () => ({
  playInterfaceSound: sound,
}))

import { useFailedMessageAnnouncement } from './useFailedMessageAnnouncement'

function message(id: string, deliveryStatus: Message['deliveryStatus']): Message {
  return {
    id,
    channelId: 'room-1',
    authorPublicKey: '@taylor:example.org',
    authorDisplayName: 'Taylor',
    authorAvatarColor: '#d79733',
    content: 'Ready check',
    attachments: [],
    reactions: {},
    timestamp: '2026-08-02T00:00:00.000Z',
    signature: '',
    deliveryStatus,
  }
}

function Harness({ scopeId, messages }: { scopeId: string; messages: Message[] }) {
  const announcement = useFailedMessageAnnouncement(scopeId, messages)
  return <p data-generation={announcement.generation}>{announcement.text}</p>
}

describe('failed message announcement', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    sound.mockClear()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('announces a new failed batch once and allows a later retry failure', async () => {
    await act(async () => root.render(<Harness scopeId="room-1" messages={[]} />))
    const failed = message('txn-1', 'failed')
    await act(async () => root.render(<Harness scopeId="room-1" messages={[failed]} />))
    expect(container.textContent).toBe('Message could not send.')
    expect(sound).toHaveBeenCalledTimes(1)

    await act(async () => root.render(<Harness scopeId="room-1" messages={[{ ...failed }]} />))
    expect(sound).toHaveBeenCalledTimes(1)

    await act(async () => root.render(
      <Harness scopeId="room-1" messages={[{ ...failed, deliveryStatus: 'pending' }]} />,
    ))
    await act(async () => root.render(<Harness scopeId="room-1" messages={[failed]} />))
    expect(sound).toHaveBeenCalledTimes(2)
  })

  it('keeps already-failed history and a newly opened scope silent', async () => {
    const oldFailure = message('old-failure', 'failed')
    await act(async () => root.render(
      <Harness scopeId="room-1" messages={[oldFailure]} />,
    ))
    expect(container.textContent).toBe('')
    expect(sound).not.toHaveBeenCalled()

    await act(async () => root.render(
      <Harness scopeId="room-2" messages={[{ ...oldFailure, id: 'other-old-failure' }]} />,
    ))
    expect(container.textContent).toBe('')
    expect(sound).not.toHaveBeenCalled()
  })
})
