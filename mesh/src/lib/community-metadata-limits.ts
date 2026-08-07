export const COMMUNITY_NAME_MAX_LENGTH = 100
export const COMMUNITY_DESCRIPTION_MAX_LENGTH = 500
export const CHANNEL_NAME_MAX_LENGTH = 100
export const CHANNEL_TOPIC_MAX_LENGTH = 500

export function metadataCharactersRemaining(value: string, maxLength: number): string {
  return `${Math.max(0, maxLength - value.length)} characters remaining.`
}

export function metadataLengthError(
  label: string,
  value: string,
  maxLength: number,
): string | undefined {
  if (value.length <= maxLength) return undefined
  return `${label} must be ${maxLength} characters or fewer.`
}
