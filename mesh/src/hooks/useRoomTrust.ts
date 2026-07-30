import { useEffect, useMemo, useState } from 'react'
import * as bridge from '../lib/bridge'

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

function initialSnapshot(
  matrixMode: boolean,
  communityMemberCount: number,
): RoomTrustSnapshot {
  const status = bridge.getBackendStatusSnapshot()
  const homeService = serviceName(status?.homeserver)
  return {
    matrixMode,
    protection: matrixMode ? 'checking' : 'unavailable',
    communityMemberCount,
    services: homeService ? [{ name: homeService, memberCount: 0 }] : [],
    devices: [],
    devicesNeedReview: 0,
    verifiedDevices: 0,
    backup: null,
    accountId: status?.userId ?? (matrixMode ? bridge.getMatrixUserId() : null),
    homeService,
    syncRunning: status?.syncRunning ?? false,
    loadingAccountTrust: matrixMode,
  }
}

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
  const [loaded, setLoaded] = useState<{
    roomId: string | null
    snapshot: RoomTrustSnapshot
  }>(() => ({
    roomId: roomId ?? null,
    snapshot: initialSnapshot(matrixMode, members.length),
  }))

  useEffect(() => {
    if (!matrixMode || !roomId) return

    let active = true
    let loadGeneration = 0

    const load = async () => {
      const generation = ++loadGeneration
      const status = await bridge.getBackendStatus().catch(() => bridge.getBackendStatusSnapshot())
      const protectionResult = await bridge.matrixRoomIsEncrypted(roomId).then(
        (encrypted): RoomProtectionState => encrypted ? 'protected' : 'unencrypted',
        (): RoomProtectionState => 'unavailable',
      )

      let devices: bridge.MatrixDevice[] = []
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
      const homeService = serviceName(status?.homeserver)
      const devicesNeedReview = devices.filter(
        (device) => !device.verified || device.newDevice || device.identityChanged,
      ).length
      setLoaded({
        roomId,
        snapshot: {
          matrixMode: true,
          protection: protectionResult,
          communityMemberCount: stableMembers.length,
          services: servicesForMembers(stableMembers, homeService),
          devices,
          devicesNeedReview,
          verifiedDevices: Math.max(0, devices.length - devicesNeedReview),
          backup,
          accountId: status?.userId ?? bridge.getMatrixUserId(),
          homeService,
          syncRunning: status?.syncRunning ?? false,
          loadingAccountTrust: false,
        },
      })
    }

    void load()
    const refreshTrust = () => {
      void load()
    }
    const stopTrustSubscription = bridge.onMatrixTrustChanged(refreshTrust)
    window.addEventListener('focus', refreshTrust)
    return () => {
      active = false
      stopTrustSubscription()
      window.removeEventListener('focus', refreshTrust)
    }
  }, [matrixMode, memberIds, roomId, stableMembers])

  if (loaded.roomId !== (roomId ?? null)) {
    return initialSnapshot(matrixMode, members.length)
  }
  return loaded.snapshot
}
