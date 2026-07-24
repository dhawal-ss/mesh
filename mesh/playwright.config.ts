import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for Mesh end-to-end tests.
 *
 * Playwright is a development dependency. Install the Chromium runtime once
 * with:
 *
 *   npm run e2e:install
 *
 * Then run the suite with:
 *
 *   npm run e2e
 *
 * The tests cover four production boundaries:
 *
 *   1. Browser-level WebRTC tests (e2e/voice-session.spec.ts)
 *      These use Chromium's fake media devices to exercise the Mesh
 *      frontend's voice engine against real RTCPeerConnection APIs.
 *
 *   2. Full-window Tauri IPC tests (e2e/diagnostics.spec.ts)
 *      These drive the Vite dev server with a Tauri bridge mock so the
 *      full React tree renders and IPC commands are recorded. Deeper
 *      integration (actually launching the Tauri process) requires
 *      tauri-driver (see docs/E2E_TESTING.md).
 *
 *   3. Authenticated responsive shell tests (e2e/authenticated-shell.spec.ts)
 *      These validate Matrix identity, navigation, messaging, settings,
 *      keyboard behavior, and narrow-window layout against strict IPC mocks.
 *
 *   4. Matrix DM/file tests (e2e/matrix-messaging.spec.ts)
 *      These validate encrypted DM history, text/attachment sends, download
 *      decryption handoff, and OS-open behavior against strict IPC mocks.
 *
 * Both suites are documented in docs/E2E_TESTING.md.
 */
export default defineConfig({
  testDir: './e2e',
  // Fail fast in CI, retry locally
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    // Vite dev server default
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Enable fake media devices for WebRTC tests — required for
        // tests that exercise getUserMedia without granting real mic
        // access. This produces a silent audio track that still
        // propagates through the RTCPeerConnection stack.
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    port: 1420,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
