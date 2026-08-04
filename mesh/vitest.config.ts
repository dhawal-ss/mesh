import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const matrixVoiceDependencyRoot = fileURLToPath(
  new URL('./feature-deps/matrix-voice/node_modules/', import.meta.url),
)
const legacyVoiceDependencyRoot = fileURLToPath(
  new URL('./feature-deps/legacy-lan/node_modules/', import.meta.url),
)
const featureGraph = process.env.MESH_FEATURE_GRAPH

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@mesh/matrix-voice-runtime',
        replacement: fileURLToPath(new URL(
          featureGraph === 'matrix-voice'
            ? './src/lib/livekit-voice.ts'
            : './src/lib/livekit-voice.disabled.ts',
          import.meta.url,
        )),
      },
      {
        find: '@mesh/legacy-voice-runtime',
        replacement: fileURLToPath(new URL(
          featureGraph === 'legacy-p2p'
            ? './src/lib/voice-engine.ts'
            : './src/lib/voice-engine.disabled.ts',
          import.meta.url,
        )),
      },
      ...(featureGraph === 'matrix-voice' ? [
        {
          find: /^livekit-client$/,
          replacement: `${matrixVoiceDependencyRoot}livekit-client/dist/livekit-client.esm.mjs`,
        },
        {
          find: /^livekit-client\/e2ee-worker(?:\?url)?$/,
          replacement: `${matrixVoiceDependencyRoot}livekit-client/dist/livekit-client.e2ee.worker.mjs?url`,
        },
      ] : []),
      ...(featureGraph === 'legacy-p2p' ? [
        {
          find: /^simple-peer$/,
          replacement: `${legacyVoiceDependencyRoot}simple-peer/index.js`,
        },
        {
          find: /^events$/,
          replacement: `${legacyVoiceDependencyRoot}events/events.js`,
        },
      ] : []),
    ],
  },
  define: {
    global: 'globalThis',
    // The default unit suite exercises both facades with mocked native IPC.
    // Isolated feature suites select exactly one real dependency graph.
    __MESH_LEGACY_FRONTEND__: JSON.stringify(
      featureGraph ? featureGraph === 'legacy-p2p' : true,
    ),
    __MESH_MATRIX_VOICE_FRONTEND__: JSON.stringify(
      featureGraph ? featureGraph === 'matrix-voice' : true,
    ),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
})
