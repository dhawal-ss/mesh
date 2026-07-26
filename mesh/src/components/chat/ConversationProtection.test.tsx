import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as bridge from '../../lib/bridge'
import { ConversationProtection } from './ConversationProtection'

describe('ConversationProtection', () => {
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

  it('shows a protected state only after checking the active room', async () => {
    const check = vi.spyOn(bridge, 'matrixRoomIsEncrypted').mockResolvedValue(true)

    await act(async () => {
      root.render(<ConversationProtection roomId="!protected:example.org" />)
      await Promise.resolve()
    })

    expect(check).toHaveBeenCalledWith('!protected:example.org')
    expect(container.textContent).toContain('Protected end to end')
    expect(container.querySelector('[aria-label="This conversation is protected end to end"]')).not.toBeNull()
  })

  it('warns when sending is blocked in an unprotected room', async () => {
    vi.spyOn(bridge, 'matrixRoomIsEncrypted').mockResolvedValue(false)

    await act(async () => {
      root.render(<ConversationProtection roomId="!plain:example.org" />)
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Sending blocked: not protected',
    )
  })

  it('offers a working retry when the protection check fails', async () => {
    const check = vi.spyOn(bridge, 'matrixRoomIsEncrypted')
      .mockRejectedValueOnce(new Error('sync unavailable'))
      .mockResolvedValueOnce(true)

    await act(async () => {
      root.render(<ConversationProtection roomId="!retry:example.org" />)
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Protection check unavailable')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
      await Promise.resolve()
    })

    expect(check).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Protected end to end')
  })
})
