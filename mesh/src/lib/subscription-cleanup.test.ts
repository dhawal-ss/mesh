import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeSubscription } from './subscription-cleanup'

describe('disposeSubscription', () => {
  afterEach(() => vi.restoreAllMocks())

  it('runs a resolved cleanup', async () => {
    const cleanup = vi.fn()
    disposeSubscription(Promise.resolve(cleanup), 'test listener')
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('contains rejected registration and cleanup promises', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    disposeSubscription(Promise.reject(new Error('registration failed')), 'first listener')
    disposeSubscription(
      Promise.resolve(() => Promise.reject(new Error('cleanup failed'))),
      'second listener',
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(warning).toHaveBeenCalledWith(
      'Failed to stop first listener:',
      expect.any(Error),
    )
    expect(warning).toHaveBeenCalledWith(
      'Failed to stop second listener:',
      expect.any(Error),
    )
  })
})
