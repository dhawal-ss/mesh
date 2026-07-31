import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react({
      babel: {
        // React Compiler must see the original component source before other
        // Babel transforms. React 19 needs no compatibility target override.
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
  ],
  resolve: {
    // Force simple-peer/readable-stream onto the browser EventEmitter package
    // instead of Vite's empty shim for the Node built-in `events` module.
    alias: [
      {
        find: /^events$/,
        replacement: fileURLToPath(
          new URL("./node_modules/events/events.js", import.meta.url),
        ),
      },
    ],
  },
  // simple-peer's browser dependency graph still references Node's `global`
  // identifier. Tauri's WebView only provides globalThis/window.
  define: {
    global: "globalThis",
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
          if (normalizedId.includes("/node_modules/framer-motion/")) {
            return "motion";
          }
        },
      },
    },
  },
}));
