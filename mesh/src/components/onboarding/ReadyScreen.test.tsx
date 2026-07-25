import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadyScreen } from './ReadyScreen'

describe('ReadyScreen', () => {
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

  it('never claims account recovery or security without real recovery state', async () => {
    await act(async () => {
      root.render(
        <ReadyScreen
          backendKind="matrix"
          onComplete={() => {}}
          onBootstrap={async (update) => {
            update({ phase: 'ready', label: 'Ready', progress: 100 })
          }}
        />,
      )
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Signed in')
    expect(container.textContent).toContain('Conversations ready')
    expect(container.textContent).not.toContain('Account secured')
    expect(container.textContent?.toLowerCase()).not.toContain('recovery')
    expect(container.textContent).not.toContain('encrypted history restored')
  })

  it('preserves the separate legacy peer setup checklist', async () => {
    await act(async () => {
      root.render(
        <ReadyScreen
          backendKind="legacy-p2p"
          onComplete={() => {}}
          onBootstrap={vi.fn(async (update) => {
            update({ phase: 'ready', label: 'Ready', progress: 100 })
          })}
        />,
      )
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Identity secured')
    expect(container.textContent).toContain('Peers discovered')
    expect(container.textContent).toContain('Channels synced')
  })
})
