export const DEFAULT_AVATAR_COLORS = [
  '#c8b89a',
  '#60a5fa',
  '#4ade80',
  '#f87171',
  '#a78bfa',
  '#fb923c',
  '#f472b6',
  '#34d399',
  '#facc15',
  '#38bdf8',
] as const

export type OnboardingProfile = {
  displayName: string
  avatarColor: string
}

export type BootstrapState = {
  phase: 'connecting' | 'syncing' | 'finalizing' | 'ready'
  label: string
  progress: number
}

export interface OnboardingFlowProps {
  onComplete: () => void
  onGenerateIdentity?: () => Promise<void>
  onUpdateProfile?: (profile: OnboardingProfile) => Promise<void>
  onBootstrap?: (update: (state: BootstrapState) => void) => Promise<void>
  initialProfile?: Partial<OnboardingProfile>
  avatarColors?: readonly string[]
}
