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
      title="Channels and roles"
      description="Changes your sidebar only, not who can find or join a room."
      side="right"
      size="md"
      closeLabel="Close channels and roles"
    >
      <fieldset className="space-y-2">
        <legend className="text-body-md font-semibold text-on-surface">Your sidebar</legend>
        {channels.map((channel) => (
          <label
            key={channel.id}
            className="flex min-h-11 items-start gap-3 rounded-full bg-surface-container-high px-3 py-2"
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
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
              <span className="block text-body-md font-medium text-on-surface">{channel.label}</span>
              <span className="block text-body-sm text-on-surface-variant">{channel.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <section className="mt-5" aria-labelledby="answer-roles-heading">
        <h3 id="answer-roles-heading" className="text-body-md font-semibold text-on-surface">
          Roles from your answers
        </h3>
        {selection.roleTemplateIds.length === 0 ? (
          <p className="mt-2 text-body-sm text-on-surface-variant">Answer the questions above to add suggested roles.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-body-md text-on-surface-variant">
            {selection.roleTemplateIds.map((roleId) => (
              <li key={roleId}>{roleLabels[roleId] ?? 'Community role'}</li>
            ))}
          </ul>
        )}
      </section>

      {error && <p role="alert" className="mt-4 text-body-md text-error">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save choices'}
        </Button>
      </div>
    </Sheet>
  )
}
