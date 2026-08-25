import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['large-timeline-performance.spec.ts'],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:1423',
    trace: 'off',
    launchOptions: {
      // --expose-gc is not optional here. large-timeline-performance.spec.ts
      // forces a collection before each heap sample; without the flag the
      // collection is silently skipped and the gated heap-growth assertion
      // measures uncollected garbage instead of retained memory.
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
    },
  },
  webServer: {
    command: 'vite preview --outDir dist-performance-fixture --host 127.0.0.1 --port 1423',
    port: 1423,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
