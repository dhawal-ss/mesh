export const MESH_APP_VERSION = '0.2.0'
export const MESH_RELEASE_CHANNEL = 'beta'
export const MESH_DOWNLOAD_URL = 'https://mesh.dhawal.org/download/'
export const MESH_PRIVACY_URL = 'https://mesh.dhawal.org/privacy/'
export const MESH_FEEDBACK_URL = 'https://github.com/dhawal-ss/mesh/issues/new'

export const MAX_BETA_FEEDBACK_LENGTH = 1_200

/*
 * The only known issue that describes a feature rather than this build. A build
 * without calling must not warn about calling, so the beta page filters this
 * one entry out instead of the list carrying a permanent untruth.
 */
export const BETA_CALLING_KNOWN_ISSUE =
  'Private calling stays off until Mesh can confirm it is protected.'

/*
 * What this build does not do.
 *
 * A "Known issues" list sitting next to a Send feedback button is read as
 * complete, which makes it a trust surface: every gap a person meets in the
 * first session and does not find here reads as something Mesh did not know
 * about. The list below therefore names the limits a beta user actually hits,
 * not only the three that describe the packaging.
 *
 * Entries are limits of this build, not a bug backlog. Anything already fixed
 * must be removed rather than left to age into a second untruth.
 *
 * That rule needs enforcing on a schedule, not on inspiration: six of these
 * eleven entries had gone partly false by 2026-08-17, each one because the
 * work that closed the gap did not come back to the sentence describing it.
 * A half-true entry is worse than a missing one, because the true half makes
 * the false half read as checked. Re-read this list against the code whenever
 * a slice closes anything it names.
 */
export const BETA_KNOWN_ISSUES = [
  BETA_CALLING_KNOWN_ISSUE,
  'Automatic updates are not included. Install new signed versions from the official download page.',
  'Mesh runs on Windows, macOS, and Linux. Mobile platforms are not yet supported.',
  'Mesh blocks screen capture on Windows and macOS. Linux cannot block capture.',
  'Rooms cannot have their own image. Only communities can, and rooms use their name instead.',
  'Rooms that need their own invitation are not listed.',
  'You cannot report a message to community moderators. It goes to your account service.',
  'The thread list shows only threads you started, replied to, or joined.',
  'Search covers recent messages only, and it says what it searched.',
  'Code blocks are not colored.',
  'Mesh cannot tell you when a newer version exists. Check the download page.',
] as const

export type BetaFeedbackKind = 'bug' | 'confusing' | 'idea'

export interface BetaFeedbackContext {
  area: 'Home' | 'Community channel' | 'Direct messages'
  callActive: boolean
  platform: 'Windows' | 'macOS' | 'Linux' | 'Mobile' | 'Unknown'
}

export interface BetaFeedbackDraft {
  title: string
  report: string
  issueUrl: string
}

const FEEDBACK_KIND_LABELS: Record<BetaFeedbackKind, string> = {
  bug: 'Something went wrong',
  confusing: 'Something was confusing',
  idea: 'I have an idea',
}

export function detectFeedbackPlatform(userAgent: string): BetaFeedbackContext['platform'] {
  if (/Windows/u.test(userAgent)) return 'Windows'
  if (/Android|iPhone|iPad|Mobile/u.test(userAgent)) return 'Mobile'
  if (/Macintosh|Mac OS X/u.test(userAgent)) return 'macOS'
  if (/Linux/u.test(userAgent)) return 'Linux'
  return 'Unknown'
}

export function createBetaFeedbackDraft({
  kind,
  details,
  context,
  capturedAt = new Date(),
}: {
  kind: BetaFeedbackKind
  details: string
  context: BetaFeedbackContext
  capturedAt?: Date
}): BetaFeedbackDraft {
  const normalizedDetails = details.trim().slice(0, MAX_BETA_FEEDBACK_LENGTH)
  const label = FEEDBACK_KIND_LABELS[kind]
  const summary = normalizedDetails.split(/\r?\n/u)[0]?.slice(0, 72) || label
  const title = `[Mesh beta] ${label}: ${summary}`
  const report = [
    'Mesh beta feedback',
    '',
    `Type: ${label}`,
    '',
    'What happened or what should change:',
    normalizedDetails || 'No details were entered.',
    '',
    'App context:',
    `- Version: ${MESH_APP_VERSION} ${MESH_RELEASE_CHANNEL}`,
    `- Platform: ${context.platform}`,
    `- Area: ${context.area}`,
    `- Call active: ${context.callActive ? 'Yes' : 'No'}`,
    `- Captured: ${capturedAt.toISOString()}`,
    '',
    'Privacy:',
    'Mesh added no account address, room name, message content, invitation, file path, or recovery information.',
  ].join('\n')
  const query = new URLSearchParams({ title, body: report })
  return {
    title,
    report,
    issueUrl: `${MESH_FEEDBACK_URL}?${query.toString()}`,
  }
}
