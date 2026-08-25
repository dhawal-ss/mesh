import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VoiceEngineProvider,
  useVoiceEngineController,
} from './VoiceEngineProvider'

const lifecycle = vi.hoisted(() => ({
  started: vi.fn(),
  stopped: vi.fn(),
}))

vi.mock('../../hooks/useVoiceEngine', () => ({
  useVoiceEngine: () => {
    useEffect(() => {
      lifecycle.started()
      return lifecycle.stopped
    }, [])
    return { connectionWarning: null }
  },
}))

function RouteHarness() {
  const [showCall, setShowCall] = useState(true)
  const controller = useVoiceEngineController()
  return (
    <div>
      <button type="button" onClick={() => setShowCall((current) => !current)}>
        Change room
      </button>
      {showCall ? <span>Call room</span> : <span>Messages</span>}
      <span>{controller.connectionWarning ?? 'Call runtime active'}</span>
    </div>
  )
}

describe('VoiceEngineProvider', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    lifecycle.started.mockClear()
    lifecycle.stopped.mockClear()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('keeps one call runtime mounted while room content changes', async () => {
    await act(async () => root.render(
      <VoiceEngineProvider>
        <RouteHarness />
      </VoiceEngineProvider>,
    ))
    expect(lifecycle.started).toHaveBeenCalledOnce()
    expect(lifecycle.stopped).not.toHaveBeenCalled()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
    })

    expect(container.textContent).toContain('Messages')
    expect(container.textContent).toContain('Call runtime active')
    expect(lifecycle.started).toHaveBeenCalledOnce()
    expect(lifecycle.stopped).not.toHaveBeenCalled()
  })

  it('publishes one stable context value while the shell re-renders', async () => {
    // The engine hook returns a fresh object literal every render, and this
    // provider re-renders with the whole authenticated shell. Republishing
    // that literal invalidated every call consumer for no reason.
    const published: unknown[] = []
    function ContextIdentityProbe() {
      const controller = useVoiceEngineController()
      useEffect(() => {
        published.push(controller)
      }, [controller])
      return <span>probe</span>
    }

    await act(async () => root.render(
      <VoiceEngineProvider>
        <ContextIdentityProbe />
      </VoiceEngineProvider>,
    ))
    expect(published).toHaveLength(1)

    await act(async () => root.render(
      <VoiceEngineProvider>
        <ContextIdentityProbe />
      </VoiceEngineProvider>,
    ))

    expect(container.textContent).toContain('probe')
    expect(published).toHaveLength(1)
  })
})
