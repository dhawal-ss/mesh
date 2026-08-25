import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_RUNTIME_ERROR_RECORDS,
  MAX_RUNTIME_ERROR_REPORT_BYTES,
} from '../../lib/runtime-error-reporting'
import { GovernedCommitmentsPanel } from './GovernedCommitmentsPanel'

describe('GovernedCommitmentsPanel', () => {
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

  it('quotes the real bounds rather than a number that can drift', async () => {
    await render()

    // The spec this panel implements asked for "twenty allow-listed error kind
    // names". The allow-list holds eighteen; twenty is the record cap. Reading
    // both bounds from the module makes the stated figure wrong only if the
    // behaviour itself changes.
    expect(container.textContent).toContain(`at most ${MAX_RUNTIME_ERROR_RECORDS} recent entries`)
    expect(container.textContent)
      .toContain(`${Math.round(MAX_RUNTIME_ERROR_REPORT_BYTES / 1024)} KB`)
  })

  it('states that error reporting is off until it is turned on', async () => {
    await render()
    expect(container.textContent).toContain('off until you turn it on')
  })

  it('discloses that Mesh excludes its own window from screen capture', async () => {
    await render()
    expect(container.textContent).toContain('screen capture and screen sharing')
    expect(container.textContent).toContain('cannot screenshot Mesh')
  })

  it('discloses the crash note, the one thing recorded without asking', async () => {
    await render()

    // The Rust panic hook writes this marker whatever the reporting toggle
    // says, so a flat "nothing is recorded unless you opt in" would be untrue.
    expect(container.textContent).toContain('stops unexpectedly')
    expect(container.textContent).toContain('stays on this device')
  })

  it('claims no upload happens on its own', async () => {
    await render()
    expect(container.textContent).toContain('Nothing is uploaded on its own')
  })

  async function render() {
    await act(async () => {
      root.render(<GovernedCommitmentsPanel />)
    })
  }
})
