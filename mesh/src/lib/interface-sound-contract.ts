export const INTERFACE_SOUND_IDS = [
  'voice-self-join',
  'voice-self-leave',
  'voice-peer-join',
  'voice-peer-leave',
  'message-mention',
  'message-direct',
  'message-failed',
  'connection-recovered',
] as const

export type InterfaceSoundId = (typeof INTERFACE_SOUND_IDS)[number]

export const INTERFACE_SOUND_SETTINGS = [
  {
    id: 'voice-self-join',
    label: 'You join a call',
    description: 'Plays after your voice connection is ready.',
    previewLabel: 'Preview call joined sound',
  },
  {
    id: 'voice-self-leave',
    label: 'You leave a call',
    description: 'Plays after your voice call has ended.',
    previewLabel: 'Preview call left sound',
  },
  {
    id: 'voice-peer-join',
    label: 'Someone joins your call',
    description: 'Limits repeated sounds when several people join together.',
    previewLabel: 'Preview person joined sound',
  },
  {
    id: 'voice-peer-leave',
    label: 'Someone leaves your call',
    description: 'Uses a short, quieter departure step.',
    previewLabel: 'Preview person left sound',
  },
  {
    id: 'message-mention',
    label: 'Mentions',
    description: 'Stays quiet when the mentioned message is already visible.',
    previewLabel: 'Preview mention sound',
  },
  {
    id: 'message-direct',
    label: 'Direct messages',
    description: 'Stays quiet when that private conversation is already open.',
    previewLabel: 'Preview direct-message sound',
  },
  {
    id: 'message-failed',
    label: 'Message could not send',
    description: 'Plays once when one or more messages fail to send.',
    previewLabel: 'Preview failed-message sound',
  },
  {
    id: 'connection-recovered',
    label: 'Connection recovers',
    description: 'Plays only after a visible disruption lasted at least three seconds.',
    previewLabel: 'Preview connection-recovered sound',
  },
] as const satisfies ReadonlyArray<{
  id: InterfaceSoundId
  label: string
  description: string
  previewLabel: string
}>

export const DEFAULT_INTERFACE_SOUND_EVENTS: Record<InterfaceSoundId, boolean> =
  Object.fromEntries(INTERFACE_SOUND_IDS.map((id) => [id, true])) as Record<
    InterfaceSoundId,
    boolean
  >
