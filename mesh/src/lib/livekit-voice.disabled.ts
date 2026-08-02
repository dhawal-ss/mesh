/**
 * Compile-time replacement for the Matrix media implementation in artifacts
 * that have not passed physical voice acceptance. The call site is also
 * guarded by a constant false branch, but the alias prevents Vite from even
 * resolving LiveKit's E2EE worker as an orphaned production asset.
 */
export class LiveKitVoiceEngine {
  constructor() {
    throw new Error('Calling is not included in this Mesh build.')
  }
}
