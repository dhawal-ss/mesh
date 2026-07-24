import { useState, useEffect } from 'react'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { Avatar } from '../ui/Avatar'
import * as bridge from '../../lib/bridge'

interface DiscoveryCommunity {
  id: string
  name: string
  description: string
  memberCount: number
  ownerDisplayName: string
}

interface ServerDiscoveryProps {
  open: boolean
  onClose: () => void
}

export function ServerDiscovery({ open, onClose }: ServerDiscoveryProps) {
  const [communities, setCommunities] = useState<DiscoveryCommunity[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    bridge.discoverPublicCommunities()
      .then(setCommunities)
      .catch(() => setCommunities([]))
      .finally(() => setLoading(false))
  }, [open])

  return (
    <Modal title="Discover Communities" open={open} onClose={onClose}>
      <div className="p-4 min-h-[300px]">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner />
          </div>
        ) : communities.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted text-sm">
              No public communities found on the network yet.
            </p>
            <p className="text-muted text-xs mt-2">
              Communities become discoverable when their owners publish them to the DHT.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {communities.map((c) => (
              <div key={c.id} className="flex items-center gap-3 p-3 rounded-lg bg-bg-primary hover:bg-bg-tertiary transition-colors">
                <Avatar name={c.name} size={40} color="#5865f2" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-primary">{c.name}</div>
                  <div className="text-xs text-muted truncate">{c.description || 'No description'}</div>
                  <div className="text-xs text-muted mt-0.5">{c.memberCount} members</div>
                </div>
                <button className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 transition-colors">
                  Join
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
