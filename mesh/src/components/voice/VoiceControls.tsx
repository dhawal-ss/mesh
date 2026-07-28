import { useState } from 'react'
import { motion } from 'framer-motion'
import type { VoiceDevice } from '../../lib/livekit-voice'
import { useVoiceStore } from '../../store/voice'
import { Tooltip } from '../ui/Tooltip'
import { transitions } from '../../lib/motion'
import { Icon } from '../ui/Icon'
import { voiceConnectionLabel } from '../../lib/voice-runtime'

interface VoiceControlsProps {
  devices: VoiceDevice[]
  onInputDeviceChange: (deviceId: string) => Promise<void>
  onOutputDeviceChange: (deviceId: string) => Promise<void>
  onCameraChange: (enabled: boolean) => Promise<void>
  onScreenShareChange: (enabled: boolean) => Promise<void>
}

export function VoiceControls({
  devices,
  onInputDeviceChange,
  onOutputDeviceChange,
  onCameraChange,
  onScreenShareChange,
}: VoiceControlsProps) {
  const isMuted = useVoiceStore((state) => state.isMuted)
  const isDeafened = useVoiceStore((state) => state.isDeafened)
  const inputMode = useVoiceStore((state) => state.inputMode)
  const isPushToTalking = useVoiceStore((state) => state.isPushToTalking)
  const isCameraEnabled = useVoiceStore((state) => state.isCameraEnabled)
  const isScreenSharing = useVoiceStore((state) => state.isScreenSharing)
  const inputDeviceId = useVoiceStore((state) => state.inputDeviceId)
  const outputDeviceId = useVoiceStore((state) => state.outputDeviceId)
  const localAudioLevel = useVoiceStore((state) => state.localAudioLevel)
  const setMuted = useVoiceStore((state) => state.setMuted)
  const setDeafened = useVoiceStore((state) => state.setDeafened)
  const setInputMode = useVoiceStore((state) => state.setInputMode)
  const setPushToTalking = useVoiceStore((state) => state.setPushToTalking)
  const setInputDeviceId = useVoiceStore((state) => state.setInputDeviceId)
  const setOutputDeviceId = useVoiceStore((state) => state.setOutputDeviceId)
  const setCurrentVoiceSession = useVoiceStore((state) => state.setCurrentVoiceSession)
  const connectionState = useVoiceStore((state) => state.connectionState)
  const lastReconnectReason = useVoiceStore((state) => state.lastReconnectReason)
  const [controlError, setControlError] = useState<string | null>(null)
  const inputs = devices.filter((device) => device.kind === 'audioinput')
  const outputs = devices.filter((device) => device.kind === 'audiooutput')
  const connected = connectionState === 'connected'
  const connectionLabel = voiceConnectionLabel(connectionState)

  const holdToTalk = (talking: boolean) => {
    if (inputMode !== 'push-to-talk') return
    setPushToTalking(talking)
    setMuted(!talking)
  }

  const changeDevice = async (
    kind: 'input' | 'output',
    deviceId: string,
  ) => {
    setControlError(null)
    try {
      if (kind === 'input') {
        await onInputDeviceChange(deviceId)
        setInputDeviceId(deviceId)
      } else {
        await onOutputDeviceChange(deviceId)
        setOutputDeviceId(deviceId)
      }
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'The audio device could not be selected.')
    }
  }

  const changeMedia = async (kind: 'camera' | 'screen', enabled: boolean) => {
    setControlError(null)
    try {
      if (kind === 'camera') {
        await onCameraChange(enabled)
      } else {
        await onScreenShareChange(enabled)
      }
    } catch (error) {
      setControlError(
        error instanceof Error
          ? error.message
          : kind === 'camera'
            ? 'The camera could not be changed.'
            : 'Screen sharing could not be changed.',
      )
    }
  }

  return (
    <motion.div
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={transitions.move}
      className="flex max-w-5xl flex-col gap-3 rounded-lg bg-bg-secondary px-4 py-3 shadow-overlay"
      aria-label="Voice controls"
    >
      <div className="flex items-center gap-3">
        <div className="flex min-w-voice-label flex-col">
          <span className="text-meta uppercase tracking-control text-muted">{connectionLabel}</span>
          <span className="text-xs text-secondary">
            {connectionState}
            {lastReconnectReason ? ` · ${lastReconnectReason}` : ''}
          </span>
        </div>

        <label className="flex flex-col gap-1 text-meta text-muted">
          Talk mode
          <select
            value={inputMode}
            onChange={(event) =>
              setInputMode(event.target.value as 'voice-activity' | 'push-to-talk')
            }
            className="h-9 rounded-md border border-border bg-bg-primary px-2 text-xs text-primary"
          >
            <option value="voice-activity">Voice activity</option>
            <option value="push-to-talk">Push to talk</option>
          </select>
        </label>

        <Tooltip
          content={
            inputMode === 'push-to-talk'
              ? 'Hold this button or Space to talk'
              : isMuted
                ? 'Unmute'
                : 'Mute'
          }
          side="top"
        >
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => {
              if (inputMode === 'voice-activity') setMuted(!isMuted)
            }}
            onPointerDown={(event) => {
              if (inputMode !== 'push-to-talk') return
              event.currentTarget.setPointerCapture?.(event.pointerId)
              holdToTalk(true)
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              holdToTalk(false)
            }}
            onPointerCancel={(event) => {
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              holdToTalk(false)
            }}
            onLostPointerCapture={() => holdToTalk(false)}
            aria-label={
              inputMode === 'push-to-talk'
                ? isPushToTalking
                  ? 'Release to mute microphone'
                  : 'Hold to talk'
                : isMuted
                  ? 'Unmute microphone'
                  : 'Mute microphone'
            }
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
              isMuted && !isPushToTalking
                ? 'bg-status-warning text-content-on-status'
                : 'bg-bg-modifier-hover text-primary hover:bg-bg-modifier-active'
            }`}
          >
            <Icon name={isMuted && !isPushToTalking ? 'micOff' : 'mic'} />
          </motion.button>
        </Tooltip>

        <Tooltip content={isDeafened ? 'Undeafen' : 'Deafen'} side="top">
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => setDeafened(!isDeafened)}
            aria-label={isDeafened ? 'Undeafen audio' : 'Deafen audio'}
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
              isDeafened
                ? 'bg-status-warning text-content-on-status'
                : 'bg-bg-modifier-hover text-primary hover:bg-bg-modifier-active'
            }`}
          >
            <Icon name={isDeafened ? 'headphoneOff' : 'headphones'} />
          </motion.button>
        </Tooltip>

        <Tooltip content={isCameraEnabled ? 'Turn camera off' : 'Turn camera on'} side="top">
          <button
            type="button"
            disabled={!connected}
            onClick={() => void changeMedia('camera', !isCameraEnabled)}
            aria-label={isCameraEnabled ? 'Turn camera off' : 'Turn camera on'}
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              isCameraEnabled
                ? 'bg-accent text-content-on-accent'
                : 'bg-bg-modifier-hover text-primary hover:bg-bg-modifier-active'
            }`}
          >
            <Icon name="image" />
          </button>
        </Tooltip>

        <Tooltip content={isScreenSharing ? 'Stop sharing' : 'Share a screen or window'} side="top">
          <button
            type="button"
            disabled={!connected}
            onClick={() => void changeMedia('screen', !isScreenSharing)}
            aria-label={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              isScreenSharing
                ? 'bg-accent text-content-on-accent'
                : 'bg-bg-modifier-hover text-primary hover:bg-bg-modifier-active'
            }`}
          >
            <Icon name="upload" />
          </button>
        </Tooltip>

        <div className="mx-1 h-6 w-px bg-border" />

        <Tooltip content="Disconnect" side="top">
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => setCurrentVoiceSession(null, null)}
            aria-label="Disconnect from voice room"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-status-danger text-content-on-status transition-opacity hover:opacity-90"
          >
            <Icon name="phoneOff" />
          </motion.button>
        </Tooltip>
      </div>

      <div className="grid grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_7rem] items-end gap-3">
        <DeviceSelect
          label="Microphone"
          value={inputDeviceId}
          devices={inputs}
          unavailableLabel="No microphone found"
          onChange={(deviceId) => void changeDevice('input', deviceId)}
        />
        <DeviceSelect
          label="Speaker"
          value={outputDeviceId}
          devices={outputs}
          unavailableLabel="System default output"
          onChange={(deviceId) => void changeDevice('output', deviceId)}
        />
        <div className="space-y-1">
          <span className="text-meta text-muted">Input level</span>
          <div
            className="h-2 overflow-hidden rounded-full bg-bg-primary"
            role="meter"
            aria-label="Microphone input level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(localAudioLevel * 100)}
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-100"
              data-design-token-exception="Live microphone level determines meter width."
              style={{ width: `${Math.max(2, localAudioLevel * 100)}%` }}
            />
          </div>
        </div>
      </div>

      {inputMode === 'push-to-talk' && (
        <p className="text-meta text-muted">Hold Space while this view is focused to talk.</p>
      )}
      {controlError && (
        <p className="text-meta text-status-danger" role="alert">
          {controlError}
        </p>
      )}
    </motion.div>
  )
}

function DeviceSelect({
  label,
  value,
  devices,
  unavailableLabel,
  onChange,
}: {
  label: string
  value: string | null
  devices: VoiceDevice[]
  unavailableLabel: string
  onChange: (deviceId: string) => void
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-meta text-muted">
      {label}
      <select
        value={value ?? ''}
        disabled={devices.length === 0}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 min-w-0 rounded-md border border-border bg-bg-primary px-2 text-xs text-primary disabled:opacity-60"
      >
        <option value="">{devices.length === 0 ? unavailableLabel : `Default ${label.toLowerCase()}`}</option>
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
          </option>
        ))}
      </select>
    </label>
  )
}
