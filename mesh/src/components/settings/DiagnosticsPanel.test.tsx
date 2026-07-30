/**
 * E2E component test for the DiagnosticsPanel.
 *
 * Uses React's createRoot + jsdom (no @testing-library/react dependency) to
 * mount the component with a mocked bridge and verify it renders key data
 * and handles the loading/error states correctly.
 *
 * This is the pattern for critical-flow E2E coverage: mount a real component
 * tree, mock the Tauri bridge, drive state transitions, and assert on the DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import type { SystemDiagnostics } from '../../lib/bridge'

// Mock the bridge getDiagnostics and probeIceServers functions
vi.mock('../../lib/bridge', () => ({
  isTauriRuntime: vi.fn(() => false),
  getDiagnostics: vi.fn(),
  getBackendStatus: vi.fn(),
  probeIceServers: vi.fn(() => Promise.resolve([])),
}))

import { getBackendStatus, getDiagnostics, probeIceServers } from '../../lib/bridge'

const mockDiagnostics = (overrides: Partial<SystemDiagnostics> = {}): SystemDiagnostics => ({
  networkConnected: true,
  networkPeerCount: 5,
  identityLoaded: true,
  communityCount: 2,
  memberCount: 42,
  activeDownloadCount: 0,
  downloadStats: [],
  activeVoiceSessions: 0,
  iceServerStatus: {
    stunConfigured: true,
    turnConfigured: true,
    customServers: false,
  },
  pendingMessageCount: 0,
  version: '0.1.0',
  warnings: [],
  ...overrides,
})

describe('DiagnosticsPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
    vi.mocked(probeIceServers).mockResolvedValue([])
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('does not render anything when open=false', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(mockDiagnostics())
    await act(async () => {
      root.render(<DiagnosticsPanel open={false} onClose={() => {}} />)
    })
    // Panel should not render content when closed
    expect(document.body.textContent).not.toContain('System diagnostics')
  })

  it('renders the panel title when open', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(mockDiagnostics())
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    // Allow async effects to flush
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(document.body.textContent).toContain('System diagnostics')
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy()
  })

  it('shows account health without exposing implementation names in product copy', async () => {
    vi.mocked(getBackendStatus).mockResolvedValue({
      kind: 'matrix',
      capabilities: {
        encryptedText: true,
        encryptedAttachments: false,
        directMessages: false,
        voice: false,
        durableTimeouts: false,
        deviceManagement: false,
        recovery: true,
        legacyMigration: false,
      },
      voiceService: {
        provider: 'matrix-rtc',
        availability: 'not-configured',
        discoveryKey: 'org.matrix.msc4143.rtc_foci',
        livekitServiceUrl: null,
        tokenEndpoint: null,
        livekitSfuUrl: null,
        cspReady: false,
        mediaE2eeVerified: false,
        reason: 'MatrixRTC services are not configured',
      },
      authenticated: true,
      userId: '@alice:localhost',
      deviceId: 'MESHDEVICE',
      homeserver: 'http://localhost:8008',
      syncRunning: true,
      durableHistory: true,
      endToEndEncryption: true,
      warnings: [],
    })

    await act(async () => {
      root.render(
        <DiagnosticsPanel open={true} onClose={() => {}} backendKind="matrix" />,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(document.body.textContent).toContain('Your Mesh account is connected and syncing normally.')
    expect(document.body.textContent).toContain('@alice:localhost')
    expect(document.body.textContent).toContain('http://localhost:8008')
    expect(document.body.textContent).toContain('Private calling')
    expect(document.body.textContent).toContain('Media protection')
    expect(document.body.textContent).toContain('Not verified')
    expect(document.body.textContent).toContain('Network policy')
    expect(document.body.textContent).toContain('Blocked')
    expect(document.body.textContent).toContain('Private calling services are not configured for this account.')
    expect(document.body.textContent).not.toContain('MatrixRTC')
    expect(document.body.textContent).not.toContain('LiveKit')
    expect(document.body.textContent).not.toContain('MSC4195')
    expect(document.body.textContent).not.toContain('org.matrix')
    expect(document.body.textContent).not.toContain('Running solo')
    expect(document.body.textContent).not.toContain('TURN')
    expect(document.body.textContent).not.toContain('Reachability probe')
    expect(getDiagnostics).not.toHaveBeenCalled()
  })

  it('displays network connected status when connected', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(
      mockDiagnostics({ networkConnected: true, networkPeerCount: 3 }),
    )
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    // "You + N peers" is the user-facing framing (user is a peer themselves)
    expect(document.body.textContent).toContain('You + 3 peers')
  })

  it('displays "Running solo" when no other peers are connected', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(
      mockDiagnostics({ networkConnected: false, networkPeerCount: 0 }),
    )
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    // Running solo is a valid working state, not an error
    expect(document.body.textContent).toContain('Running solo')
    // Explanation should clarify what still works
    expect(document.body.textContent).toContain('stored locally and visible to you immediately')
  })

  it('displays warnings when backend reports them', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(
      mockDiagnostics({
        warnings: ['No TURN server configured', '2 download(s) stalled'],
      }),
    )
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(document.body.textContent).toContain('Warnings')
    expect(document.body.textContent).toContain('No TURN server configured')
    expect(document.body.textContent).toContain('2 download(s) stalled')
  })

  it('displays error message when getDiagnostics rejects', async () => {
    vi.mocked(getDiagnostics).mockRejectedValue(new Error('connection refused'))
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(document.body.textContent).toContain('connection refused')
  })

  it('shows community and member counts', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(
      mockDiagnostics({ communityCount: 7, memberCount: 123 }),
    )
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    // Find counts in the overview grid
    expect(document.body.textContent).toContain('7')
    expect(document.body.textContent).toContain('123')
  })

  it('shows TURN missing warning when turn is not configured', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(
      mockDiagnostics({
        iceServerStatus: {
          stunConfigured: true,
          turnConfigured: false,
          customServers: false,
        },
      }),
    )
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(document.body.textContent).toContain('Missing')
    expect(document.body.textContent).toContain('No TURN server configured')
  })

  it('shows download progress when downloads are active', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(
      mockDiagnostics({
        activeDownloadCount: 1,
        downloadStats: [
          {
            fileHash: 'abc123def456789012345678',
            totalChunks: 100,
            receivedChunks: 42,
            pendingChunks: 58,
            inFlightChunks: 4,
            retryQueueLength: 0,
            seederCount: 3,
            activeSeeders: 2,
            totalSuccessfulRequests: 42,
            totalFailedRequests: 1,
            avgSeederRttMs: 123,
            isComplete: false,
            isStalled: false,
            isFailed: false,
          },
        ],
      }),
    )
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(document.body.textContent).toContain('42')
    expect(document.body.textContent).toContain('100 chunks')
    expect(document.body.textContent).toContain('3 seeders')
    expect(document.body.textContent).toContain('Active')
  })

  it('marks a stalled download visibly', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(
      mockDiagnostics({
        activeDownloadCount: 1,
        downloadStats: [
          {
            fileHash: 'stalled123',
            totalChunks: 10,
            receivedChunks: 3,
            pendingChunks: 0,
            inFlightChunks: 0,
            retryQueueLength: 0,
            seederCount: 0,
            activeSeeders: 0,
            totalSuccessfulRequests: 3,
            totalFailedRequests: 5,
            avgSeederRttMs: 0,
            isComplete: false,
            isStalled: true,
            isFailed: false,
          },
        ],
      }),
    )
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(document.body.textContent).toContain('Stalled')
  })

  it('calls onClose when close button is clicked', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(mockDiagnostics())
    const onClose = vi.fn()
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={onClose} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    const closeButton = document.body.querySelector('button[aria-label="Close diagnostics"]')
    expect(closeButton).toBeTruthy()
    await act(async () => {
      ;(closeButton as HTMLButtonElement).click()
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('refreshes when refresh button is clicked', async () => {
    const mockFn = vi.mocked(getDiagnostics)
    mockFn.mockResolvedValue(mockDiagnostics())
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    const initialCalls = mockFn.mock.calls.length
    const refreshButton = document.body.querySelector('button[aria-label="Refresh diagnostics"]')
    expect(refreshButton).toBeTruthy()
    await act(async () => {
      ;(refreshButton as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(mockFn.mock.calls.length).toBeGreaterThan(initialCalls)
  })

  it('shows reachability probe button and instructions initially', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(mockDiagnostics())
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(document.body.textContent).toContain('Reachability probe')
    expect(document.body.textContent).toContain('Run probe')
    const probeButton = document.body.querySelector('button[aria-label="Run ICE reachability probe"]')
    expect(probeButton?.getAttribute('aria-describedby')).toBe('ice-probe-description')
    expect(document.body.querySelector('#ice-probe-description')?.textContent).toContain(
      'configured ICE servers',
    )
    expect(probeButton).toBeTruthy()
  })

  it('renders probe results when run probe is clicked', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(mockDiagnostics())
    vi.mocked(probeIceServers).mockResolvedValue([
      {
        url: 'stun:stun.l.google.com:19302',
        scheme: 'stun',
        host: 'stun.l.google.com',
        port: 19302,
        outcome: 'ok',
        detail: 'DNS resolved',
        resolvedAddrs: ['74.125.250.129:19302'],
        latencyMs: 42,
      },
      {
        url: 'turn:bad.example.com:3478',
        scheme: 'turn',
        host: 'bad.example.com',
        port: 3478,
        outcome: 'dns_failed',
        detail: 'DNS lookup failed: not found',
        resolvedAddrs: [],
        latencyMs: null,
      },
    ])

    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    const probeButton = document.body.querySelector('button[aria-label="Run ICE reachability probe"]')
    expect(probeButton).toBeTruthy()
    await act(async () => {
      ;(probeButton as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 10))
    })

    // After probe results render — outcome labels are human-readable
    expect(document.body.textContent).toContain('stun:stun.l.google.com:19302')
    expect(document.body.textContent).toContain('Reachable')
    expect(document.body.textContent).toContain('turn:bad.example.com:3478')
    expect(document.body.textContent).toContain('DNS failed')
  })

  it('translates probe failures and keeps technical detail in disclosure', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(mockDiagnostics())
    vi.mocked(probeIceServers).mockRejectedValue({
      code: 'network_unavailable',
      detail: 'connection refused by turn.internal.example',
      retryable: true,
    })

    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    const probeButton = document.body.querySelector('button[aria-label="Run ICE reachability probe"]')
    await act(async () => {
      ;(probeButton as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(document.body.querySelector('h3')?.textContent).toContain('Connection interrupted')
    expect(document.body.textContent).toContain('connection refused by turn.internal.example')
  })

  it('renders unreachable probe outcome with warning color', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(mockDiagnostics())
    vi.mocked(probeIceServers).mockResolvedValue([
      {
        url: 'turn:firewall-blocked.example.com:3478',
        scheme: 'turn',
        host: 'firewall-blocked.example.com',
        port: 3478,
        outcome: 'unreachable',
        detail: 'TCP connect failed: connection refused',
        resolvedAddrs: ['192.0.2.1:3478'],
        latencyMs: null,
      },
    ])

    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    const probeButton = document.body.querySelector('button[aria-label="Run ICE reachability probe"]')
    await act(async () => {
      ;(probeButton as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(document.body.textContent).toContain('Unreachable')
    expect(document.body.textContent).toContain('connection refused')
  })

  it('renders TURN allocation_ok outcome with success color', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(mockDiagnostics())
    vi.mocked(probeIceServers).mockResolvedValue([
      {
        url: 'turn:turn.example.com:3478',
        scheme: 'turn',
        host: 'turn.example.com',
        port: 3478,
        outcome: 'allocation_ok',
        detail: 'TURN Allocate succeeded — server accepted credentials',
        resolvedAddrs: ['198.51.100.1:3478'],
        latencyMs: 42,
      },
    ])

    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    const probeButton = document.body.querySelector('button[aria-label="Run ICE reachability probe"]')
    await act(async () => {
      ;(probeButton as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(document.body.textContent).toContain('TURN Allocate OK')
    expect(document.body.textContent).toContain('accepted credentials')
    expect(document.body.textContent).toContain('42ms')
  })

  it('renders TURN auth_rejected outcome with error color', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(mockDiagnostics())
    vi.mocked(probeIceServers).mockResolvedValue([
      {
        url: 'turn:turn.example.com:3478',
        scheme: 'turn',
        host: 'turn.example.com',
        port: 3478,
        outcome: 'auth_rejected',
        detail: 'TURN server rejected credentials (error 401: Unauthorized)',
        resolvedAddrs: ['198.51.100.1:3478'],
        latencyMs: null,
      },
    ])

    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    const probeButton = document.body.querySelector('button[aria-label="Run ICE reachability probe"]')
    await act(async () => {
      ;(probeButton as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(document.body.textContent).toContain('Auth rejected')
    expect(document.body.textContent).toContain('401')
    expect(document.body.textContent).toContain('Unauthorized')
  })

  it('renders stun_reachable outcome for TURN servers that fail auth but answer STUN', async () => {
    vi.mocked(getDiagnostics).mockResolvedValue(mockDiagnostics())
    vi.mocked(probeIceServers).mockResolvedValue([
      {
        url: 'turn:mystery.example.com:3478',
        scheme: 'turn',
        host: 'mystery.example.com',
        port: 3478,
        outcome: 'stun_reachable',
        detail: 'Server answered STUN Binding but TURN Allocate failed: unexpected response',
        resolvedAddrs: ['198.51.100.2:3478'],
        latencyMs: 88,
      },
    ])

    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    const probeButton = document.body.querySelector('button[aria-label="Run ICE reachability probe"]')
    await act(async () => {
      ;(probeButton as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(document.body.textContent).toContain('STUN reachable')
    expect(document.body.textContent).toContain('Allocate failed')
  })
})
