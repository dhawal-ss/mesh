import type { LiveKitVoiceEngineConstructor } from './voice-runtime-types'

// Type-only contract. Vite replaces this module with either the separately
// installed Matrix-voice implementation or the fail-closed text-build stub.
export declare const LiveKitVoiceEngine: LiveKitVoiceEngineConstructor
