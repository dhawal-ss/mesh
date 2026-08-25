import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react'
import { useVoiceEngine } from '../../hooks/useVoiceEngine'

export type VoiceEngineController = ReturnType<typeof useVoiceEngine>

const VoiceEngineContext = createContext<VoiceEngineController | null>(null)

/**
 * Owns the call runtime above room navigation so opening messages cannot
 * silently disconnect media while leaving a stale call dock on screen.
 */
export function VoiceEngineProvider({ children }: { children: ReactNode }) {
  const {
    connectionWarning,
    microphonePermission,
    relayChanged,
    voiceService,
    matrixVoiceReady,
    matrixUnavailableReason,
    devices,
    stats,
    refreshDevices,
    switchInputDevice,
    switchOutputDevice,
    switchCameraDevice,
    updateAudioProcessing,
    setParticipantVolume,
    toggleCamera,
    toggleScreenSharing,
  } = useVoiceEngine()
  /*
   * The hook returns a fresh object literal on every render, and this provider
   * re-renders with the whole authenticated shell. Publishing that object
   * directly invalidated the context, and every call consumer with it, on
   * renders where nothing about the call had changed. The hook's own values
   * are already stable (state, store slices and useCallback handles), so an
   * explicit dependency list is enough.
   */
  const controller = useMemo<VoiceEngineController>(() => ({
    connectionWarning,
    microphonePermission,
    relayChanged,
    voiceService,
    matrixVoiceReady,
    matrixUnavailableReason,
    devices,
    stats,
    refreshDevices,
    switchInputDevice,
    switchOutputDevice,
    switchCameraDevice,
    updateAudioProcessing,
    setParticipantVolume,
    toggleCamera,
    toggleScreenSharing,
  }), [
    connectionWarning,
    microphonePermission,
    relayChanged,
    voiceService,
    matrixVoiceReady,
    matrixUnavailableReason,
    devices,
    stats,
    refreshDevices,
    switchInputDevice,
    switchOutputDevice,
    switchCameraDevice,
    updateAudioProcessing,
    setParticipantVolume,
    toggleCamera,
    toggleScreenSharing,
  ])

  return (
    <VoiceEngineContext.Provider value={controller}>
      {children}
    </VoiceEngineContext.Provider>
  )
}

export function useVoiceEngineController(): VoiceEngineController {
  const controller = useContext(VoiceEngineContext)
  if (!controller) {
    throw new Error('Voice controls must be rendered inside VoiceEngineProvider')
  }
  return controller
}
