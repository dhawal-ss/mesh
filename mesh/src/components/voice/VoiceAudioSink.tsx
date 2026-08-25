import { useEffect, type RefObject } from 'react'
import { useRef } from 'react'
import { recordVoiceAudible } from '../../lib/voice-activation'
import { useVoiceStore } from '../../store/voice'
import type { Peer } from '../../types/ipc'

/**
 * Remote call audio for the whole session, mounted outside the voice room.
 *
 * The roster used to own the only <audio> elements in the app, so opening a text
 * channel unmounted them and silenced everyone, directly contradicting the dock's
 * promise that messages stay available during a call. Playback belongs to the
 * session, not to whichever view happens to be on screen.
 *
 * Keeping it here also means the roster may render twice, once as the wide
 * sidebar and once as the narrow drawer, without two elements playing the same
 * track over each other.
 */
export function VoiceAudioSink() {
  const peers = useVoiceStore((state) => state.peers)
  const currentChannelId = useVoiceStore((state) => state.currentChannelId)

  if (!currentChannelId) return null

  return (
    <div className="hidden" aria-hidden="true" data-mesh-voice-audio-sink="">
      {peers
        .filter((peer) => !peer.isSelf)
        .map((peer) => (
          <PeerAudio key={peer.publicKey} peer={peer} channelId={currentChannelId} />
        ))}
    </div>
  )
}

function PeerAudio({ peer, channelId }: { peer: Peer, channelId: string }) {
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const outputDeviceId = useVoiceStore((state) => state.outputDeviceId)
  const volume = useVoiceStore((state) => state.participantVolumes[peer.publicKey] ?? 1)
  const voiceRef = useRef<HTMLAudioElement>(null)
  const screenShareRef = useRef<HTMLAudioElement>(null)

  useAudioSink(voiceRef, peer.stream, volume, outputDeviceId)
  useAudioSink(screenShareRef, peer.screenShareAudioStream, volume, outputDeviceId)

  // Deafened output is still attached, so it stays evidence of delivery rather
  // than evidence the person heard it.
  const recordAudiblePlayback = () => {
    if (isDeafened) return
    recordVoiceAudible(channelId)
  }

  return (
    <>
      <audio
        ref={voiceRef}
        autoPlay
        muted={isDeafened}
        onPlaying={recordAudiblePlayback}
        data-peer-audio={peer.publicKey}
      />
      <audio
        ref={screenShareRef}
        autoPlay
        muted={isDeafened}
        onPlaying={recordAudiblePlayback}
        data-screen-share-audio={peer.screenShareAudioStream ? 'active' : undefined}
      />
    </>
  )
}

function useAudioSink(
  ref: RefObject<HTMLAudioElement | null>,
  stream: MediaStream | undefined,
  volume: number,
  outputDeviceId: string | null,
): void {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    // Reassigning an identical stream reloads the element and clips audio, so
    // only touch it when the source actually changed.
    if (element.srcObject !== (stream ?? null)) element.srcObject = stream ?? null
    element.volume = Math.min(1, Math.max(0, volume))
  }, [ref, stream, volume])

  useEffect(() => {
    const element = ref.current
    if (!element || !outputDeviceId || !stream) return
    // Routing to a chosen speaker is best effort: older WebView2 builds omit
    // setSinkId, and a device can disappear between selection and playback. Both
    // cases fall back to the system default, which is the right outcome.
    if (typeof element.setSinkId !== 'function') return
    void element.setSinkId(outputDeviceId).catch(() => {})
  }, [ref, outputDeviceId, stream])
}
