import type { BackendStatus } from '../types/ipc'
import type { SystemDiagnostics } from './bridge'
import { getRuntimeErrorSummary, type RuntimeErrorSummary } from './runtime-error-reporting'
import { MESH_APP_VERSION } from './beta-release'

export const MAX_SUPPORT_BUNDLE_BYTES = 16 * 1024

interface SupportBundle {
  schemaVersion: 1
  generatedAt: string
  backend: 'matrix' | 'legacy-p2p'
  appVersion: string
  health: Record<string, boolean | number | string>
  errors: RuntimeErrorSummary
  privacy: {
    containsAccountIdentifiers: false
    containsRoomOrMessageContent: false
    containsFilesystemPaths: false
    containsCredentials: false
    automaticUpload: false
  }
}

export function createMatrixSupportBundle(data: BackendStatus, now = new Date()): SupportBundle {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    backend: 'matrix',
    appVersion: MESH_APP_VERSION,
    health: {
      authenticated: data.authenticated,
      syncRunning: data.syncRunning,
      supportsE2ee: data.supportsE2ee,
      sessionE2eeReady: data.sessionE2eeReady,
      durableHistory: data.durableHistory,
      warningCount: data.warnings.length,
      voiceAvailability: data.voiceService.availability,
      voiceMediaProtectionReady: data.voiceService.mediaE2eeReady,
    },
    errors: getRuntimeErrorSummary(),
    privacy: privacyContract(),
  }
}

export function createLegacySupportBundle(
  data: SystemDiagnostics,
  now = new Date(),
): SupportBundle {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    backend: 'legacy-p2p',
    appVersion: data.version,
    health: {
      networkConnected: data.networkConnected,
      networkPeerCount: data.networkPeerCount,
      identityLoaded: data.identityLoaded,
      communityCount: data.communityCount,
      memberCount: data.memberCount,
      activeDownloadCount: data.activeDownloadCount,
      activeVoiceSessions: data.activeVoiceSessions,
      pendingMessageCount: data.pendingMessageCount,
      warningCount: data.warnings.length,
    },
    errors: getRuntimeErrorSummary(),
    privacy: privacyContract(),
  }
}

function privacyContract(): SupportBundle['privacy'] {
  return {
    containsAccountIdentifiers: false,
    containsRoomOrMessageContent: false,
    containsFilesystemPaths: false,
    containsCredentials: false,
    automaticUpload: false,
  }
}

export function serializeSupportBundle(bundle: SupportBundle): string {
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`
  if (new TextEncoder().encode(serialized).byteLength > MAX_SUPPORT_BUNDLE_BYTES) {
    throw new Error('The support bundle exceeded its local size limit.')
  }
  return serialized
}

export function saveSupportBundle(serialized: string): void {
  if (new TextEncoder().encode(serialized).byteLength > MAX_SUPPORT_BUNDLE_BYTES) {
    throw new Error('The support bundle exceeded its local size limit.')
  }
  const blob = new Blob([serialized], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `mesh-support-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
