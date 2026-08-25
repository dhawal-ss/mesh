import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdentityScreen } from './IdentityScreen'
import { useIdentityStore } from '../../store/identity'

describe('IdentityScreen', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useIdentityStore.setState({ identity: null, isLoading: true })
    vi.useRealTimers()
  })

  it('describes the local device key in plain language while it is being created', async () => {
    await act(async () => {
      root.render(<IdentityScreen backendKind="matrix" onNext={() => {}} />)
    })

    expect(container.textContent).toContain('Preparing your account')
    assertNoBannedJargon(container.textContent)
  })

  it('describes the local device key in plain language once it is created', async () => {
    useIdentityStore.setState({
      identity: { publicKey: 'device-abc123def456', displayName: '', avatarColor: '' },
      isLoading: false,
    })

    await act(async () => {
      root.render(<IdentityScreen backendKind="matrix" onNext={() => {}} />)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(container.textContent).toContain('Account protection is ready')
    assertNoBannedJargon(container.textContent)
  })
})

function assertNoBannedJargon(text: string | null) {
  const copy = text?.toLowerCase() ?? ''
  for (const banned of ['matrix', 'device keys', 'authoritative', 'migration']) {
    expect(copy).not.toContain(banned)
  }
}
