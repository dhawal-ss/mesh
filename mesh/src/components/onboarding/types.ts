export const DEFAULT_AVATAR_COLORS = [
  'var(--avatar-sand)',
  'var(--avatar-blue)',
  'var(--avatar-green)',
  'var(--avatar-red)',
  'var(--avatar-violet)',
  'var(--avatar-orange)',
  'var(--avatar-pink)',
  'var(--avatar-emerald)',
  'var(--avatar-yellow)',
  'var(--avatar-cyan)',
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
  backendKind?: 'matrix' | 'legacy-p2p'
  backendAuthenticated?: boolean
  onMatrixLogin?: (request: {
    homeserver: string
    username: string
    password: string
    deviceName?: string
  }) => Promise<void>
  onMatrixOidcLogin?: (homeserver: string) => Promise<void>
  onMatrixCheckUsernameAvailable?: (username: string) => Promise<boolean>
  onMatrixRegisterAccount?: (
    username: string,
    password: string,
    registrationToken: string,
  ) => Promise<void>
  onMatrixSwitchAccount?: (profileId: string) => Promise<void>
  onCreateBackupCode?: () => Promise<string>
  onBackupConfigured?: () => void
  onBackupSkipped?: () => void
  onGenerateIdentity?: () => Promise<void>
  onUpdateProfile?: (profile: OnboardingProfile) => Promise<void>
  onBootstrap?: (update: (state: BootstrapState) => void) => Promise<void>
  initialMatrixInvitation?: string
  initialProfile?: Partial<OnboardingProfile>
  avatarColors?: readonly string[]
}
