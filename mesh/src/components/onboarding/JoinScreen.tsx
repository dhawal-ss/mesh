import { useMemo, useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import clsx from 'clsx'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { transitions } from '../../lib/motion'
import { DEFAULT_AVATAR_COLORS } from './types'
import type { OnboardingFlowProps, OnboardingProfile } from './types'

interface ProfileScreenProps {
  onNext?: (profile: OnboardingProfile) => Promise<void> | void
  onBack?: () => void
  avatarColors?: OnboardingFlowProps['avatarColors']
  initialProfile?: OnboardingFlowProps['initialProfile']
}

export function JoinScreen({
  onNext,
  onBack,
  avatarColors = DEFAULT_AVATAR_COLORS,
  initialProfile,
}: ProfileScreenProps) {
  const palette = useMemo(() => Array.from(avatarColors), [avatarColors])
  const [displayName, setDisplayName] = useState(initialProfile?.displayName ?? '')
  const [avatarColor, setAvatarColor] = useState(
    initialProfile?.avatarColor ?? palette[0] ?? DEFAULT_AVATAR_COLORS[0]
  )
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const profile = {
      displayName: displayName.trim(),
      avatarColor,
    }

    if (!profile.displayName) return

    setIsSaving(true)
    setError('')

    try {
      await onNext?.(profile)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save profile')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form className="space-y-8" onSubmit={handleSubmit}>
      <div className="space-y-2">
        <p className="text-2xs uppercase tracking-[0.35em] text-muted">Step 2 of 3</p>
        <h1 className="text-[clamp(2rem,4vw,2.6rem)] font-semibold tracking-tight text-primary">
          Set your profile
        </h1>
        <p className="max-w-sm text-sm leading-6 text-secondary">
          Choose the name and color people will see first. You can change both later.
        </p>
      </div>

      <motion.div
        className="space-y-6 rounded-lg bg-bg-primary p-5"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.softSpring}
      >
        <div className="flex items-center gap-4">
          <Avatar color={avatarColor} size={72} name={displayName || 'Me'} />
          <div className="space-y-1">
            <p className="text-sm font-medium text-primary">{displayName || 'Your name'}</p>
            <p className="text-2xs uppercase tracking-[0.3em] text-muted">Local profile</p>
          </div>
        </div>

        <Input
          label="Display name"
          placeholder="What should people call you?"
          value={displayName}
          onChange={(value: string) => setDisplayName(value)}
          autoFocus
          maxLength={32}
        />

        <div className="space-y-3">
          <label className="text-2xs uppercase tracking-[0.35em] text-muted">Avatar color</label>
          <div className="grid grid-cols-5 gap-2">
            {palette.map((color) => {
              const selected = avatarColor === color
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => setAvatarColor(color)}
                  className={clsx(
                    'h-10 rounded-full border-2 transition-transform duration-150',
                    selected
                      ? 'border-blue ring-2 ring-blue/30'
                      : 'border-transparent hover:scale-[1.03] hover:border-border'
                  )}
                  style={{ backgroundColor: color }}
                  aria-label={`Select avatar color ${color}`}
                />
              )
            })}
          </div>
        </div>
      </motion.div>

      {error && <p className="text-sm text-red">⚠ {error}</p>}

      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={!displayName.trim() || isSaving}>
          {isSaving ? 'Saving...' : 'Continue'}
        </Button>
      </div>
    </form>
  )
}
