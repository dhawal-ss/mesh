import { useMemo, useState, type FormEvent } from 'react'
import { motion } from '../../lib/lazy-motion'
import clsx from 'clsx'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Icon } from '../ui/Icon'
import { PixelMark } from '../ui/PixelMark'
import { motionOffsets, transitions } from '../../lib/motion'
import { describeError } from '../../lib/errors'
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
      console.error('Unable to save profile:', cause)
      const description = describeError(cause, { operation: 'save your profile' })
      // `body` already opens with what failed, so prefixing the title repeated
      // the same thing in a shorter sentence first.
      setError(description.body)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form className="space-y-8" onSubmit={handleSubmit}>
      <div className="space-y-2">
        <p className="text-label-sm font-semibold lowercase tracking-label-md text-on-surface-variant">Step 2 of 3</p>
        <h1 className="text-headline-md font-semibold text-on-surface">
          Set your profile
        </h1>
      </div>

      <motion.div
        className="space-y-6 rounded-xl border border-outline-variant bg-surface-container-lowest p-5"
        initial={{ opacity: 0, y: motionOffsets.subtle }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.enter}
      >
        <div className="flex items-center gap-4">
          <Avatar color={avatarColor} size={72} name={displayName || 'Me'} />
          <div className="space-y-1">
            <p className="text-body-md font-medium text-on-surface">{displayName || 'Your name'}</p>
            <p className="text-label-sm lowercase tracking-label-md text-on-surface-variant">Local profile</p>
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
          <label className="text-label-sm lowercase tracking-label-md text-on-surface-variant">Default pixel profile</label>
          <div className="grid grid-cols-5 gap-2">
            {palette.map((color) => {
              const selected = avatarColor === color
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => setAvatarColor(color)}
                  className={clsx(
                    'mesh-profile-choice flex h-11 items-center justify-center rounded-full border bg-surface-container-lowest transition-[border-color,transform,box-shadow] duration-fast',
                    selected
                      ? 'border-primary ring-2 ring-primary-container-line'
                      : 'border-outline-variant hover:-translate-y-px hover:border-outline'
                  )}
                  style={{ color }}
                  aria-label={`Select avatar color ${color}`}
                >
                  <PixelMark variant="profile" className="h-9 w-9" />
                </button>
              )
            })}
          </div>
        </div>
      </motion.div>

      {error && (
        <p className="flex items-start gap-2 text-body-md text-error" role="alert">
          <Icon name="triangleAlert" size="sm" className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </p>
      )}

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
