import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MESSAGE_COUNT = 10_000
const MAX_HISTORY_PAGES = 205
const MAX_RENDERED_ROWS = 100
const MAX_DOM_NODES = 2_500
/*
  This fixture only exists on the dev server: vite.config.ts aliases
  `installWorkspacePreview` and `WorkspacePreviewState` to their `.disabled`
  variants for every production build, correctly, because dev tooling must not
  ship. So these timings are measured against dev-mode React, and a CPU profile
  of this run is dominated by exactly that: jsxDEV, validateProperty,
  logComponentRender, recordLegacyContextWarning, and StrictMode rendering
  every component twice. None of it exists in the build users install.

  An absolute millisecond ceiling here would therefore be asserting a
  production frame budget against a measurement that cannot represent one, and
  it would move with React's dev instrumentation rather than with Mesh. The
  structural bounds below are the enforced gate: they are the same in both
  builds, and they are what proves virtualization holds at ten thousand
  messages.

  What is still worth asserting about time is scale-free: paginating history
  must not get slower the deeper you go. That catches the regression that
  actually matters, an accidental O(n) or O(n^2) in the merge, sort, or
  normalize path, on any machine, in any build.
*/
const MAX_LATE_PAGE_SLOWDOWN_RATIO = 2
const MAX_HEAP_GROWTH_BYTES = 64 * 1024 * 1024
const MAX_FINAL_HEAP_BYTES = 256 * 1024 * 1024

function percentile(values: number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)] ?? 0
}

test('keeps a ten-thousand-message timeline bounded while scrolling', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  await page.addInitScript(() => {
    const longTasks: number[] = []
    Object.defineProperty(window, '__meshLargeTimelineLongTasks', {
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
        // The DOM, frame-interval, and heap bounds remain authoritative when
        // this Chromium build does not expose buffered long-task entries.
      }
    }
  })

  await page.goto('/?dev=workspace&simulateLargeTimeline=true')
  await page.getByRole('button', { name: 'Direct messages', exact: true }).click()
  await page.getByRole('button', { name: /Direct message with Maya Chen/ }).click()

  const messageLog = page.getByRole('feed', { name: 'Messages with Maya Chen', exact: true })
  await expect(messageLog).toBeVisible()
  await expect(messageLog.getByText('Performance timeline message 10000 of 10000', { exact: true }))
    .toBeVisible({ timeout: 15_000 })

  /*
    Both heap samples are taken after forcing collection, which is what the
    project's --expose-gc flag is for. Sampling usedJSHeapSize at an arbitrary
    moment measures whatever garbage happens to be uncollected right then: the
    same unchanged code produced 32 MB, 58 MB and 78 MB of "growth" on three
    consecutive runs against a 64 MB ceiling, so the bound was deciding by coin
    flip. Collecting first measures what is actually retained, which is the only
    thing a leak bound can mean.
  */
  const readHeap = () => page.evaluate(async () => {
    const collect = (globalThis as { gc?: () => void }).gc
    if (collect) {
      // One pass frees the unreachable; the second collects what the first
      // pass made unreachable in turn.
      collect()
      await new Promise((resolve) => setTimeout(resolve, 50))
      collect()
    }
    const memory = performance as Performance & { memory?: { usedJSHeapSize?: number } }
    return {
      collected: typeof collect === 'function',
      heapBytes: memory.memory?.usedJSHeapSize ?? null,
      domNodes: document.getElementsByTagName('*').length,
    }
  })

  const initial = await readHeap()

  /*
    Fail loudly rather than measuring nothing. Without --js-flags=--expose-gc
    the collection above is skipped, and the heap bounds below silently revert
    to sampling uncollected garbage: the coin-flip measurement the comment above
    describes. A release gate that quietly stops measuring is worse than one
    that fails, so assert the flag reached the browser.
  */
  expect(
    initial.collected,
    'launch this spec through playwright.large-timeline.config.ts: the heap bounds require --js-flags=--expose-gc',
  ).toBe(true)

  const frameIntervals: number[] = []
  let peakRows = 0
  let peakDomNodes = initial.domNodes
  let historyPagesTraversed = 0
  const visibleMessageNumbers = async () => {
    const labels = await messageLog.getByText(/^Performance timeline message \d+ of 10000$/)
      .allTextContents()
    return labels
      .map((label) => Number(label.match(/message (\d+) of/)?.[1] ?? Number.NaN))
      .filter(Number.isFinite)
  }
  for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
    const beforeNumbers = await visibleMessageNumbers()
    const beforeMinimum = Math.min(...beforeNumbers)
    if (beforeMinimum === 1) break
    const interval = await messageLog.evaluate(async (element) => {
      const scroller = element as HTMLElement
      scroller.scrollTop = Math.min(2, scroller.scrollHeight - scroller.clientHeight)
      scroller.scrollTop = 0
      const startedAt = performance.now()
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve())
      }))
      return performance.now() - startedAt
    })
    frameIntervals.push(interval)
    await expect.poll(async () => {
      const afterNumbers = await visibleMessageNumbers()
      return Math.min(...afterNumbers)
    }, {
      timeout: 5_000,
      intervals: [10, 25, 50, 100],
      message: `History page ${pageIndex + 1} did not advance before message ${beforeMinimum}`,
    }).toBeLessThan(beforeMinimum)
    historyPagesTraversed += 1
    const snapshot = await page.evaluate(() => ({
      // Timeline rows are `role="article"` inside the feed: both aria-posinset
      // and aria-setsize are only honoured in that pairing. They used to be a
      // labelled `role="group"`, which announced every message twice.
      rows: document.querySelectorAll('[role="feed"] [role="article"]').length,
      domNodes: document.getElementsByTagName('*').length,
    }))
    peakRows = Math.max(peakRows, snapshot.rows)
    peakDomNodes = Math.max(peakDomNodes, snapshot.domNodes)
  }

  await expect(messageLog.getByText('Performance timeline message 1 of 10000', { exact: true }))
    .toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: /Jump to latest messages/ }).click()
  await expect(messageLog.getByText('Performance timeline message 10000 of 10000', { exact: true }))
    .toBeVisible({ timeout: 15_000 })

  const collected = await readHeap()
  const longTasks = await page.evaluate(() => (
    (window as Window & { __meshLargeTimelineLongTasks?: number[] })
      .__meshLargeTimelineLongTasks ?? []
  ))
  const final = { ...collected, longTasks }

  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim()
  const outputDir = path.resolve(process.cwd(), 'test-results')
  const outputPath = path.join(outputDir, 'large-timeline-performance.json')
  const heapGrowthBytes = initial.heapBytes === null || final.heapBytes === null
    ? null
    : final.heapBytes - initial.heapBytes
  const evidence = {
    schemaVersion: 1,
    sourceSha,
    dirtyWorktree: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim().length > 0,
    testedAt: new Date().toISOString(),
    // Named honestly: this is the dev server, because the fixture is aliased
    // out of production builds. Do not compare these timings to a production
    // frame budget.
    buildType: 'vite-dev-server-performance-fixture',
    rawEvidencePath: path.relative(process.cwd(), outputPath).replaceAll('\\', '/'),
    messageCount: MESSAGE_COUNT,
    historyPagesTraversed,
    platform: {
      os: `${os.type()} ${os.release()}`,
      architecture: os.arch(),
      hardware: os.cpus()[0]?.model ?? 'unknown',
      logicalProcessorCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
    },
    summary: {
      peakRenderedRows: peakRows,
      peakDomNodes,
      initialHeapBytes: initial.heapBytes,
      finalHeapBytes: final.heapBytes,
      heapGrowthBytes,
      frameIntervalMedianMs: percentile(frameIntervals, 0.5),
      frameIntervalP95Ms: percentile(frameIntervals, 0.95),
      frameIntervalMaximumMs: Math.max(...frameIntervals),
      frameIntervalEarlyMedianMs: percentile(
        frameIntervals.slice(0, Math.max(1, Math.floor(frameIntervals.length / 4))),
        0.5,
      ),
      frameIntervalLateMedianMs: percentile(
        frameIntervals.slice(-Math.max(1, Math.floor(frameIntervals.length / 4))),
        0.5,
      ),
      longTaskCount: final.longTasks.length,
      longTaskTotalMs: final.longTasks.reduce((total, duration) => total + duration, 0),
    },
  }
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  await testInfo.attach('large-timeline-performance', {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: 'application/json',
  })
  console.log(JSON.stringify(evidence))

  expect(peakRows).toBeGreaterThan(0)
  expect(historyPagesTraversed).toBeGreaterThanOrEqual(199)
  expect(peakRows).toBeLessThan(MAX_RENDERED_ROWS)
  expect(peakDomNodes).toBeLessThanOrEqual(MAX_DOM_NODES)
  // Scale-free: the last quarter of history pages must not cost meaningfully
  // more than the first quarter. Growth here means per-page work scales with
  // how much history is already loaded, which is the bug worth catching.
  const quarter = Math.max(1, Math.floor(frameIntervals.length / 4))
  const earlyMedian = percentile(frameIntervals.slice(0, quarter), 0.5)
  const lateMedian = percentile(frameIntervals.slice(-quarter), 0.5)
  expect(lateMedian).toBeLessThanOrEqual(earlyMedian * MAX_LATE_PAGE_SLOWDOWN_RATIO)
  if (heapGrowthBytes !== null) expect(heapGrowthBytes).toBeLessThanOrEqual(MAX_HEAP_GROWTH_BYTES)
  if (final.heapBytes !== null) expect(final.heapBytes).toBeLessThanOrEqual(MAX_FINAL_HEAP_BYTES)
})
