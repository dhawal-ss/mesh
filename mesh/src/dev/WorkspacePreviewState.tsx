import { useEffect } from 'react'
import { useVoiceStore } from '../store/voice'
import type { Peer } from '../types/ipc'

const previewPeers: Peer[] = [
  {
    publicKey: '@maya:mesh.test',
    peerId: 'maya-preview',
    displayName: 'Maya Chen',
    avatarColor: '#9b7cff',
    latency: 28,
    connectionState: 'connected',
    speaking: true,
  },
  {
    publicKey: '@rohan:mesh.test',
    peerId: 'rohan-preview',
    displayName: 'Rohan',
    avatarColor: '#f1a45b',
    latency: 35,
    connectionState: 'connected',
    speaking: false,
  },
  {
    publicKey: '@ari:mesh.test',
    peerId: 'ari-preview',
    displayName: 'Ari',
    avatarColor: '#d76aa8',
    latency: 31,
    connectionState: 'connected',
    speaking: false,
  },
  {
    publicKey: '@devon:mesh.test',
    peerId: 'devon-preview',
    displayName: 'Devon',
    avatarColor: '#55a8df',
    latency: 42,
    connectionState: 'connected',
    speaking: false,
  },
]

function seedPreviewVoiceSession() {
  const voice = useVoiceStore.getState()
  voice.setLocalPublicKey('@taylor:mesh.test')
  voice.setCurrentVoiceSession('!lantern-guild:mesh.test', '!studio:mesh.test')
  voice.setPeers(previewPeers)
  voice.setConnectionState('connected')
}

export function WorkspacePreviewState({ simulateVoice = false }: { simulateVoice?: boolean }) {
  useEffect(() => {
    if (!simulateVoice) {
      useVoiceStore.getState().resetVoiceState()
      return
    }

    const firstSeed = window.setTimeout(seedPreviewVoiceSession, 250)
    const settledSeed = window.setTimeout(seedPreviewVoiceSession, 1200)
    return () => {
      window.clearTimeout(firstSeed)
      window.clearTimeout(settledSeed)
    }
  }, [simulateVoice])

  return null
}
