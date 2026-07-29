import { useState } from 'react'
import { Input } from '../ui/Input'
import { Button } from '../ui/Button'
import * as bridge from '../../lib/bridge'

export function AudioSettings() {
  const [customTurn, setCustomTurn] = useState('')
  const [customUsername, setCustomUsername] = useState('')
  const [customCredential, setCustomCredential] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const saveCustomTurn = async () => {
    if (!customTurn.trim()) return
    setSaving(true)
    setSaved(false)
    try {
      const servers: bridge.IceServerConfig[] = [
        // Always include default STUN
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        // User-provided TURN server
        {
          urls: [customTurn.trim()],
          username: customUsername.trim() || undefined,
          credential: customCredential.trim() || undefined,
        },
      ]
      // Store via bridge (invokes set_kv on backend)
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('set_kv', { key: 'ice_servers', value: JSON.stringify(servers) })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Failed to save custom TURN server:', err)
    }
    setSaving(false)
  }

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-primary mb-2">Voice Servers</h3>
      <p className="text-xs text-muted mb-3">
        Add custom TURN servers if voice connections fail behind strict firewalls.
      </p>
      <div className="space-y-3 rounded-panel border border-border-subtle bg-surface-sunken p-4">
        <Input
          placeholder="turn:your-server.com:3478"
          value={customTurn}
          onChange={setCustomTurn}
          label="TURN Server URL"
        />
        <Input
          placeholder="username (optional)"
          value={customUsername}
          onChange={setCustomUsername}
          label="Username"
        />
        <Input
          placeholder="credential (optional)"
          value={customCredential}
          onChange={setCustomCredential}
          label="Credential"
          type="password"
        />
        <Button
          size="sm"
          className="mt-2"
          onClick={saveCustomTurn}
          disabled={!customTurn.trim() || saving}
        >
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
