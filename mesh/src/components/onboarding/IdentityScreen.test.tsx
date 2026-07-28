import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdentityScreen } from './IdentityScreen'
import { useIdentityStore } from '../../store/identity'

describe('IdentityScreen', () => {
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
    useIdentityStore.setState({ identity: null, isLoading: true })
  })

  it('describes the local device key in plain language while it is being created', async () => {
    await act(async () => {
      root.render(<IdentityScreen backendKind="matrix" onNext={() => {}} />)
    })

    expect(container.textContent).toContain('stays here and never leaves')
    assertNoBannedJargon(container.textContent)
  })

  it('describes the local device key in plain language once it is created', async () => {
    useIdentityStore.setState({
      identity: { publicKey: 'device-abc123def456', displayName: '', avatarColor: '' },
      isLoading: false,
    })

    await act(async () => {
      root.render(<IdentityScreen backendKind="matrix" onNext={() => {}} />)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('does not affect your account or your messages')
    assertNoBannedJargon(container.textContent)
  })
})

function assertNoBannedJargon(text: string | null) {
  const copy = text?.toLowerCase() ?? ''
  for (const banned of ['matrix', 'device keys', 'authoritative', 'migration']) {
    expect(copy).not.toContain(banned)
  }
}
