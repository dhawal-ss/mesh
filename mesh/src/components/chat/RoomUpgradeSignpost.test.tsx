import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomUpgradeSignpost } from './ChatView'

describe('RoomUpgradeSignpost', () => {
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

  it('keeps the replacement choice explicit and invokes it only after a click', () => {
    const onFollow = vi.fn()

    act(() => {
      root.render(
        <RoomUpgradeSignpost
          roomName="general"
          reason="The service upgraded this room."
          error={null}
          isFollowing={false}
          onFollow={onFollow}
        />,
      )
    })

    expect(container.textContent).toContain('This room has moved')
    expect(container.textContent).toContain('Mesh will keep this room here')
    expect(onFollow).not.toHaveBeenCalled()

    act(() => container.querySelector<HTMLButtonElement>('button')?.click())
    expect(onFollow).toHaveBeenCalledOnce()
  })

  it('shows a retryable error and disables the action while opening', () => {
    act(() => {
      root.render(
        <RoomUpgradeSignpost
          roomName="general"
          reason={null}
          error="The new room could not be opened yet. Try again in a moment."
          isFollowing
          onFollow={vi.fn()}
        />,
      )
    })

    const button = container.querySelector<HTMLButtonElement>('button')
    expect(button?.disabled).toBe(true)
    expect(button?.textContent).toContain('Opening new room')
    expect(container.textContent).toContain('Try again in a moment')
  })
})
