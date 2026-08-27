import { formatClockTime, formatFullTime, isoTimestamp } from '../../lib/message-time'

interface MessageTimeProps {
  value: unknown
  className?: string
}

/**
 * A timestamp that assistive technology and the clipboard can actually read.
 * Previously the timeline rendered bare strings with no `datetime`, so the only
 * machine-readable time in the app was in community settings.
 *
 * There is one form: the clock time, with the absolute in `title` and in
 * `datetime`. The variant switch belonged to a 44px timestamp column that
 * printed a bare hour on every grouped row and revealed it on hover; a bubble
 * carries one metadata line on the first message of a group instead, and the
 * day it belongs to is already the divider above it.
 */
export function MessageTime({ value, className }: MessageTimeProps) {
  return (
    <time className={className} dateTime={isoTimestamp(value)} title={formatFullTime(value)}>
      {formatClockTime(value)}
    </time>
  )
}
