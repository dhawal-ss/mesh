import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STARTUP_READY_BUDGET_MS = 2_000
const STARTUP_PAINT_BUDGET_MS = STARTUP_READY_BUDGET_MS
const STARTUP_LONG_TASK_BUDGET_MS = 2_000
const STARTUP_TRANSFER_BUDGET_BYTES = 4 * 1024 * 1024
const STARTUP_HEAP_BUDGET_BYTES = 128 * 1024 * 1024
const STARTUP_DOM_NODE_BUDGET = 2_500
const SETTLING_INTERVAL_MS = 1_000
const SAMPLE_RUNS = 3

type RuntimeSample = {
  run: number
  paintedMs: number
  interactiveMs: number
  domNodes: number
  heapBytes: number | null
  longTaskMs: number
  transferBytes: number
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  const worstObserved = sorted.at(-1) ?? 0
  return {
    minimum: sorted[0] ?? 0,
    median,
    p95: sorted[p95Index] ?? worstObserved,
    maximum: worstObserved,
    worstObserved,
    mean,
    standardDeviation: Math.sqrt(variance),
    sampleCount: values.length,
  }
}

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

  const samples: RuntimeSample[] = []
  for (let run = 1; run <= SAMPLE_RUNS; run += 1) {
    await page.goto('about:blank')
    const startedAt = Date.now()
    await page.goto('/')
    const signIn = page.getByRole('button', { name: 'Sign in with Public account service' })
    await expect(signIn).toBeVisible({ timeout: STARTUP_READY_BUDGET_MS })
    const paintedMs = Date.now() - startedAt
    await expect(signIn).toBeEnabled({ timeout: STARTUP_READY_BUDGET_MS })
    await signIn.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }),
    )
    const interactiveMs = Date.now() - startedAt
    await page.waitForTimeout(SETTLING_INTERVAL_MS)

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
    samples.push({ run, paintedMs, interactiveMs, ...metrics })
  }

  const numericHeap = samples.flatMap((sample) =>
    sample.heapBytes === null ? [] : [sample.heapBytes],
  )
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim()
  const outputDir = path.resolve(process.cwd(), 'test-results')
  const outputPath = path.join(outputDir, 'resource-budget-browser.json')
  const evidence = {
    schemaVersion: 1,
    sourceSha,
    testedAt: new Date().toISOString(),
    buildType: process.env.CI ? 'vite-development-ci' : 'vite-development-local',
    rawEvidencePath: path.relative(process.cwd(), outputPath).replaceAll('\\', '/'),
    sampleRuns: SAMPLE_RUNS,
    settlingIntervalMs: SETTLING_INTERVAL_MS,
    platform: {
      os: `${os.type()} ${os.release()}`,
      architecture: os.arch(),
      hardware: os.cpus()[0]?.model ?? 'unknown',
      logicalProcessorCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
    },
    summary: {
      paintedMs: summarize(samples.map((sample) => sample.paintedMs)),
      interactiveMs: summarize(samples.map((sample) => sample.interactiveMs)),
      domNodes: summarize(samples.map((sample) => sample.domNodes)),
      heapBytes: numericHeap.length ? summarize(numericHeap) : null,
      longTaskMs: summarize(samples.map((sample) => sample.longTaskMs)),
      transferBytes: summarize(samples.map((sample) => sample.transferBytes)),
    },
    samples,
  }
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(
    outputPath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8',
  )
  console.log(JSON.stringify(evidence))

  for (const sample of samples) {
    expect(sample.paintedMs).toBeLessThanOrEqual(STARTUP_PAINT_BUDGET_MS)
    expect(sample.interactiveMs).toBeLessThanOrEqual(STARTUP_READY_BUDGET_MS)
    expect(sample.longTaskMs).toBeLessThanOrEqual(STARTUP_LONG_TASK_BUDGET_MS)
    expect(sample.transferBytes).toBeLessThanOrEqual(STARTUP_TRANSFER_BUDGET_BYTES)
    expect(sample.domNodes).toBeLessThanOrEqual(STARTUP_DOM_NODE_BUDGET)
    if (sample.heapBytes !== null) {
      expect(sample.heapBytes).toBeLessThanOrEqual(STARTUP_HEAP_BUDGET_BYTES)
    }
  }
})
