import { useCallback, useEffect, useMemo, useState } from 'react'
import * as bridge from '../lib/bridge'
import { useNetworkStore } from '../store/network'

/**
 * 'unencrypted' was previously called 'blocked' and surfaced as "Sending
 * blocked", which was untrue: nothing gates the composer on trust state. The
 * state describes the room, not a restriction Mesh actually enforces.
 */
export type RoomProtectionState = 'checking' | 'protected' | 'unencrypted' | 'unavailable'

export interface TrustMember {
  publicKey: string
}

export interface ServicePresence {
  name: string
  memberCount: number
}

export interface RoomTrustSnapshot {
  matrixMode: boolean
  protection: RoomProtectionState
  communityMemberCount: number
  services: ServicePresence[]
  devices: bridge.MatrixDevice[]
  devicesNeedReview: number
  verifiedDevices: number
  backup: bridge.MatrixRecoveryHealth | null
  accountId: string | null
  homeService: string | null
  syncRunning: boolean
  loadingAccountTrust: boolean
  /**
   * Runs the room protection probe again.
   *
   * The probe genuinely fails on a cold start: the native side answers NotFound
   * while the room is not yet in the local store, which is exactly the moment
   * someone opens a room from an invitation or launches offline. Without a way
   * back, that single rejection left the composer disabled for the lifetime of
   * the room view.
   */
  recheckProtection: () => void
}

function serviceName(value: string | null | undefined) {
  if (!value) return null

  const accountSeparator = value.indexOf(':')
  if (value.startsWith('@') && accountSeparator > 0) {
    return value.slice(accountSeparator + 1).trim() || null
  }

  try {
    return new URL(value).host || null
  } catch {
    return value
      .replace(/^[a-z]+:\/\//i, '')
      .split('/')[0]
      .trim() || null
  }
}

function servicesForMembers(
  members: TrustMember[],
  homeService: string | null,
): ServicePresence[] {
  const counts = new Map<string, number>()
  for (const member of members) {
    const service = serviceName(member.publicKey)
    if (!service) continue
    counts.set(service, (counts.get(service) ?? 0) + 1)
  }
  if (homeService && !counts.has(homeService)) counts.set(homeService, 0)

  return [...counts.entries()]
    .map(([name, memberCount]) => ({ name, memberCount }))
    .sort((left, right) => (
      right.memberCount - left.memberCount || left.name.localeCompare(right.name)
    ))
}

/**
 * Account-wide trust. It does not depend on which room is open, so it is
 * loaded once and refreshed on trust-change events, not on every room switch
 * and not on every window focus.
 */
interface AccountTrust {
  status: bridge.BackendStatus | null
  devices: bridge.MatrixDevice[]
  backup: bridge.MatrixRecoveryHealth | null
  loaded: boolean
}

interface RoomProtection {
  roomId: string | null
  state: RoomProtectionState
}

const NO_DEVICES: bridge.MatrixDevice[] = []

export function useRoomTrust(
  roomId: string | null | undefined,
  members: TrustMember[],
): RoomTrustSnapshot {
  const matrixMode = bridge.isMatrixBackend()
  const memberIds = useMemo(
    () => members.map((member) => member.publicKey).sort().join('\u0000'),
    [members],
  )
  const stableMembers = useMemo(
    () => memberIds
      ? memberIds.split('\u0000').map((publicKey) => ({ publicKey }))
      : [],
    [memberIds],
  )
  const [accountTrust, setAccountTrust] = useState<AccountTrust>(() => ({
    status: bridge.getBackendStatusSnapshot(),
    devices: NO_DEVICES,
    backup: null,
    loaded: false,
  }))
  const [roomProtection, setRoomProtection] = useState<RoomProtection>(() => ({
    roomId: roomId ?? null,
    state: matrixMode ? 'checking' : 'unavailable',
  }))

  // Account-scoped work: one load per session, refreshed when device trust
  // actually changes. It used to re-run for every room the person opened, and
  // again on every window focus, for results that cannot differ per room.
  useEffect(() => {
    if (!matrixMode) return

    let active = true
    let loadGeneration = 0

    const load = async () => {
      const generation = ++loadGeneration
      const status = await bridge.getBackendStatus().catch(() => bridge.getBackendStatusSnapshot())

      let devices: bridge.MatrixDevice[] = NO_DEVICES
      let backup: bridge.MatrixRecoveryHealth | null = null
      if (status?.authenticated) {
        const [deviceResult, backupResult] = await Promise.allSettled([
          status.capabilities.deviceManagement ? bridge.matrixDevices() : Promise.resolve([]),
          status.capabilities.recovery ? bridge.matrixRecoveryHealth() : Promise.resolve(null),
        ])
        if (deviceResult.status === 'fulfilled') devices = deviceResult.value
        if (backupResult.status === 'fulfilled') backup = backupResult.value
      }

      if (!active || generation !== loadGeneration) return
      setAccountTrust({ status, devices, backup, loaded: true })
    }

    void load()
    const refreshTrust = () => {
      void load()
    }
    const stopTrustSubscription = bridge.onMatrixTrustChanged(refreshTrust)
    return () => {
      active = false
      stopTrustSubscription()
    }
  }, [matrixMode])

  /*
    Bumping this re-runs the room probe. It is driven by three things: the person
    pressing "Check again", device trust changing, and the link coming back
    online. The last two matter because the probe's usual failure is a room that
    has not synced yet, which resolves itself moments later without any event
    that used to reach this hook.
  */
  const [protectionProbe, setProtectionProbe] = useState(0)
  const recheckProtection = useCallback(() => {
    setProtectionProbe((probe) => probe + 1)
  }, [])

  // Room-scoped work, running in parallel with the account load above rather
  // than queued behind it.
  useEffect(() => {
    if (!matrixMode || !roomId) return

    let active = true
    // Re-probing should say so, otherwise "Check again" looks inert when the
    // answer does not change.
    setRoomProtection((current) => (
      current.roomId === roomId && current.state === 'checking'
        ? current
        : { roomId, state: 'checking' }
    ))
    void bridge.matrixRoomIsEncrypted(roomId).then(
      (encrypted): RoomProtectionState => encrypted ? 'protected' : 'unencrypted',
      (): RoomProtectionState => 'unavailable',
    ).then((state) => {
      if (active) setRoomProtection({ roomId, state })
    })
    return () => {
      active = false
    }
  }, [matrixMode, roomId, protectionProbe])

  const linkPhase = useNetworkStore((state) => state.matrixLink?.phase ?? null)
  const probeFailed = roomProtection.roomId === (roomId ?? null)
    && roomProtection.state === 'unavailable'

  /*
    A failed probe is usually a room Mesh has not synced yet, so retry when the
    client's picture of the world changes rather than leaving the composer dead.
    Only retry from 'unavailable': 'unencrypted' is a settled answer about the
    room, not a failure.
  */
  useEffect(() => {
    if (!matrixMode || !roomId || !probeFailed) return
    return bridge.onMatrixTrustChanged(() => recheckProtection())
  }, [matrixMode, roomId, probeFailed, recheckProtection])

  // The link reaching 'online' is the moment the room most likely arrived.
  useEffect(() => {
    if (!matrixMode || !roomId || !probeFailed) return
    if (linkPhase !== 'online') return
    recheckProtection()
  }, [matrixMode, roomId, probeFailed, linkPhase, recheckProtection])

  // One memoized snapshot. This is passed to every message row, so returning a
  // freshly built object per render re-rendered the whole timeline while a
  // room switch settled.
  return useMemo<RoomTrustSnapshot>(() => {
    const status = accountTrust.status
    const homeService = serviceName(status?.homeserver)
    const devicesNeedReview = accountTrust.devices.filter(
      (device) => !device.verified || device.newDevice || device.identityChanged,
    ).length
    return {
      matrixMode,
      protection: !matrixMode
        ? 'unavailable'
        : roomProtection.roomId === (roomId ?? null)
          ? roomProtection.state
          : 'checking',
      communityMemberCount: stableMembers.length,
      services: servicesForMembers(stableMembers, homeService),
      devices: accountTrust.devices,
      devicesNeedReview,
      verifiedDevices: Math.max(0, accountTrust.devices.length - devicesNeedReview),
      backup: accountTrust.backup,
      accountId: status?.userId ?? (matrixMode ? bridge.getMatrixUserId() : null),
      homeService,
      syncRunning: status?.syncRunning ?? false,
      loadingAccountTrust: matrixMode && !accountTrust.loaded,
      recheckProtection,
    }
  }, [accountTrust, matrixMode, recheckProtection, roomId, roomProtection, stableMembers])
}
