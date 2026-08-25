import { useEffect, useRef, useState } from 'react'
import type { Message } from '../types/ipc'
import { playInterfaceSound } from '../lib/interface-sounds'

type FailedMessageAnnouncement = {
  generation: number
  text: string
}

function failureKey(message: Message): string {
  return message.transactionId ?? message.clientRequestId ?? message.id
}

function failedKeys(messages: Message[]): Set<string> {
  return new Set(
    messages
      .filter((message) => message.deliveryStatus === 'failed')
      .map(failureKey),
  )
}

/**
 * Announces only a newly confirmed failed batch. Virtualized remounts and an
 * already-failed row present when a conversation opens remain silent. A retry
 * that leaves failed state may announce again only if it later fails again.
 */
export function useFailedMessageAnnouncement(
  scopeId: string,
  messages: Message[],
): FailedMessageAnnouncement {
  const scopeRef = useRef(scopeId)
  const seenFailuresRef = useRef(failedKeys(messages))
  const [announcement, setAnnouncement] = useState<FailedMessageAnnouncement>({
    generation: 0,
    text: '',
  })

  useEffect(() => {
    const currentFailures = failedKeys(messages)
    if (scopeRef.current !== scopeId) {
      scopeRef.current = scopeId
      seenFailuresRef.current = currentFailures
      setAnnouncement((current) => ({ generation: current.generation + 1, text: '' }))
      return
    }

    for (const seenKey of seenFailuresRef.current) {
      if (!currentFailures.has(seenKey)) seenFailuresRef.current.delete(seenKey)
    }

    const hasNewFailure = [...currentFailures].some((key) => {
      if (seenFailuresRef.current.has(key)) return false
      seenFailuresRef.current.add(key)
      return true
    })

    if (!hasNewFailure) return
    setAnnouncement((current) => ({
      generation: current.generation + 1,
      text: 'Message could not send.',
    }))
    void playInterfaceSound('message-failed')
  }, [messages, scopeId])

  return announcement
}
