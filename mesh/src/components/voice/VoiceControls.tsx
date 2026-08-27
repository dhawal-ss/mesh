import { useState } from 'react'
import { motion } from '../../lib/lazy-motion'
import type { VoiceDevice } from '../../lib/voice-runtime-types'
import type { AudioProcessingSettings } from '../../lib/voice-runtime-types'
import { useVoiceStore } from '../../store/voice'
import { Tooltip } from '../ui/Tooltip'
import { motionOffsets, motionScales, transitions } from '../../lib/motion'
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
  onCameraDeviceChange: (deviceId: string) => Promise<void>
  onAudioProcessingChange: (settings: AudioProcessingSettings) => Promise<void>
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
  onCameraDeviceChange,
  onAudioProcessingChange,
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
  const cameraDeviceId = useVoiceStore((state) => state.cameraDeviceId)
  const localAudioLevel = useVoiceStore((state) => state.localAudioLevel)
  const audioProcessing = useVoiceStore((state) => state.audioProcessing)
  const setMuted = useVoiceStore((state) => state.setMuted)
  const setDeafened = useVoiceStore((state) => state.setDeafened)
  const setInputMode = useVoiceStore((state) => state.setInputMode)
  const setPushToTalking = useVoiceStore((state) => state.setPushToTalking)
  const setInputDeviceId = useVoiceStore((state) => state.setInputDeviceId)
  const setOutputDeviceId = useVoiceStore((state) => state.setOutputDeviceId)
  const setCameraDeviceId = useVoiceStore((state) => state.setCameraDeviceId)
  const connectionState = useVoiceStore((state) => state.connectionState)
  const lastReconnectReason = useVoiceStore((state) => state.lastReconnectReason)
  const [controlError, setControlError] = useState<string | null>(null)
  const [pendingMedia, setPendingMedia] = useState<'camera' | 'screen-share' | null>(null)
  const [pendingProcessing, setPendingProcessing] = useState<keyof AudioProcessingSettings | null>(null)
  const inputs = devices.filter((device) => device.kind === 'audioinput')
  const outputs = devices.filter((device) => device.kind === 'audiooutput')
  const cameras = devices.filter((device) => device.kind === 'videoinput')
  const connected = connectionState === 'connected'
  const connectionLabel = voiceConnectionLabel(connectionState)

  const holdToTalk = (talking: boolean) => {
    if (inputMode !== 'push-to-talk') return
    setPushToTalking(talking)
    setMuted(!talking)
  }

  const changeDevice = async (
    kind: 'input' | 'output' | 'camera',
    deviceId: string,
  ) => {
    setControlError(null)
    try {
      if (kind === 'input') {
        await onInputDeviceChange(deviceId)
        setInputDeviceId(deviceId)
      } else if (kind === 'output') {
        await onOutputDeviceChange(deviceId)
        setOutputDeviceId(deviceId)
      } else {
        await onCameraDeviceChange(deviceId)
        setCameraDeviceId(deviceId)
      }
    } catch {
      setControlError(
        kind === 'input'
          ? 'Mesh could not switch microphones. Check that it is connected and allowed in system settings.'
          : kind === 'output'
            ? 'Mesh could not switch speakers. Check that they are connected.'
            : 'Mesh could not switch cameras. Check that it is connected and allowed in system settings.',
      )
    }
  }

  const changeCamera = async (enabled: boolean) => {
    setControlError(null)
    setPendingMedia('camera')
    try {
      await onCameraChange(enabled)
    } catch (error) {
      setControlError(voiceMediaErrorMessage(error, 'camera'))
    } finally {
      setPendingMedia(null)
    }
  }

  const changeScreenSharing = async (enabled: boolean) => {
    setControlError(null)
    setPendingMedia('screen-share')
    try {
      await onScreenShareChange(enabled)
    } catch (error) {
      setControlError(voiceMediaErrorMessage(error, 'screen-share'))
    } finally {
      setPendingMedia(null)
    }
  }

  const changeAudioProcessing = async (setting: keyof AudioProcessingSettings) => {
    setControlError(null)
    setPendingProcessing(setting)
    try {
      await onAudioProcessingChange({
        ...audioProcessing,
        [setting]: !audioProcessing[setting],
      })
    } catch {
      setControlError(
        'Mesh could not apply that audio setting, so the previous one is still active.',
      )
    } finally {
      setPendingProcessing(null)
    }
  }

  return (
    <motion.div
      initial={{ y: motionOffsets.dock, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={transitions.move}
      className="mesh-voice-controls flex w-full flex-col items-center gap-2"
      aria-label="Voice controls"
    >
      <span className="sr-only" role="status">
        {connectionLabel}
        {lastReconnectReason ? `. ${lastReconnectReason}` : ''}
      </span>

      {/*
        The Material 3 floating toolbar: 56px circles on an elevated pill,
        rather than a row of labelled cells sharing one hairline. Each control
        keeps its accessible name and its tooltip, and the glyph changes with
        the state -- a muted microphone is `micOff`, not a differently coloured
        `mic` -- so nothing here is carried by colour alone.
      */}
      <div className="mesh-voice-toolbar flex max-w-full items-center gap-2 overflow-x-auto rounded-full bg-surface-container-high p-3 shadow-elev-4">
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
            whileHover={{ scale: motionScales.hover }}
            whileTap={{ scale: motionScales.press }}
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
            className={`flex h-control-lg w-control-lg flex-none items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40 ${
              isMuted && !isPushToTalking
                ? 'bg-marker text-on-marker'
                : 'bg-surface-container-highest text-on-surface hover:bg-state-hover'
            }`}
          >
            <Icon name={isMuted && !isPushToTalking ? 'micOff' : 'mic'} size="sm" />
          </motion.button>
        </Tooltip>

        <Tooltip
          content={isDeafened ? 'Turn incoming audio on' : 'Turn incoming audio off'}
          side="top"
        >
          <motion.button
            whileHover={{ scale: motionScales.hover }}
            whileTap={{ scale: motionScales.press }}
            onClick={() => setDeafened(!isDeafened)}
            aria-pressed={isDeafened}
            aria-label={isDeafened ? 'Turn incoming audio on' : 'Turn incoming audio off'}
            className={`flex h-control-lg w-control-lg flex-none items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40 ${
              isDeafened
                ? 'bg-marker text-on-marker'
                : 'bg-surface-container-highest text-on-surface hover:bg-state-hover'
            }`}
          >
            <Icon name={isDeafened ? 'headphoneOff' : 'headphones'} size="sm" />
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
            onClick={() => void changeCamera(!isCameraEnabled)}
            aria-label={
              !connected
                ? 'Turn camera on: available once you are connected'
                : pendingMedia === 'camera'
                  ? isCameraEnabled ? 'Stopping camera' : 'Starting camera'
                  : isCameraEnabled ? 'Turn camera off' : 'Turn camera on'
            }
            className={`flex h-control-lg w-control-lg flex-none items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40 ${
              isCameraEnabled
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-highest text-on-surface hover:bg-state-hover'
            }`}
          >
            <Icon name={isCameraEnabled ? 'videoOff' : 'video'} size="sm" />
          </button>
        </Tooltip>

        <Tooltip
          content={
            !connected
              ? 'Available once you are connected'
              : isScreenSharing ? 'Stop sharing your screen' : 'Share a window or screen'
          }
          side="top"
        >
          <button
            type="button"
            disabled={!connected || pendingMedia !== null}
            onClick={() => void changeScreenSharing(!isScreenSharing)}
            aria-pressed={isScreenSharing}
            aria-label={
              !connected
                ? 'Share screen: available once you are connected'
                : pendingMedia === 'screen-share'
                  ? isScreenSharing ? 'Stopping screen sharing' : 'Starting screen sharing'
                  : isScreenSharing ? 'Stop sharing screen' : 'Share screen'
            }
            data-screen-sharing={isScreenSharing || undefined}
            className={`flex h-control-lg w-control-lg flex-none items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40 ${
              isScreenSharing
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-highest text-on-surface hover:bg-state-hover'
            }`}
          >
            <Icon name={isScreenSharing ? 'screenShareOff' : 'screenShare'} size="sm" />
          </button>
        </Tooltip>

        <Popover
          trigger={
            <IconButton
              size="lg"
              aria-label="Open voice settings"
              className="h-control-lg w-control-lg flex-none rounded-full bg-surface-container-highest text-on-surface hover:bg-state-hover"
            >
              <Icon name="settings" size="sm" />
            </IconButton>
          }
          label="Voice settings"
          description="Choose your microphone, speakers, camera, and talk mode."
          side="top"
          align="center"
          className="w-72 p-3"
        >
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-body-sm text-on-surface-variant">
              Talk mode
              <select
                value={inputMode}
                onChange={(event) =>
                  setInputMode(event.target.value as 'voice-activity' | 'push-to-talk')
                }
                className="h-control-md rounded-full border border-outline bg-surface-container-lowest px-2 text-body-sm text-on-surface outline-none focus:border-primary"
              >
                <option value="voice-activity">Voice activity</option>
                <option value="push-to-talk">Push to talk</option>
              </select>
            </label>

            <div className="h-px bg-outline-variant" aria-hidden="true" />

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
            <DeviceSelect
              label="Camera"
              value={cameraDeviceId}
              devices={cameras}
              unavailableLabel="System default camera"
              onChange={(deviceId) => void changeDevice('camera', deviceId)}
            />

            <fieldset className="space-y-2">
              <legend className="text-body-sm font-semibold text-on-surface">Audio cleanup</legend>
              <p className="text-body-sm text-on-surface-variant">Changes restart your microphone briefly.</p>
              <AudioProcessingToggle
                label="Echo cancellation"
                checked={audioProcessing.echoCancellation}
                disabled={pendingProcessing !== null}
                onChange={() => void changeAudioProcessing('echoCancellation')}
              />
              <AudioProcessingToggle
                label="Noise suppression"
                checked={audioProcessing.noiseSuppression}
                disabled={pendingProcessing !== null}
                onChange={() => void changeAudioProcessing('noiseSuppression')}
              />
              <AudioProcessingToggle
                label="Automatic input level"
                checked={audioProcessing.autoGainControl}
                disabled={pendingProcessing !== null}
                onChange={() => void changeAudioProcessing('autoGainControl')}
              />
            </fieldset>

            <div className="space-y-1">
              <span className="text-body-sm text-on-surface-variant">Input level</span>
              <div
                className="h-1 overflow-hidden rounded-full bg-state-pressed"
                role="meter"
                aria-label="Microphone input level"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(localAudioLevel * 100)}
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-100"
                  data-design-token-exception="Live microphone level determines meter width."
                  style={{ width: `${Math.max(2, localAudioLevel * 100)}%` }}
                />
              </div>
            </div>

            {inputMode === 'push-to-talk' && (
              <p className="text-body-sm text-on-surface-variant">Hold Space while this view is focused to talk.</p>
            )}
          </div>
        </Popover>

        <div className="mx-1 h-10 w-px flex-none bg-outline-variant" aria-hidden="true" />

        <button
          type="button"
          onClick={onOpenMessages}
          className="flex h-control-lg w-control-lg flex-none items-center justify-center rounded-full bg-surface-container-highest text-on-surface transition-colors hover:bg-state-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          aria-label={`Open messages from ${roomName}`}
        >
          <Icon name="messageCircle" />
        </button>

        <Tooltip content={`Leave ${roomName}`} side="top">
          <motion.button
            whileHover={{ scale: motionScales.hover }}
            whileTap={{ scale: motionScales.press }}
            disabled={leaving}
            onClick={onLeave}
            aria-label={`Leave ${roomName}`}
            /*
              The one control in the toolbar that keeps its word, because it is
              the single action here that pressing again does not undo. It is
              the tonal error container rather than the full-strength coral:
              the loudest red in the palette is reserved for a failure, and
              hanging up is a choice rather than one.
            */
            className="flex min-h-control-lg flex-none items-center justify-center gap-2.5 rounded-full bg-error-container px-6 text-label-lg text-on-error-container transition-colors hover:bg-error-container-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60"
          >
            <Icon name="phoneOff" />
            <span>{leaving ? 'Leaving' : 'Leave'}</span>
          </motion.button>
        </Tooltip>
      </div>

      {controlError && (
        <p className="text-body-sm text-error" role="alert">
          {controlError}
        </p>
      )}
    </motion.div>
  )
}

function AudioProcessingToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  onChange: () => void
}) {
  return (
    <label className="flex min-h-9 items-center justify-between gap-3 text-body-sm text-on-surface">
      {label}
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="h-4 w-4 accent-primary"
      />
    </label>
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
    <label className="flex min-w-0 flex-col gap-1 text-body-sm text-on-surface-variant">
      {label}
      <select
        value={value ?? ''}
        disabled={devices.length === 0}
        onChange={(event) => onChange(event.target.value)}
        className="h-control-md min-w-0 rounded-full border border-outline bg-surface-container-lowest px-2 text-body-sm text-on-surface outline-none focus:border-primary disabled:opacity-60"
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
