import type { BackendStatus } from './bridge'

/**
 * The only condition under which Mesh may load the legacy SimplePeer engine.
 *
 * All four assertions are intentional. A partially upgraded or malformed
 * backend response must fail closed, especially when the selected backend is
 * Matrix.
 */
export function canStartLegacyVoice(status: BackendStatus | null): boolean {
  return Boolean(
    status &&
      status.kind === 'legacy-p2p' &&
      status.capabilities.voice &&
      status.voiceService.provider === 'legacy-simple-peer' &&
      status.voiceService.availability === 'ready',
  )
}
