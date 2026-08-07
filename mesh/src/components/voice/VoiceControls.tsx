import { useState } from 'react'
import { motion } from 'framer-motion'
import type { VoiceDevice } from '../../lib/voice-runtime-types'
import { useVoiceStore } from '../../store/voice'
import { Tooltip } from '../ui/Tooltip'
import { transitions } from '../../lib/motion'
import { Icon } from '../ui/Icon'
import {
  voiceConnectionLabel,
  voiceMediaErrorMessage,
} from '../../lib/voice-runtime'
import { Popover } from '../ui/InteractivePrimitives'
import { IconButton } from '../ui/IconButton'

interface VoiceControlsProps {
  devices: VoiceDevice[]
  roomName: string
  leaving?: boolean
  onOpenMessages: () => void
  onLeave: () => void
  onInputDeviceChange: (deviceId: string) => Promise<void>
  onOutputDeviceChange: (deviceId: string) => Promise<void>
  onCameraChange: (enabled: boolean) => Promise<void>
  onScreenShareChange: (enabled: boolean) => Promise<void>
}

export function VoiceControls({
  devices,
  roomName,
  leaving = false,
  onOpenMessages,
  onLeave,
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
  const connectionState = useVoiceStore((state) => state.connectionState)
  const lastReconnectReason = useVoiceStore((state) => state.lastReconnectReason)
  const [controlError, setControlError] = useState<string | null>(null)
  const [pendingMedia, setPendingMedia] = useState<'camera' | 'screen' | null>(null)
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
    } catch {
      setControlError(
        kind === 'input'
          ? 'Mesh could not switch microphones. Check that your microphone is connected and allowed in system settings, then try again.'
          : 'Mesh could not switch speakers. Check that your speakers or headphones are connected, then try again.',
      )
    }
  }

  const changeMedia = async (kind: 'camera' | 'screen', enabled: boolean) => {
    setControlError(null)
    setPendingMedia(kind)
    try {
      if (kind === 'camera') {
        await onCameraChange(enabled)
      } else {
        await onScreenShareChange(enabled)
      }
    } catch (error) {
      setControlError(voiceMediaErrorMessage(error, kind))
    } finally {
      setPendingMedia(null)
    }
  }

  return (
    <motion.div
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={transitions.move}
      className="mesh-voice-controls flex w-full flex-col items-center gap-2"
      aria-label="Voice controls"
    >
      <span className="sr-only" role="status">
        {connectionLabel}
        {lastReconnectReason ? `. ${lastReconnectReason}` : ''}
      </span>

      <div className="flex w-full max-w-4xl items-center justify-center gap-1.5 bg-surface-base">
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
            /*
             * Push-to-talk was pointer-only. The advertised "Hold Space"
             * fallback is a window listener that skips any interactive target,
             * and a <button> is interactive: including this one: so a
             * keyboard-only user in PTT mode could not transmit at all.
             * Handling the keys on the button itself fixes that without
             * loosening the global guard that stops Space in the composer from
             * opening the mic.
             */
            onKeyDown={(event) => {
              if (inputMode !== 'push-to-talk') return
              if (event.key !== ' ' && event.key !== 'Enter') return
              if (event.repeat) return
              event.preventDefault()
              holdToTalk(true)
            }}
            onKeyUp={(event) => {
              if (inputMode !== 'push-to-talk') return
              if (event.key !== ' ' && event.key !== 'Enter') return
              event.preventDefault()
              holdToTalk(false)
            }}
            onBlur={() => {
              if (inputMode === 'push-to-talk') holdToTalk(false)
            }}
            aria-keyshortcuts={inputMode === 'push-to-talk' ? 'Space' : undefined}
            aria-pressed={inputMode === 'push-to-talk' ? isPushToTalking : isMuted}
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
                : 'bg-surface-hover text-primary hover:bg-surface-active'
            }`}
          >
            <Icon name={isMuted && !isPushToTalking ? 'micOff' : 'mic'} />
          </motion.button>
        </Tooltip>

        <Tooltip
          content={isDeafened ? 'Turn incoming audio on' : 'Turn incoming audio off'}
          side="top"
        >
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => setDeafened(!isDeafened)}
            aria-pressed={isDeafened}
            aria-label={isDeafened ? 'Turn incoming audio on' : 'Turn incoming audio off'}
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
              isDeafened
                ? 'bg-status-warning text-content-on-status'
                : 'bg-surface-hover text-primary hover:bg-surface-active'
            }`}
          >
            <Icon name={isDeafened ? 'headphoneOff' : 'headphones'} />
          </motion.button>
        </Tooltip>

        {/*
          A disabled button is not focusable and swallows pointer events, so its
          Tooltip can never open: the reason it is off was unreachable. The
          reason now lives in the accessible name itself.
        */}
        <Tooltip
          content={
            !connected
              ? 'Available once you are connected'
              : isCameraEnabled ? 'Turn camera off' : 'Turn camera on'
          }
          side="top"
        >
          <button
            type="button"
            disabled={!connected || pendingMedia !== null}
            onClick={() => void changeMedia('camera', !isCameraEnabled)}
            aria-label={
              !connected
                ? 'Turn camera on: available once you are connected'
                : pendingMedia === 'camera'
                  ? isCameraEnabled ? 'Stopping camera' : 'Starting camera'
                  : isCameraEnabled ? 'Turn camera off' : 'Turn camera on'
            }
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              isCameraEnabled
                ? 'bg-accent text-content-on-accent'
                : 'bg-surface-hover text-primary hover:bg-surface-active'
            }`}
          >
            <Icon name="image" />
          </button>
        </Tooltip>

        <Tooltip
          content={
            !connected
              ? 'Available once you are connected'
              : isScreenSharing ? 'Stop sharing' : 'Share a screen or window'
          }
          side="top"
        >
          <button
            type="button"
            disabled={!connected || pendingMedia !== null}
            onClick={() => void changeMedia('screen', !isScreenSharing)}
            aria-label={
              !connected
                ? 'Share screen: available once you are connected'
                : pendingMedia === 'screen'
                  ? isScreenSharing ? 'Stopping screen share' : 'Starting screen share'
                  : isScreenSharing ? 'Stop sharing screen' : 'Share screen'
            }
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              isScreenSharing
                ? 'bg-accent text-content-on-accent'
                : 'bg-surface-hover text-primary hover:bg-surface-active'
            }`}
          >
            <Icon name="upload" />
          </button>
        </Tooltip>

        <Popover
          trigger={
            <IconButton
              size="lg"
              aria-label="Open voice settings"
              className="h-11 w-11 rounded-full bg-surface-hover text-primary hover:bg-surface-active"
            >
              <Icon name="settings" />
            </IconButton>
          }
          label="Voice settings"
          description="Choose how Mesh captures and plays call audio."
          side="top"
          align="center"
          className="w-72 p-3"
        >
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-meta text-muted">
              Talk mode
              <select
                value={inputMode}
                onChange={(event) =>
                  setInputMode(event.target.value as 'voice-activity' | 'push-to-talk')
                }
                className="h-control-md rounded-control border border-border bg-surface-sunken px-2 text-xs text-primary outline-none focus:border-accent"
              >
                <option value="voice-activity">Voice activity</option>
                <option value="push-to-talk">Push to talk</option>
              </select>
            </label>

            <div className="h-px bg-border-subtle" aria-hidden="true" />

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
                className="h-1.5 overflow-hidden rounded-full bg-surface-sunken"
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

            {inputMode === 'push-to-talk' && (
              <p className="text-meta text-muted">Hold Space while this view is focused to talk.</p>
            )}
          </div>
        </Popover>

        <div className="mx-0.5 h-6 w-px bg-border-subtle" aria-hidden="true" />

        <button
          type="button"
          onClick={onOpenMessages}
          className="flex min-h-11 items-center gap-2 px-3 text-xs font-semibold text-content-secondary transition-colors hover:bg-surface-hover hover:text-content"
          aria-label={`Open messages from ${roomName}`}
        >
          <Icon name="messageCircle" size="sm" />
          <span className="hidden sm:inline">Messages</span>
        </button>

        <Tooltip content={`Leave ${roomName}`} side="top">
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            disabled={leaving}
            onClick={onLeave}
            aria-label={`Leave ${roomName}`}
            className="flex min-h-11 items-center justify-center gap-2 border border-status-danger/60 px-3 text-xs font-semibold text-status-danger transition-colors hover:bg-status-danger/10 disabled:opacity-60"
          >
            <Icon name="phoneOff" />
            <span className="hidden sm:inline">{leaving ? 'Leaving' : 'Leave'}</span>
          </motion.button>
        </Tooltip>
      </div>

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
        className="h-control-md min-w-0 rounded-control border border-border bg-surface-sunken px-2 text-xs text-primary outline-none focus:border-accent disabled:opacity-60"
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
