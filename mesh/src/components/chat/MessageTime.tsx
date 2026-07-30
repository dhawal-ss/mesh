import { formatClockTime, formatFullTime, isoTimestamp } from '../../lib/message-time'

interface MessageTimeProps {
  value: unknown
  /** 'clock' is the grouped-row gutter; 'full' is the header line. */
  variant?: 'clock' | 'full'
  className?: string
}

/**
 * A timestamp that assistive technology and the clipboard can actually read.
 * Previously the timeline rendered bare strings with no `datetime`, so the only
 * machine-readable time in the app was in community settings.
 */
export function MessageTime({ value, variant = 'clock', className }: MessageTimeProps) {
  const iso = isoTimestamp(value)
  const display = variant === 'clock' ? formatClockTime(value) : formatFullTime(value)
  const absolute = formatFullTime(value)

  return (
    <time className={className} dateTime={iso} title={absolute}>
      {display}
    </time>
  )
}
