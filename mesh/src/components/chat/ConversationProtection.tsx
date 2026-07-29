import { useCallback, useEffect, useRef, useState } from 'react'
import * as bridge from '../../lib/bridge'
import { Icon } from '../ui/Icon'

type ProtectionState = 'checking' | 'protected' | 'blocked' | 'unavailable'

export function ConversationProtection({ roomId }: { roomId: string }) {
  const [state, setState] = useState<ProtectionState>('checking')
  const requestId = useRef(0)

  const checkProtection = useCallback(async () => {
    const currentRequest = ++requestId.current
    setState('checking')
    try {
      const encrypted = await bridge.matrixRoomIsEncrypted(roomId)
      if (requestId.current === currentRequest) {
        setState(encrypted ? 'protected' : 'blocked')
      }
    } catch {
      if (requestId.current === currentRequest) setState('unavailable')
    }
  }, [roomId])

  useEffect(() => {
    void checkProtection()
    return () => {
      requestId.current += 1
    }
  }, [checkProtection])

  if (state === 'checking') {
    return (
      <span
        className="flex items-center gap-1 font-mono text-meta text-content-muted"
        role="status"
        aria-live="polite"
      >
        <Icon name="loader" size="xs" className="animate-spin" />
        Checking protection
      </span>
    )
  }

  if (state === 'protected') {
    return (
      <span
        className="flex items-center gap-1 font-mono text-meta text-status-success"
        role="status"
        aria-label="This conversation is protected end to end"
      >
        <Icon name="lock" size="xs" />
        Protected end to end
      </span>
    )
  }

  return (
    <span
      className="flex items-center gap-1 font-mono text-meta text-status-warning"
      role="alert"
    >
      <Icon name="triangleAlert" size="xs" />
      {state === 'blocked' ? 'Sending blocked: not protected' : 'Protection check unavailable'}
      {state === 'unavailable' && (
        <button
          type="button"
          className="ml-1 rounded underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => void checkProtection()}
        >
          Retry
        </button>
      )}
    </span>
  )
}
