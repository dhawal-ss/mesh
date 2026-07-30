import { federatedTimestampMilliseconds } from './federated-time'
import { isSameDay } from './message-time'

export interface GroupableMessage {
  authorPublicKey: string
  timestamp: string
  replyToId?: string | null
  deliveryStatus?: 'sent' | 'pending' | 'failed' | null
}

/**
 * Keep message grouping identical in channels and direct conversations.
 * Replies and delivery-state changes start a new visual thought, while the
 * same-day check prevents a group from silently crossing a date boundary.
 */
export function shouldGroupMessage(
  message: GroupableMessage,
  previous?: GroupableMessage,
): boolean {
  if (!previous) return false
  if (message.authorPublicKey !== previous.authorPublicKey) return false
  if (message.replyToId) return false
  if (previous.deliveryStatus && previous.deliveryStatus !== 'sent') return false
  if (!isSameDay(message.timestamp, previous.timestamp)) return false

  const timestamp = federatedTimestampMilliseconds(message.timestamp)
  const previousTimestamp = federatedTimestampMilliseconds(previous.timestamp)
  if (timestamp === null || previousTimestamp === null) return false
  return timestamp - previousTimestamp < 5 * 60 * 1000
}
