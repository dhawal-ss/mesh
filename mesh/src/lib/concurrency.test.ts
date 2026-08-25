import { describe, expect, it } from 'vitest'

import { mapSettledWithConcurrency } from './concurrency'

describe('mapSettledWithConcurrency', () => {
  it('bounds active work and preserves result order', async () => {
    let active = 0
    let peak = 0
    let started = 0
    const releases: Array<() => void> = []
    const run = mapSettledWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (value) => {
      active += 1
      started += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return value * 2
    })

    while (started < 2) await Promise.resolve()
    while (started < 6) {
      while (releases.length === 0) await Promise.resolve()
      releases.shift()?.()
      await Promise.resolve()
    }
    while (releases.length > 0) releases.shift()?.()

    await expect(run).resolves.toEqual([0, 2, 4, 6, 8, 10].map((value) => ({
      status: 'fulfilled',
      value,
    })))
    expect(peak).toBe(2)
  })

  it('settles failures without starving later items', async () => {
    await expect(mapSettledWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error('nope')
      return value
    })).resolves.toMatchObject([
      { status: 'fulfilled', value: 1 },
      { status: 'rejected' },
      { status: 'fulfilled', value: 3 },
    ])
  })

  it('does not dequeue more work after cancellation', async () => {
    let active = true
    const started: number[] = []
    const results = await mapSettledWithConcurrency([1, 2, 3, 4], 1, async (value) => {
      started.push(value)
      active = false
      return value
    }, () => active)

    expect(started).toEqual([1])
    expect(results).toMatchObject([
      { status: 'fulfilled', value: 1 },
      { status: 'rejected' },
      { status: 'rejected' },
      { status: 'rejected' },
    ])
  })
})
