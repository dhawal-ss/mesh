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
    label: 'You join a party',
    description: 'Confirms after your voice connection is ready.',
    previewLabel: 'Preview you-join-party sound',
  },
  {
    id: 'voice-self-leave',
    label: 'You leave a party',
    description: 'Confirms after your local voice session has ended.',
    previewLabel: 'Preview you-leave-party sound',
  },
  {
    id: 'voice-peer-join',
    label: 'Someone joins your party',
    description: 'Coalesces busy arrival bursts so your crew never becomes an audio storm.',
    previewLabel: 'Preview party-join sound',
  },
  {
    id: 'voice-peer-leave',
    label: 'Someone leaves your party',
    description: 'Uses a short, quieter departure step.',
    previewLabel: 'Preview party-leave sound',
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
    description: 'Plays once for a newly confirmed failed-send batch.',
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
