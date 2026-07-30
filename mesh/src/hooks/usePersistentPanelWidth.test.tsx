import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PanelResizeHandle } from '../components/layout/PanelResizeHandle'
import {
  clampPanelWidth,
  readStoredBoolean,
  readStoredPanelWidth,
} from '../lib/layout-preferences'
import { usePersistentPanelWidth } from './usePersistentPanelWidth'

describe('persistent panel layout', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    window.localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.localStorage.clear()
  })

  it('clamps stored widths and defaults the optional room context closed', () => {
    window.localStorage.setItem('panel', '999')
    expect(clampPanelWidth(179.6, 180, 360)).toBe(180)
    expect(readStoredPanelWidth('panel', 220, 180, 360)).toBe(360)
    expect(readStoredBoolean('missing-context-choice', false)).toBe(false)
  })

  it('resizes from keyboard and pointer input and persists the result', async () => {
    window.localStorage.setItem('panel', '250')

    function Harness() {
      const panel = usePersistentPanelWidth({
        storageKey: 'panel',
        defaultWidth: 220,
        minimum: 180,
        maximum: 360,
      })
      return (
        <>
          <output>{panel.width}</output>
          <PanelResizeHandle
            label="Resize test panel"
            side="right"
            value={panel.width}
            minimum={180}
            maximum={360}
            onPointerDown={panel.startResize}
            onResizeBy={panel.resizeBy}
          />
        </>
      )
    }

    await act(async () => root.render(<Harness />))
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!
    await act(async () => {
      separator.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(container.querySelector('output')?.textContent).toBe('258')
    expect(window.localStorage.getItem('panel')).toBe('258')

    await act(async () => {
      separator.dispatchEvent(new MouseEvent('pointerdown', {
        button: 0,
        clientX: 100,
        bubbles: true,
        cancelable: true,
      }))
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 150 }))
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 150 }))
    })
    expect(container.querySelector('output')?.textContent).toBe('308')
    expect(window.localStorage.getItem('panel')).toBe('308')
  })
})
