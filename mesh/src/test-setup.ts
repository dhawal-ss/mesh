import { vi } from 'vitest'

// Mock Tauri core APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

// Mock the bridge module so store tests don't depend on Tauri IPC
vi.mock('./lib/bridge', () => ({
  getMessages: vi.fn(() => Promise.resolve([])),
  sendMessage: vi.fn(() => Promise.resolve()),
  addReaction: vi.fn(() => Promise.resolve()),
}))
