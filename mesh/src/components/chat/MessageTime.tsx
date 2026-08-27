import { formatFullTime, isoTimestamp } from '../../lib/message-time'

interface MessageTimeProps {
  value: unknown
  className?: string
}

/**
 * A timestamp that assistive technology and the clipboard can actually read.
 * Previously the timeline rendered bare strings with no `datetime`, so the only
 * machine-readable time in the app was in community settings.
 *
 * There is one form. The `clock` variant belonged to a 44px timestamp column
 * that printed a bare hour on every grouped row and revealed it on hover; a
 * bubble carries one metadata line on the first message of a group instead, so
 * the only time on screen is the one that says which day it was.
 */
export function MessageTime({ value, className }: MessageTimeProps) {
  const absolute = formatFullTime(value)

  return (
    <time className={className} dateTime={isoTimestamp(value)} title={absolute}>
      {absolute}
    </time>
  )
}
