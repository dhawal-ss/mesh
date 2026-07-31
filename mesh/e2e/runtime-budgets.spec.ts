import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STARTUP_READY_BUDGET_MS = 8_000
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
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length
  return {
    minimum: Math.min(...values),
    maximum: Math.max(...values),
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
    const signIn = page.getByRole('button', { name: 'Sign in with Matrix.org' })
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
  const evidence = {
    schemaVersion: 1,
    sourceSha,
    testedAt: new Date().toISOString(),
    buildType: process.env.CI ? 'vite-development-ci' : 'vite-development-local',
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
  const outputDir = path.resolve(process.cwd(), 'test-results')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(
    path.join(outputDir, 'resource-budget-browser.json'),
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
