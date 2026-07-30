import { expect, test } from '@playwright/test'

const STARTUP_READY_BUDGET_MS = 8_000
const STARTUP_LONG_TASK_BUDGET_MS = 2_000
const STARTUP_TRANSFER_BUDGET_BYTES = 4 * 1024 * 1024
const STARTUP_HEAP_BUDGET_BYTES = 128 * 1024 * 1024
const STARTUP_DOM_NODE_BUDGET = 2_500

test('keeps the default onboarding path within wider-beta runtime budgets', async ({ page }) => {
  await page.addInitScript(() => {
    const longTasks: number[] = []
    Object.defineProperty(window, '__meshLongTasks', {
      configurable: false,
      value: longTasks,
    })
    if ('PerformanceObserver' in window) {
      const observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) longTasks.push(entry.duration)
      })
      try {
        observer.observe({ type: 'longtask', buffered: true })
      } catch {
        // Chromium versions without buffered long-task observation still run
        // the elapsed-time, transfer, heap, and DOM budgets below.
      }
    }
  })

  const startedAt = Date.now()
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Choose Matrix.org' })).toBeVisible({
    timeout: STARTUP_READY_BUDGET_MS,
  })
  const readyMs = Date.now() - startedAt

  const metrics = await page.evaluate(() => {
    const memory = performance as Performance & {
      memory?: { usedJSHeapSize?: number }
    }
    const longTasks = (window as Window & { __meshLongTasks?: number[] }).__meshLongTasks ?? []
    const transferBytes = performance
      .getEntriesByType('resource')
      .reduce((total, entry) => total + ((entry as PerformanceResourceTiming).transferSize || 0), 0)
    return {
      domNodes: document.getElementsByTagName('*').length,
      heapBytes: memory.memory?.usedJSHeapSize ?? null,
      longTaskMs: longTasks.reduce((total, duration) => total + duration, 0),
      transferBytes,
    }
  })

  console.log(JSON.stringify({ readyMs, ...metrics }))
  expect(readyMs).toBeLessThanOrEqual(STARTUP_READY_BUDGET_MS)
  expect(metrics.longTaskMs).toBeLessThanOrEqual(STARTUP_LONG_TASK_BUDGET_MS)
  expect(metrics.transferBytes).toBeLessThanOrEqual(STARTUP_TRANSFER_BUDGET_BYTES)
  expect(metrics.domNodes).toBeLessThanOrEqual(STARTUP_DOM_NODE_BUDGET)
  if (metrics.heapBytes !== null) {
    expect(metrics.heapBytes).toBeLessThanOrEqual(STARTUP_HEAP_BUDGET_BYTES)
  }
})
