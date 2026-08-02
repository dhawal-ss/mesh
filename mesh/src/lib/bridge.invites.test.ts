import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  generateInviteLink,
  getBackendStatus,
  joinOrRequestCommunity,
} from './bridge'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)
const isTauriMock = vi.mocked(isTauri)

const MATRIX_STATUS = {
  kind: 'matrix',
  capabilities: {
    encryptedText: true,
    encryptedAttachments: true,
    directMessages: true,
    voice: false,
    durableTimeouts: false,
    deviceManagement: true,
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
    reason: 'not configured',
  },
  authenticated: true,
  userId: '@alice:mesh.test',
  deviceId: 'DEVICE',
  homeserver: 'https://matrix.mesh.test',
  syncRunning: true,
  durableHistory: true,
  endToEndEncryption: true,
  warnings: [],
} as const

describe('Matrix community invitation bridge', () => {
  beforeEach(async () => {
    invokeMock.mockReset()
    isTauriMock.mockReturnValue(true)
    invokeMock.mockResolvedValueOnce(MATRIX_STATUS)
    await getBackendStatus()
    invokeMock.mockReset()
  })

  it('uses the backend-owned Matrix invite command', async () => {
    const link =
      'https://mesh.test/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
    invokeMock.mockResolvedValueOnce(link)

    await expect(generateInviteLink('!community:mesh.test')).resolves.toBe(link)
    expect(invokeMock).toHaveBeenCalledWith('matrix_create_community_invite', {
      communityId: '!community:mesh.test',
    })
  })

  it('refuses to pass a private admission secret through renderer IPC', async () => {
    const link =
      'https://mesh.test/invite/abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
    await expect(joinOrRequestCommunity(link)).rejects.toMatchObject({
      code: 'community_invite_requires_native_open',
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('passes the federation route and requests access when direct join is denied', async () => {
    const link =
      'mesh://join?v=3&kind=matrix&room=!community:mesh.test&via=mesh.test&service=https%3A%2F%2Fmatrix.mesh.test'
    invokeMock
      .mockRejectedValueOnce({
        code: 'permission_denied',
        detail: 'M_FORBIDDEN: invite required',
        retryable: false,
      })
      .mockResolvedValueOnce({ status: 'knocked', community: null })

    await expect(joinOrRequestCommunity(link)).resolves.toEqual({
      status: 'knocked',
      community: null,
    })
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'matrix_join_community', {
      roomOrAlias: '!community:mesh.test',
      via: ['mesh.test'],
    })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'matrix_knock_community', {
      roomOrAlias: '!community:mesh.test',
      reason: 'Requested through a private Mesh community link.',
      via: ['mesh.test'],
    })
  })

  it('does not bypass a version 5 admission service when its native join fails', async () => {
    const code = 'abcdefghijklmnopqrstuvwxyzABCDEFG_123456789'
    const link =
      `mesh://join?v=5&kind=community&room=!community%3Amesh.test&via=mesh.test`
      + `&admission=https%3A%2F%2Finvites.mesh.test&code=${code}`
    await expect(joinOrRequestCommunity(link)).rejects.toMatchObject({
      code: 'community_invite_requires_native_open',
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('rejects malformed Mesh links before invoking Rust', async () => {
    await expect(
      joinOrRequestCommunity(
        'mesh://join?v=3&kind=matrix&room=!community:mesh.test',
      ),
    ).rejects.toMatchObject({ code: 'community_invite_invalid' })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
