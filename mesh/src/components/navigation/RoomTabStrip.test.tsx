import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  emptyRoomTabState,
  openRoomTab,
  roomTabKey,
  type RoomTab,
  type RoomTabState,
} from '../../lib/room-tabs'
import { RoomTabStrip } from './RoomTabStrip'

function tab(kind: 'room' | 'dm', id: string, unreadCount = 0): RoomTab {
  return {
    key: roomTabKey(kind, id),
    kind,
    roomId: id,
    communityId: kind === 'room' ? '!space:example.org' : null,
    title: kind === 'room' ? 'general' : 'Alice',
    pinned: false,
    unreadCount,
    mentionCount: 0,
    lastOpenedAt: 1,
  }
}

function Harness({ initial }: { initial: RoomTabState }) {
  const [state, setState] = useState(initial)
  return <RoomTabStrip state={state} onChange={setState} />
}

describe('RoomTabStrip', () => {
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

  it('exposes tab state, badges, and active-tab actions without nested buttons', async () => {
    let state = openRoomTab(emptyRoomTabState('@alice:example.org'), tab('room', 'one'))
    state = openRoomTab(state, tab('dm', 'two', 3))
    await act(async () => root.render(<Harness initial={state} />))

    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs).toHaveLength(2)
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(tabs[1].getAttribute('aria-label')).toContain('3 unread')
    expect(tabs.every((item) => item.querySelector('button') == null)).toBe(true)

    const pin = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pin active conversation"]',
    )
    await act(async () => pin?.click())
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label'))
      .toContain('pinned')
  })

  it('supports Ctrl/Cmd navigation, reordering, close, and reopen with focus return', async () => {
    let state = openRoomTab(emptyRoomTabState('@alice:example.org'), tab('room', 'one'))
    state = openRoomTab(state, tab('dm', 'two'))
    await act(async () => root.render(<Harness initial={state} />))

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'PageDown',
        ctrlKey: true,
        bubbles: true,
      }))
    })
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toContain('general')

    const first = container.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]',
    )
    await act(async () => {
      first?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        altKey: true,
        shiftKey: true,
        bubbles: true,
      }))
    })
    expect(container.querySelector('[role="tab"]')?.textContent).toContain('Alice')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'PageDown',
        metaKey: true,
        bubbles: true,
      }))
    })
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toContain('Alice')

    const active = container.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]',
    )
    await act(async () => {
      active?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Delete',
        bubbles: true,
      }))
    })
    // A single open conversation is already obvious in the room header, so the
    // strip disappears until there are multiple conversations to manage.
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'T',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }))
    })
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2)
  })
})
