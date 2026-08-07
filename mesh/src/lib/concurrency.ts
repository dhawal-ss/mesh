export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldContinue: () => boolean = () => true,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return []
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length))
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let nextIndex = 0

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length && shouldContinue()) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }))

  while (nextIndex < items.length) {
    results[nextIndex] = {
      status: 'rejected',
      reason: new Error('Bounded work was cancelled before it started.'),
    }
    nextIndex += 1
  }

  return results
}
