import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const matrixVoiceDependencyRoot = fileURLToPath(
  new URL("./feature-deps/matrix-voice/node_modules/", import.meta.url),
);
const legacyVoiceDependencyRoot = fileURLToPath(
  new URL("./feature-deps/legacy-lan/node_modules/", import.meta.url),
);

function packageNameFromModuleId(moduleId: string): string | null {
  const normalized = moduleId.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return null;
  const parts = normalized.slice(index + marker.length).split('/');
  if (parts[0]?.startsWith('@') && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0] || null;
}

function reachabilityPlugin(mode: string) {
  return {
    name: 'mesh-artifact-reachability',
    generateBundle(_options: unknown, bundle: Record<string, { type: string; modules?: Record<string, unknown> }>) {
      const packages = new Set<string>();
      let moduleCount = 0;
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const moduleId of Object.keys(output.modules ?? {})) {
          moduleCount += 1;
          const packageName = packageNameFromModuleId(moduleId);
          if (packageName) packages.add(packageName);
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: 'mesh-reachability.json',
        source: `${JSON.stringify({ schemaVersion: 1, mode, moduleCount, packages: [...packages].sort() }, null, 2)}\n`,
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ command, mode }) => {
  return ({
  plugins: [
    react(command === "build" ? {
      babel: {
        // React Compiler must see the original component source before other
        // Babel transforms. Development keeps the same uncompiled semantics
        // as Vitest while avoiding compiler-expanded modules over the dev
        // server; production builds retain the reviewed optimization pass.
        plugins: ["babel-plugin-react-compiler"],
      },
    } : {}),
    reachabilityPlugin(mode),
  ],
  resolve: {
    // Force simple-peer/readable-stream onto the browser EventEmitter package
    // instead of Vite's empty shim for the Node built-in `events` module.
    alias: [
      {
        find: "@mesh/matrix-voice-runtime",
        replacement: fileURLToPath(new URL(
          mode === "matrix-voice"
            ? "./src/lib/livekit-voice.ts"
            : "./src/lib/livekit-voice.disabled.ts",
          import.meta.url,
        )),
      },
      {
        find: "@mesh/legacy-voice-runtime",
        replacement: fileURLToPath(new URL(
          mode === "legacy-p2p"
            ? "./src/lib/voice-engine.ts"
            : "./src/lib/voice-engine.disabled.ts",
          import.meta.url,
        )),
      },
      ...(mode === "matrix-voice" ? [
        {
          find: /^livekit-client$/,
          replacement: `${matrixVoiceDependencyRoot}livekit-client/dist/livekit-client.esm.mjs`,
        },
        {
          find: /^livekit-client\/e2ee-worker(?:\?url)?$/,
          replacement: `${matrixVoiceDependencyRoot}livekit-client/dist/livekit-client.e2ee.worker.mjs?url`,
        },
      ] : []),
      ...(mode === "legacy-p2p" ? [
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
  // simple-peer's browser dependency graph still references Node's `global`
  // identifier. Tauri's WebView only provides globalThis/window.
  define: {
    global: "globalThis",
    // Replaced at compile time so Rollup can make the production Matrix graph
    // incapable of resolving the legacy voice engine. The explicitly separate
    // LAN build opts in with `--mode legacy-p2p`.
    __MESH_LEGACY_FRONTEND__: JSON.stringify(mode === "legacy-p2p"),
    // The public Matrix text/community beta does not ship dormant media code.
    // Matrix voice has a separate opt-in build mode until physical acceptance
    // and release authorization are complete.
    __MESH_MATRIX_VOICE_FRONTEND__: JSON.stringify(
      mode === "matrix-voice" || mode === "test",
    ),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // Restrict dep scanning to index.html only — prevents esbuild from crawling
  // into src-tauri/target/doc/ (tens of thousands of generated HTML files)
  optimizeDeps: {
    entries: ["index.html"],
  },
  build: {
    rollupOptions: {
      output: {
        // Keep slow-changing framework code cacheable and keep the interactive
        // application shell below Vite's large-chunk threshold.
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\", "/");
          if (
            normalizedId.includes("/node_modules/react/")
            || normalizedId.includes("/node_modules/react-dom/")
            || normalizedId.includes("/node_modules/scheduler/")
          ) {
            return "framework";
          }
        },
      },
    },
  },
  });
});
