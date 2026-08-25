import { defineConfig, devices } from '@playwright/test'

process.env.MESH_RUNTIME_BUILD_TYPE = 'vite-production-preview-local'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['runtime-budgets.spec.ts'],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:1421',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 1421',
    port: 1421,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
