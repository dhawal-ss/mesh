import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Button, type ButtonVariant, type UiTone } from '../ui/Button'
import { Input } from '../ui/Input'
import { Avatar } from '../ui/Avatar'
import { ErrorState } from '../ui/ErrorState'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Modal } from '../ui/Modal'
import {
  Badge,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Kbd,
  Progress,
  Radio,
  ScrollArea,
  Separator,
  Slider,
  Textarea,
} from '../ui/Primitives'
import {
  Combobox,
  Command,
  ContextMenu,
  DropdownMenu,
  Popover,
  Select,
  Sheet,
  Switch,
  Tabs,
} from '../ui/InteractivePrimitives'
import { Skeleton } from '../ui/Skeleton'
import { showToast } from '../ui/Toast'
import { Tooltip } from '../ui/Tooltip'
import { transitions } from '../../lib/motion'
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference'

const TONES: UiTone[] = ['neutral', 'accent', 'success', 'danger', 'warning']
const BUTTON_VARIANTS: ButtonVariant[] = ['solid', 'soft', 'outline', 'ghost']
const THEMES = ['dark', 'light', 'high-contrast'] as const
const ACCENTS = ['sand', 'ocean', 'violet', 'forest', 'ember', 'rose'] as const
const OPTIONS = [
  { value: 'default', label: 'Cozy' },
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
]

export function KitchenSink() {
  const reduceMotion = useReducedMotionPreference()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [density, setDensity] = useState('default')
  const [accent, setAccent] = useState<(typeof ACCENTS)[number]>('sand')

  useEffect(() => {
    document.documentElement.dataset.accent = accent
    return () => {
      delete document.documentElement.dataset.accent
    }
  }, [accent])

  useEffect(() => {
    document.documentElement.dataset.density = density
    return () => {
      delete document.documentElement.dataset.density
    }
  }, [density])

  return (
    <ScrollArea className="h-screen bg-surface-sunken p-6 text-content">
      <motion.div
        aria-hidden="true"
        data-ambient-motion-probe
        data-reduced-motion={reduceMotion ? 'true' : 'false'}
        className="pointer-events-none fixed left-0 top-0 h-px w-px"
        animate={{ x: reduceMotion ? 0 : [0, 24] }}
        transition={reduceMotion ? transitions.reduced : transitions.ambientLoop}
      />
      <header className="mx-auto mb-8 max-w-6xl">
        <Badge tone="accent">Development only</Badge>
        <h1 className="mt-3 text-lg font-semibold">Mesh design-system kitchen sink</h1>
        <p className="mt-1 text-sm text-content-secondary">
          Semantic primitives rendered across every supported theme.
        </p>
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Accent presets">
          {ACCENTS.map((preset) => (
            <Button
              key={preset}
              size="sm"
              variant={accent === preset ? 'solid' : 'outline'}
              tone="accent"
              aria-pressed={accent === preset}
              onClick={() => setAccent(preset)}
            >
              {preset}
            </Button>
          ))}
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6">
        {THEMES.map((theme) => (
          <PrimitiveTheme key={theme} theme={theme} />
        ))}

        <Card className="space-y-5 p-5" variant="raised">
          <h2 className="text-base font-semibold">Interactive overlays</h2>
          <div className="flex flex-wrap gap-2">
            <Button tone="accent" onClick={() => setDialogOpen(true)}>Open dialog</Button>
            <Button variant="outline" onClick={() => setSheetOpen(true)}>Open sheet</Button>
            <Button variant="soft" onClick={() => setCommandOpen(true)}>
              Commands <Kbd>Ctrl K</Kbd>
            </Button>
            <DropdownMenu
              label="Example actions"
              trigger={<Button variant="ghost">Menu</Button>}
              items={[
                { id: 'rename', label: 'Rename' },
                { id: 'remove', label: 'Remove', tone: 'danger' },
              ]}
            />
            <Popover trigger={<Button variant="ghost">Popover</Button>}>
              <p className="text-sm text-content-secondary">
                Popovers inherit semantic overlay and focus tokens.
              </p>
            </Popover>
            <Tooltip content="Keyboard and pointer accessible">
              <IconButton aria-label="Show information"><Icon name="activity" size="sm" /></IconButton>
            </Tooltip>
          </div>
          <ContextMenu
            label="Card actions"
            items={[
              { id: 'copy', label: 'Copy' },
              { id: 'delete', label: 'Delete', tone: 'danger' },
            ]}
          >
            <div className="rounded-md border border-dashed border-border p-4 text-sm text-content-muted">
              Right-click this region to test the context menu.
            </div>
          </ContextMenu>
          <div className="grid gap-4 md:grid-cols-2">
            <Select
              label="Density"
              value={density}
              onValueChange={setDensity}
              options={OPTIONS}
            />
            <Combobox
              label="Find a density"
              value={density}
              onValueChange={setDensity}
              options={OPTIONS}
            />
          </div>
          <Tabs
            label="Example sections"
            items={[
              { value: 'overview', label: 'Overview', content: <p className="text-sm text-content-secondary">Overview content</p> },
              { value: 'details', label: 'Details', content: <p className="text-sm text-content-secondary">Detail content</p> },
            ]}
          />
        </Card>

        <Modal
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title="Accessible dialog"
          description="Focus is trapped and restored by Radix."
        >
          <Button tone="accent" onClick={() => setDialogOpen(false)}>Done</Button>
        </Modal>
        <Sheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          title="Responsive sheet"
          description="Use sheets for narrow navigation and settings."
        >
          <p className="text-sm text-content-secondary">Sheet content remains independently scrollable.</p>
        </Sheet>
        <Command
          open={commandOpen}
          onOpenChange={setCommandOpen}
          options={[
            { value: 'new-message', label: 'New message' },
            { value: 'settings', label: 'Open settings' },
          ]}
          onSelect={(value) => showToast(`Selected ${value}`, 'success')}
        />
      </main>
    </ScrollArea>
  )
}

function PrimitiveTheme({ theme }: { theme: typeof THEMES[number] }) {
  return (
    <section data-theme={theme} className="rounded-xl border border-border-subtle bg-surface-base p-5">
      <div className="mb-5 flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold capitalize">{theme.replace('-', ' ')}</h2>
        <Badge>{theme}</Badge>
      </div>

      <div className="space-y-6">
        <div className="space-y-3">
          <h3 className="text-xs font-medium uppercase text-content-muted">Buttons</h3>
          {BUTTON_VARIANTS.map((variant) => (
            <div key={variant} className="flex flex-wrap gap-2">
              {TONES.map((tone) => (
                <Button key={`${variant}-${tone}`} variant={variant} tone={tone} size="sm">
                  {tone}
                </Button>
              ))}
            </div>
          ))}
        </div>

        <Separator />

        <div className="grid gap-4 md:grid-cols-2">
          <Input label="Display name" placeholder="Your name" hint="Shown to people you chat with." />
          <Field label="About" htmlFor={`about-${theme}`} hint="A short profile note.">
            <Textarea id={`about-${theme}`} placeholder="Write a short note…" />
          </Field>
          <Switch label="Notifications" description="Show desktop notifications." defaultChecked />
          <Slider label="Message size" valueLabel="15 px" defaultValue={50} />
          <Checkbox label="Compact mode" description="Reduce spacing between messages." />
          <div className="space-y-2">
            <Radio name={`density-${theme}`} label="Cozy" defaultChecked />
            <Radio name={`density-${theme}`} label="Compact" />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {TONES.map((tone) => <Badge key={tone} tone={tone}>{tone}</Badge>)}
          <Avatar name="Mesh User" color="var(--accent)" />
          <Skeleton width={96} height={14} />
        </div>

        <Progress value={68} label="Upload progress" showValue />

        <div className="grid gap-4 md:grid-cols-2">
          <Card variant="outline" className="p-4">
            <EmptyState
              title="Nothing here yet"
              description="Create the first item to see it appear here."
              action={<Button size="sm" tone="accent">Create</Button>}
            />
          </Card>
          <ErrorState
            error={{ code: 'network_unavailable', detail: 'Preview connection unavailable', retryable: true }}
            context={{ operation: 'load this preview' }}
            onAction={() => showToast('Retry requested', 'info')}
          />
        </div>
      </div>
    </section>
  )
}
