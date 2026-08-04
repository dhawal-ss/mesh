import type { LegacyVoiceEngineConstructor } from './voice-runtime-types'

// Type-only contract. Vite resolves the implementation only in the explicit
// legacy LAN build, whose dependencies live in an independent lock graph.
export declare const VoiceEngine: LegacyVoiceEngineConstructor
