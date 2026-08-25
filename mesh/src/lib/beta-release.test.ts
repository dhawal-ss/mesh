import { describe, expect, it } from 'vitest'
import appPackage from '../../package.json'
import {
  BETA_KNOWN_ISSUES,
  createBetaFeedbackDraft,
  detectFeedbackPlatform,
  MAX_BETA_FEEDBACK_LENGTH,
  MESH_APP_VERSION,
} from './beta-release'

describe('beta release surface', () => {
  it('uses the build version and keeps known issues actionable', () => {
    expect(MESH_APP_VERSION).toBe(appPackage.version)
    expect(BETA_KNOWN_ISSUES.join(' ')).toContain('official download page')
  })

  it('discloses the limits a beta user meets in the first session', () => {
    /*
      The list used to carry three entries, all about packaging: calling, no
      auto-update, Windows-only. Sitting beside a Send feedback button, a list
      that short reads as "this is everything Mesh knows about", which makes
      every unlisted gap look like a surprise to the team as well as the user.
    */
    const text = BETA_KNOWN_ISSUES.join(' ')
    expect(BETA_KNOWN_ISSUES.length).toBeGreaterThanOrEqual(10)
    // contentProtected is release-gated and blanks Mesh in OBS, Discord and
    // Snipping Tool. Undisclosed, it also stops a beta user screenshotting the
    // bug they are filing through this very panel.
    expect(text).toContain('screen capture')
    /*
      And it only does that on two of the three platforms Mesh ships. tao
      documents content protection as unsupported on Linux and compiles the
      call only for macOS and Windows, so claiming Mesh blanks in a recorder
      would tell a Linux user they are protected when they are not. That is the
      one direction this list must never be wrong in.
    */
    expect(text).toContain('Linux cannot block capture')
    /*
      This asserted 'Profile pictures' while they could be neither set nor
      seen, then 'Community icons cannot be set' for the one turn between the
      two slices. Both are settable and visible now, and rooms are the half
      still missing: the writer is room-generic, but no per-room surface exists
      to offer the control from.
    */
    expect(text).toContain('Rooms cannot have their own image')
    expect(text).not.toContain('Profile pictures')
    expect(text).not.toContain('Community icons cannot be set')
    expect(text).toContain('report a message to community moderators')
    expect(text).toContain('newer version')
  })

  it('states each entry as a limit rather than a promise or an apology', () => {
    for (const issue of BETA_KNOWN_ISSUES) {
      expect(issue.endsWith('.')).toBe(true)
      expect(issue).not.toMatch(/(soon|coming|we will|sorry|unfortunately)/i)
    }
  })

  it('detects broad platform context without collecting a device identifier', () => {
    expect(detectFeedbackPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows')
    expect(detectFeedbackPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux')
    expect(detectFeedbackPlatform('custom client')).toBe('Unknown')
  })

  it('builds a bounded portable report without conversation identifiers', () => {
    const draft = createBetaFeedbackDraft({
      kind: 'confusing',
      details: `The next action was unclear. ${'x'.repeat(MAX_BETA_FEEDBACK_LENGTH * 2)}`,
      context: { area: 'Community channel', callActive: false, platform: 'Windows' },
      capturedAt: new Date('2026-08-09T12:00:00.000Z'),
    })

    expect(draft.report).toContain('Version: 0.2.0 beta')
    expect(draft.report).toContain('Area: Community channel')
    expect(draft.report).toContain('added no account address')
    expect(draft.report).not.toContain('!room:')
    expect(draft.issueUrl).toMatch(/^https:\/\/github\.com\/dhawal-ss\/mesh\/issues\/new\?/)
    expect(new URL(draft.issueUrl).searchParams.get('body')).toBe(draft.report)
  })
})
