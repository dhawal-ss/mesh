import { useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/InteractivePrimitives'
import type { PersonalCommunitySelection } from '../../lib/community-onboarding'

export interface ChannelsAndRolesChoice {
  id: string
  label: string
  description: string
  selected: boolean
}

export function ChannelsAndRolesPanel({
  open,
  onOpenChange,
  selection,
  channels,
  roleLabels,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selection: PersonalCommunitySelection
  channels: readonly ChannelsAndRolesChoice[]
  roleLabels: Readonly<Record<string, string>>
  onSave: (channelIds: string[]) => Promise<void>
}) {
  const initial = useMemo(() => new Set(selection.channelIds), [selection.channelIds])
  const [selected, setSelected] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave([...selected].sort())
      onOpenChange(false)
    } catch {
      setError('Your channel choices could not be saved. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Channels & Roles"
      description="Choose what appears in your sidebar. This does not change who can find or join a room."
      side="right"
      size="md"
      closeLabel="Close Channels & Roles"
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-primary">Your sidebar</legend>
        {channels.map((channel) => (
          <label
            key={channel.id}
            className="flex min-h-11 items-start gap-3 rounded-control bg-surface-hover px-3 py-2"
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-accent"
              checked={selected.has(channel.id)}
              onChange={(event) => {
                setSelected((current) => {
                  const next = new Set(current)
                  if (event.target.checked) next.add(channel.id)
                  else next.delete(channel.id)
                  return next
                })
              }}
            />
            <span>
              <span className="block text-sm font-medium text-primary">{channel.label}</span>
              <span className="block text-xs leading-5 text-muted">{channel.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <section className="mt-5" aria-labelledby="answer-roles-heading">
        <h3 id="answer-roles-heading" className="text-sm font-semibold text-primary">
          Roles from your answers
        </h3>
        {selection.roleTemplateIds.length === 0 ? (
          <p className="mt-2 text-xs leading-5 text-muted">No roles were added by your answers.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm text-secondary">
            {selection.roleTemplateIds.map((roleId) => (
              <li key={roleId}>{roleLabels[roleId] ?? 'Community role'}</li>
            ))}
          </ul>
        )}
      </section>

      {error && <p role="alert" className="mt-4 text-sm text-status-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save choices'}
        </Button>
      </div>
    </Sheet>
  )
}
