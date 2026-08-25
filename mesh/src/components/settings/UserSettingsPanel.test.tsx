import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ONBOARDING_STEP_IDS } from '../../lib/onboarding-checklist'
import { useIdentityStore } from '../../store/identity'
import { useOnboardingChecklistStore } from '../../store/onboarding-checklist'
import { useSettingsStore } from '../../store/settings'
import { useRoomOrganizationStore } from '../../store/room-organization'
import * as bridge from '../../lib/bridge'
import { UserSettingsPanel } from './UserSettingsPanel'
import { DEFAULT_INTERFACE_SOUND_EVENTS } from '../../lib/interface-sound-contract'
import { BETA_CALLING_KNOWN_ISSUE } from '../../lib/beta-release'

const interfaceSoundMocks = vi.hoisted(() => ({
  play: vi.fn(() => Promise.resolve(true)),
}))

/*
 * The panel must ask the shared voice gate rather than decide for itself which
 * builds have calling. `voice-runtime.test.ts` owns whether the gate is right;
 * these tests own whether the panel obeys it. The default matches production
 * today, where no verified Matrix call service is reachable.
 */
const voiceRuntimeMocks = vi.hoisted(() => ({
  shouldExposeVoiceRoutes: vi.fn(() => false),
}))

vi.mock('../../lib/voice-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/voice-runtime')>()),
  shouldExposeVoiceRoutes: voiceRuntimeMocks.shouldExposeVoiceRoutes,
}))

vi.mock('../../lib/interface-sounds', () => ({
  playInterfaceSound: interfaceSoundMocks.play,
}))

vi.mock('./SecurityDevicesPanel', () => ({
  SecurityDevicesPanel: ({ embedded, onClose }: { embedded?: boolean; onClose: () => void }) => (
    <section aria-label="Inline safety and devices">
      <span>{embedded ? 'Embedded device controls' : 'Device controls'}</span>
      <button type="button" onClick={onClose}>Close devices</button>
    </section>
  ),
}))

async function openSettingsTab(label: string) {
  let tab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (button) => button.getAttribute('aria-label') === label,
  )
  if (tab) {
    await act(async () => tab?.click())
    return
  }

  const back = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === 'Back to account',
  )
  if (back) await act(async () => back.click())

  tab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    // The visible label carries a positional row number now, so a tab is
    // identified by its accessible name rather than by its raw text.
    (button) => button.getAttribute('aria-label') === 'Account',
  )
  if (tab?.getAttribute('aria-selected') !== 'true') {
    await act(async () => tab?.click())
  }
  const nested = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim().startsWith(label),
  )
  expect(nested).toBeDefined()
  await act(async () => nested?.click())
}

describe('UserSettingsPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    interfaceSoundMocks.play.mockClear()
    voiceRuntimeMocks.shouldExposeVoiceRoutes.mockReturnValue(false)
    useSettingsStore.setState((state) => ({
      notifications: {
        ...state.notifications,
        enabled: true,
        sound: true,
        soundId: 'mesh',
        soundVolume: 0.6,
        soundEvents: { ...DEFAULT_INTERFACE_SOUND_EVENTS },
        showMessageContent: false,
        doNotDisturb: false,
        quietHours: {
          enabled: false,
          start: '22:00',
          end: '08:00',
        },
        mutedChannels: [],
        mutedCommunities: [],
        channelMuteUntil: {},
        communityMuteUntil: {},
        channelNotificationLevels: {},
      },
    }))
    useSettingsStore.getState().setAppearanceTheme('dark')
    useSettingsStore.getState().setAppearanceDensity('default')
    useSettingsStore.getState().setAppearanceAccent('sand')
    useSettingsStore.getState().setReduceMotion(false)
    useSettingsStore.setState({
      privacy: {
        readReceiptMode: 'public',
        sendTypingIndicators: true,
        conversationPrivacy: {},
        sharePresence: true,
        invisibleMode: false,
      },
      matrixPreferenceSync: { status: 'idle', error: null },
      signalCheckEnabled: false,
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  /*
    Two slots beside your own name held the words "Your Mesh" and "Mesh
    account", both true of every account that has ever opened this pane. The
    address would have distinguished them, and it is exactly what must not go
    here: the Account section keeps it behind "Show account address" precisely
    so it stays out of anything permanently on screen. So the slots go instead.
  */
  it('drops the constant beside your name without substituting the address', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
        />,
      )
    })

    // The persistent identity card beside the tabs.
    expect(document.body.textContent).toContain('Alice')
    expect(document.body.textContent).not.toContain('Your Mesh')
    expect(document.body.textContent).not.toContain('@alice:example.org')

    // And the Profile pane, which named the account rather than showing one.
    await openSettingsTab('Profile')
    expect(document.body.textContent).toContain('Alice')
    expect(document.body.textContent).not.toContain('Mesh account')
    expect(document.body.textContent).not.toContain('@alice:example.org')
  })

  it('implements roving keyboard tabs with complete panel relationships', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
        />,
      )
    })

    const tabs = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    // The visible label carries a positional row number, so the tab's identity
    // is its accessible name.
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Account',
      'Notifications',
      'Appearance',
    ])
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1)
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls')
      expect(panelId).toBeTruthy()
      expect(document.getElementById(panelId!)).not.toBeNull()
    }

    /*
     * Appearance is the last tab once calling is out of the build, so the wrap
     * has to land on the first tab. The original of this test wrapped onto
     * Audio and video; the intent it protects is that arrow keys never leave
     * the roving tabstop pointing at a tab that is not rendered.
     */
    const appearance = tabs.find((tab) => tab.getAttribute('aria-label') === 'Appearance')!
    const account = tabs.find((tab) => tab.getAttribute('aria-label') === 'Account')!
    await act(async () => {
      appearance.focus()
      appearance.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(account.getAttribute('aria-selected')).toBe('true')
    expect(account.tabIndex).toBe(0)
    expect(document.activeElement).toBe(account)

    await act(async () => {
      account.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(appearance.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(appearance)

    await act(async () => {
      appearance.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(account.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(account)
  })

  it('keeps the Audio and video destination out of a build that cannot open a call', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          activeSection="audio-video"
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
        />,
      )
    })

    const tabs = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).not.toContain('Audio and video')
    // A destination that disappeared must fall back to a visible one, never a blank pane.
    expect(document.body.textContent).not.toContain('Call privacy')
    expect(document.body.textContent).toContain('Current account service')
    expect(
      tabs.find((tab) => tab.getAttribute('aria-label') === 'Account')?.getAttribute('aria-selected'),
    ).toBe('true')
  })

  it('gives every appearance choice a focus ring on the label that is actually drawn', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
        />,
      )
    })

    for (const group of ['appearance-theme', 'appearance-density', 'appearance-accent']) {
      const options = Array.from(
        document.body.querySelectorAll<HTMLInputElement>(`input[name="${group}"]`),
      )
      expect(options.length).toBeGreaterThan(1)
      for (const option of options) {
        // The input is visually hidden, so focus is only findable on the label.
        expect(option.className).toContain('sr-only')
        const label = option.closest('label')
        expect(label?.className).toContain('has-[input:focus-visible]:outline-2')
        expect(label?.className).toContain('has-[input:focus-visible]:outline-focus')
      }
    }
    expect(
      Array.from(document.body.querySelectorAll('label'))
        .some((label) => label.textContent?.trim() === 'High contrast'),
    ).toBe(true)
  })

  it('drops the calling known issue from a beta build that has no calling', async () => {
    const betaPanel = () => (
      <UserSettingsPanel
        open
        activeSection="beta"
        onClose={() => {}}
        identity={{
          publicKey: '@alice:example.org',
          displayName: 'Alice',
          avatarColor: '#52b5f4',
        }}
        matrixAccountId="@alice:example.org"
        matrixMode
        onOpenSecurity={() => {}}
      />
    )
    await act(async () => root.render(betaPanel()))

    expect(document.body.textContent).toContain('Known issues')
    expect(document.body.textContent).not.toContain(BETA_CALLING_KNOWN_ISSUE)
    expect(document.body.textContent).toContain('Automatic updates are not included')

    // The entry is gated, not deleted: a build with calling still warns about it.
    voiceRuntimeMocks.shouldExposeVoiceRoutes.mockReturnValue(true)
    await act(async () => root.render(betaPanel()))
    expect(document.body.textContent).toContain(BETA_CALLING_KNOWN_ISSUE)
  })

  it('renders route-owned You content without nesting a settings dialog', async () => {
    const openSecurity = vi.fn()
    await act(async () => {
      root.render(
        <UserSettingsPanel
          embedded
          open
          activeSection="account"
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:accounts.example"
          matrixMode
          onOpenSecurity={openSecurity}
        />,
      )
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.querySelector('[role="tablist"]')).toBeNull()
    expect(document.body.querySelector('[role="tabpanel"]')).toBeNull()
    expect(document.body.textContent).toContain('Current account service')
    expect(document.body.textContent).toContain('accounts.example')
    // The sentence explaining what an account service is has been cut; the
    // service name and the address reveal below are the functional parts.
    expect(document.body.textContent).not.toContain('kept independently from Mesh')
    expect(document.body.textContent).not.toContain('@alice:accounts.example')
    const reveal = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Show account address'),
    )
    await act(async () => reveal?.click())
    expect(document.body.textContent).toContain('@alice:accounts.example')
    const useAnotherService = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Use another service'),
    )
    expect(useAnotherService?.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      useAnotherService?.click()
      await import('./SecurityDevicesPanel')
      await Promise.resolve()
    })
    expect(openSecurity).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Embedded device controls')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows the authenticated Matrix account and opens security controls', async () => {
    const openSecurity = vi.fn()
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={openSecurity}
        />,
      )
    })

    await openSettingsTab('Profile')
    expect(document.body.textContent).toContain('alice')
    // The address stays behind the reveal in the Account section; the pane no
    // longer names the account in its place either.
    expect(document.body.textContent).not.toContain('Mesh account')
    expect(document.body.textContent).not.toContain('@alice:example.org')
    await openSettingsTab('Safety and devices')
    const securityButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Open your devices'),
    )
    expect(securityButton).toBeDefined()
    expect(document.body.textContent).toContain('Your devices')
    expect(document.body.textContent).not.toContain('Security & Devices')
    await act(async () => securityButton?.click())
    expect(openSecurity).toHaveBeenCalledOnce()
  })

  /*
    Call privacy copy used to be asserted from the Audio and video tab, which
    this build no longer offers. The copy itself is unchanged, so it is checked
    where that destination is still reachable.
  */
  it('keeps the call privacy explanation on the Audio and video destination', async () => {
    voiceRuntimeMocks.shouldExposeVoiceRoutes.mockReturnValue(true)
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          activeSection="audio-video"
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
        />,
      )
    })

    expect(
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .map((tab) => tab.getAttribute('aria-label')),
    ).toContain('Audio and video')
    expect(document.body.textContent).toContain('Call privacy')
    expect(document.body.textContent).toContain('microphone, speakers, and camera')
    expect(document.body.textContent).toContain(
      'The service can see who connects, internet addresses, call timing, and traffic volume.',
    )
    expect(document.body.textContent).toContain(
      'your microphone, camera, and incoming media stay off',
    )
  })

  it('keeps interface-sound controls independent from desktop notifications', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
        />,
      )
    })

    await openSettingsTab('Notifications')
    const checkboxes = document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(13)
    expect(checkboxes[0]?.checked).toBe(true)
    expect(checkboxes[1]?.disabled).toBe(false)

    await act(async () => checkboxes[0]?.click())

    expect(useSettingsStore.getState().notifications.enabled).toBe(false)
    expect(
      document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.disabled,
    ).toBe(false)
    expect(useSettingsStore.getState().notifications.sound).toBe(true)
  })

  it('explains service visibility and updates every privacy control', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          activeConversationId="!room:example.org"
          activeConversationName="General"
          onOpenSecurity={() => {}}
        />,
      )
    })

    await openSettingsTab('Privacy')
    expect(document.body.textContent).toContain('Privacy center')
    expect(document.body.textContent).toContain('What your service can see')
    expect(document.body.textContent).toContain('Message and file content')
    expect(document.body.textContent).toContain('Network address')
    // The table above states what the service can and cannot see, so the
    // block below it keeps only the operational-detail disclosure.
    expect(document.body.textContent).toContain(
      'internet addresses, devices, membership, and timing',
    )
    expect(document.body.textContent).not.toContain('Unlike standard Discord messages')

    const toggle = (label: string) =>
      Array.from(document.body.querySelectorAll('label'))
        .find((candidate) => candidate.textContent?.includes(label))
        ?.querySelector<HTMLInputElement>('input[type="checkbox"]')

    const readReceipts = document.querySelector<HTMLSelectElement>('#read-receipts')
    expect(document.querySelector('label[for="read-receipts"]')?.textContent).toBe('Read receipts')
    expect(readReceipts?.getAttribute('aria-describedby')).toBe('read-receipts-description')
    expect(document.querySelector('#read-receipts-description')?.textContent).toContain(
      'people in a conversation',
    )
    await act(async () => {
      if (readReceipts) readReceipts.value = 'private'
      readReceipts?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => toggle('Show when I am typing')?.click())
    await act(async () => toggle('Share my online status')?.click())
    await act(async () => toggle('Invisible mode')?.click())

    expect(useSettingsStore.getState().privacy).toEqual({
      readReceiptMode: 'private',
      sendTypingIndicators: false,
      conversationPrivacy: {},
      sharePresence: false,
      invisibleMode: true,
    })
    expect(document.body.textContent).toContain('No, disabled now')

    const conversationReceipts = document.querySelector<HTMLSelectElement>(
      '#conversation-read-receipts',
    )
    const conversationTyping = document.querySelector<HTMLSelectElement>('#conversation-typing')
    expect(document.body.textContent).toContain('This conversation: General')
    expect(document.body.textContent).toContain('Other compatible apps may publish')
    await act(async () => {
      if (conversationReceipts) conversationReceipts.value = 'public'
      conversationReceipts?.dispatchEvent(new Event('change', { bubbles: true }))
      if (conversationTyping) conversationTyping.value = 'on'
      conversationTyping?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useSettingsStore.getState().privacy.conversationPrivacy).toEqual({
      '!room:example.org': {
        readReceiptMode: 'public',
        sendTypingIndicators: true,
      },
    })
  })

  it('shows when privacy settings are not confirmed and offers a retry', async () => {
    useSettingsStore.setState({
      matrixPreferenceSync: {
        status: 'failed',
        error: new Error('offline'),
      },
    })
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
        />,
      )
    })

    await openSettingsTab('Privacy')
    expect(document.body.textContent).toContain('could not confirm them on your account')
    expect(
      Array.from(document.body.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Retry saving privacy settings'),
      ),
    ).toBe(true)
  })

  it('configures sound, DND, quiet hours, and sends a test notification', async () => {
    const onTestNotification = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
          onTestNotification={onTestNotification}
        />,
      )
    })

    await openSettingsTab('Notifications')
    expect(document.body.querySelector('#notification-sound')).toBeNull()
    const volume = document.body.querySelector<HTMLInputElement>('#interface-sound-volume')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(volume, '35')
      volume?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useSettingsStore.getState().notifications.soundVolume).toBe(0.35)

    const directPreview = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview direct-message sound"]',
    )
    const directToggle = directPreview?.parentElement?.parentElement?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    await act(async () => directToggle?.click())
    expect(useSettingsStore.getState().notifications.soundEvents['message-direct']).toBe(false)
    await act(async () => directPreview?.click())
    expect(interfaceSoundMocks.play).toHaveBeenCalledWith('message-direct', {
      preview: true,
      masterVolume: 0.35,
    })
    expect(useSettingsStore.getState().notifications.soundEvents['message-direct']).toBe(false)

    const previewToggle = Array.from(
      document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    )[10]
    expect(document.body.textContent).toContain('lock screens, mirrored displays')
    await act(async () => previewToggle?.click())
    expect(useSettingsStore.getState().notifications.showMessageContent).toBe(true)

    const checkboxes = document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    await act(async () => checkboxes[11]?.click())
    expect(useSettingsStore.getState().notifications.doNotDisturb).toBe(true)

    await act(async () => checkboxes[12]?.click())
    expect(document.body.querySelector('#quiet-hours-start')).not.toBeNull()
    const start = document.body.querySelector<HTMLInputElement>('#quiet-hours-start')
    const end = document.body.querySelector<HTMLInputElement>('#quiet-hours-end')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(start, '21:30')
      start?.dispatchEvent(new Event('input', { bubbles: true }))
      setValue?.call(end, '07:15')
      end?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useSettingsStore.getState().notifications.quietHours).toEqual({
      enabled: true,
      start: '21:30',
      end: '07:15',
    })

    const testButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Test notification'),
    )
    await act(async () => {
      testButton?.click()
      await Promise.resolve()
    })
    expect(onTestNotification).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
      'Test notification sent',
    )
  })

  it('says the operating system is blocking notifications without waiting to be tested', async () => {
    // The reactive path only teaches you this if you happen to press Test. The
    // switch reads as on the whole time while every notification is dropped, so
    // opening the tab has to ask the OS rather than trust Mesh's own setting.
    vi.spyOn(bridge, 'isTauriRuntime').mockReturnValue(true)
    const permission = vi.spyOn(bridge, 'notificationPermissionState')
      .mockResolvedValue('denied')

    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          activeSection="notifications"
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
          onTestNotification={vi.fn()}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(permission).toHaveBeenCalled()
    const blocked = document.body.querySelector('[role="alert"]')?.textContent ?? ''
    expect(blocked).toContain('Windows is blocking notifications for Mesh')
    // The switch still reports the user's own choice. Mesh does not silently
    // flip a setting the user made because the OS disagrees with it.
    expect(useSettingsStore.getState().notifications.enabled).toBe(true)
  })

  it('leaves the notice alone when the operating system has not been asked yet', async () => {
    vi.spyOn(bridge, 'isTauriRuntime').mockReturnValue(true)
    vi.spyOn(bridge, 'notificationPermissionState').mockResolvedValue('not-requested')

    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          activeSection="notifications"
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
          onTestNotification={vi.fn()}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    // Never asked is not denied, and warning about it would be a nag on a tab
    // the user opened to read.
    expect(document.body.textContent).not.toContain('Windows is blocking notifications')
  })

  it('names the operating system when it blocks the test notification', async () => {
    // The shape the backend actually rejects with when the OS denies notifications.
    const onTestNotification = vi.fn().mockRejectedValue({
      code: 'permission_denied',
      detail: 'notification permission was not granted',
    })
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          activeSection="notifications"
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
          onTestNotification={onTestNotification}
        />,
      )
    })

    const testButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Test notification'),
    )
    await act(async () => {
      testButton?.click()
      await Promise.resolve()
    })

    const blocked = document.body.querySelector('[role="alert"]')?.textContent ?? ''
    expect(blocked).toContain('Windows is blocking notifications for Mesh')
    expect(blocked).toContain('Windows Settings')
    expect(blocked).not.toContain('permission_denied')
    // The toggle keeps reporting the user's own choice, which is still on.
    expect(useSettingsStore.getState().notifications.enabled).toBe(true)

    // Never a nag: one calm sentence the user can put away.
    const dismiss = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Dismiss',
    )
    expect(dismiss).toBeDefined()
    await act(async () => dismiss?.click())
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps an unexplained test-notification failure honest about what to do next', async () => {
    const onTestNotification = vi.fn().mockRejectedValue(new Error('ipc channel closed'))
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          activeSection="notifications"
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
          onTestNotification={onTestNotification}
        />,
      )
    })

    const testButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Test notification'),
    )
    await act(async () => {
      testButton?.click()
      await Promise.resolve()
    })

    const failed = document.body.querySelector('[role="alert"]')?.textContent ?? ''
    // Only a denied permission may be named as one, so this path must not claim it.
    expect(failed).toContain('Mesh could not send the test notification.')
    expect(failed).not.toContain('Windows is blocking')
    expect(failed).not.toContain('ipc channel closed')
  })

  it('updates appearance preferences and the document theme attributes', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
        />,
      )
    })

    const darkTheme = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-theme"][value="dark"]',
    )
    const highContrastTheme = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-theme"][value="high-contrast"]',
    )
    const cozyDensity = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-density"][value="default"]',
    )
    const compactDensity = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-density"][value="compact"]',
    )
    const sandAccent = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-accent"][value="sand"]',
    )
    const oceanAccent = document.body.querySelector<HTMLInputElement>(
      'input[name="appearance-accent"][value="ocean"]',
    )

    const reduceMotion = Array.from(document.body.querySelectorAll<HTMLLabelElement>('label'))
      .find((label) => label.textContent?.includes('Reduce motion'))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]')

    expect(darkTheme?.checked).toBe(true)
    expect(cozyDensity?.checked).toBe(true)
    expect(sandAccent?.checked).toBe(true)


    await act(async () => {
      highContrastTheme?.click()
      compactDensity?.click()
      oceanAccent?.click()

      reduceMotion?.click()
    })

    expect(useSettingsStore.getState().appearance).toEqual({
      theme: 'high-contrast',
      density: 'compact',
      accent: 'ocean',
      reduceMotion: true,
      textScale: 100,
    })
    expect(document.documentElement.dataset.theme).toBe('high-contrast')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.documentElement.dataset.accent).toBe('ocean')
    expect(document.documentElement.dataset.reduceMotion).toBe('true')
  })

  it('requires a second click before restoring default room order', async () => {
    localStorage.clear()
    useRoomOrganizationStore.getState().resetForAccountTransition()
    useRoomOrganizationStore.getState().initialize('@me:example.org')
    useRoomOrganizationStore.getState().hide('room-noisy')

    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: 'local',
            displayName: 'Local user',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId={null}
          matrixMode={false}
          onOpenSecurity={() => {}}
        />,
      )
    })

    const resetButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent === 'Restore default room order')
    expect(resetButton).toBeTruthy()

    await act(async () => {
      resetButton?.click()
    })
    expect(useRoomOrganizationStore.getState().hidden).toEqual(['room-noisy'])
    expect(resetButton?.textContent).toBe('Click again to restore server order everywhere')

    await act(async () => {
      resetButton?.click()
    })
    expect(useRoomOrganizationStore.getState().hidden).toEqual([])
    expect(resetButton?.textContent).toBe('Restore default room order')
  })

  /*
   * The getting started list removes itself once every step is done, so a live
   * toggle offering to show it again would be a control that cannot do anything.
   * Neither the checklist tests nor this file's other cases join those two
   * halves, which is how this shipped operable and inert for one build.
   */
  it('explains rather than offers the settling in list once every step is done', async () => {
    localStorage.clear()
    useOnboardingChecklistStore.getState().resetForAccountTransition()
    useOnboardingChecklistStore.getState().initialize('@me:example.org')

    async function renderAppearance() {
      await act(async () => {
        root.render(
          <UserSettingsPanel
            open
            onClose={() => {}}
            identity={{
              publicKey: 'local',
              displayName: 'Local user',
              avatarColor: '#52b5f4',
            }}
            matrixAccountId={null}
            matrixMode={false}
            onOpenSecurity={() => {}}
          />,
        )
      })
      return [...document.body.querySelectorAll('label')]
        .find((label) => label.textContent?.includes('Settling in list'))
    }

    const unfinished = await renderAppearance()
    const unfinishedInput = unfinished?.querySelector('input')
    expect(unfinishedInput?.disabled).toBe(false)
    expect(unfinished?.textContent).toContain("Show first steps above a community's rooms")

    await act(async () => {
      useOnboardingChecklistStore.getState().observe([...ONBOARDING_STEP_IDS])
    })

    const finished = await renderAppearance()
    const finishedInput = finished?.querySelector('input')
    expect(finishedInput?.disabled).toBe(true)
    expect(finished?.textContent).toContain('Every first step is done')
  })

  it('saves a trimmed Matrix display name and reports success', async () => {
    const updateDisplayName = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onUpdateDisplayName={updateDisplayName}
          onOpenSecurity={() => {}}
        />,
      )
    })

    await openSettingsTab('Profile')
    const displayNameInput = document.body.querySelector<HTMLInputElement>(
      'input[autocomplete="nickname"]',
    )
    expect(displayNameInput).not.toBeNull()

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(displayNameInput, '  Alice Cooper  ')
      displayNameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save display name'),
    )
    await act(async () => {
      saveButton?.click()
      await Promise.resolve()
    })

    expect(updateDisplayName).toHaveBeenCalledWith('Alice Cooper')
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('Profile updated')
    /*
      This asserted "will not upload one without explaining that first" until
      the uploader shipped and left that sentence contradicting the working
      control above it. The owner then cut the visibility lecture that replaced
      it, so what is pinned now is the constraint a person acts on: the formats
      Mesh accepts and the size it stops at.
    */
    expect(document.body.textContent).toContain('PNG, JPEG or WebP. Up to 1 MB.')
    expect(document.body.textContent).not.toContain('a profile picture is not private')
  })

  it('keeps provider details out of profile errors while preserving the shown identity', async () => {
    const updateDisplayName = vi
      .fn()
      .mockRejectedValue(new Error('Homeserver rejected profile update'))
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onUpdateDisplayName={updateDisplayName}
          onOpenSecurity={() => {}}
        />,
      )
    })

    await openSettingsTab('Profile')
    const displayNameInput = document.body.querySelector<HTMLInputElement>(
      'input[autocomplete="nickname"]',
    )
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(displayNameInput, 'Rejected')
      displayNameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save display name'),
    )
    await act(async () => {
      saveButton?.click()
      await Promise.resolve()
    })

    const alert = document.body.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain("Mesh couldn't update your display name")
    expect(alert).not.toContain('Homeserver rejected profile update')
  })

  it('keeps connection check behind the account settings path', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
          onOpenDiagnostics={() => {}}
        />,
      )
    })

    expect(document.body.textContent).not.toContain('Show connection check')
    await openSettingsTab('Connection check')
    // The section intro repeated the redaction rule stated at the foot of the
    // section. One statement of it is the disclosure; two was a lecture.
    expect(document.body.textContent).toContain(
      'never shows account details, message content, or private local information',
    )
    expect(document.body.textContent).toContain('Show connection check')
  })

  it('uses an explicit connection-check opt-in before diagnostics can open', async () => {
    const openDiagnostics = vi.fn()
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          activeSection="advanced"
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
          onOpenDiagnostics={openDiagnostics}
        />,
      )
    })

    expect(document.body.textContent).toContain('Advanced')
    expect(document.body.textContent).toContain('Show connection check')
    expect(document.body.textContent).not.toContain('Review connection check')
    const toggle = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')
    await act(async () => toggle?.click())
    expect(useSettingsStore.getState().signalCheckEnabled).toBe(true)
    const diagnostics = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Review connection check'),
    )
    await act(async () => diagnostics?.click())
    expect(openDiagnostics).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain('Import older Mesh data')
  })

  it('keeps the backup warning visible in Safety and devices', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
          backupReminderDue
          onOpenDiagnostics={() => {}}
        />,
      )
    })

    await openSettingsTab('Safety and devices')
    expect(document.body.textContent).toContain('Message backup needs attention.')
    expect(
      document.body.querySelector('[aria-label="Message backup needs attention"]'),
    ).not.toBeNull()
  })

  it('replaces the embedded devices introduction with the open security ledger', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          activeSection="devices"
          embedded
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
          onOpenDiagnostics={() => {}}
        />,
      )
    })

    const openDevices = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Open your devices',
    )
    expect(openDevices).toBeDefined()

    await act(async () => openDevices?.click())
    expect(document.body.textContent).toContain('Embedded device controls')
    expect(document.body.textContent).not.toContain('Open your devices')

    const closeDevices = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Close devices',
    )
    await act(async () => closeDevices?.click())
    expect(document.body.textContent).toContain('Open your devices')
  })

  /*
    The panel used to carry no heading element at all: every section label was
    a `<p>` at 14px, so the largest surface in the app had no document outline
    and nothing above the body step for the eye to land on. The dialog title
    owns the one 22px step, each group owns 18px, and sub-groups stay on the
    11px eyebrow.
  */
  it('gives every settings group a real heading on the 18px step', async () => {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
        />,
      )
    })

    for (const label of ['Account', 'Notifications', 'Appearance'] as const) {
      await openSettingsTab(label)
      const group = Array.from(document.body.querySelectorAll('h3')).find(
        (candidate) => candidate.textContent?.trim() === label,
      )
      expect(group).toBeDefined()
      expect(group?.className).toContain('text-md')
    }

    // Only the dialog title may use the 22px route step.
    const titles = Array.from(document.body.querySelectorAll('[class*="text-title"]'))
    expect(titles).toHaveLength(1)
    expect(titles[0]?.textContent).toBe('User settings')

    await openSettingsTab('Notifications')
    const eyebrow = Array.from(
      document.body.querySelectorAll('[role="heading"][aria-level="4"]'),
    ).find((candidate) => candidate.textContent === 'Interface sound events')
    expect(eyebrow).toBeDefined()
  })
})

describe('UserSettingsPanel profile picture', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    // jsdom has no object-URL implementation.
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:avatar'),
      revokeObjectURL: vi.fn(),
    }))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function renderProfile() {
    await act(async () => {
      root.render(
        <UserSettingsPanel
          open
          onClose={() => {}}
          identity={{
            publicKey: '@alice:example.org',
            displayName: 'Alice',
            avatarColor: '#52b5f4',
          }}
          matrixAccountId="@alice:example.org"
          matrixMode
          onOpenSecurity={() => {}}
        />,
      )
    })
    await openSettingsTab('Profile')
  }

  it('uploads a chosen picture through the native writer', async () => {
    /*
      There was no writer at all: update_profile_display_name was the only
      profile write in the codebase, so this field could only ever be non-null
      if the person had set an avatar from a different Matrix client.
    */
    const update = vi.spyOn(bridge, 'matrixUpdateProfileAvatar').mockResolvedValue({
      userId: '@alice:example.org',
      displayName: 'Alice',
      avatarUrl: 'mxc://example.org/abc',
    })
    const load = vi.spyOn(bridge, 'matrixLoadProfileAvatar')
      .mockResolvedValue(new Uint8Array([1, 2, 3]))

    await renderProfile()

    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    expect(input?.getAttribute('accept')).toBe('image/png,image/jpeg,image/webp')

    const file = new File([new Uint8Array([9, 9])], 'me.png', { type: 'image/png' })
    Object.defineProperty(input!, 'files', { value: [file], configurable: true })
    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })

    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][0]).toBe('me.png')
    expect(update.mock.calls[0][1]).toBe('image/png')
    // The mxc address comes back and is resolved to bytes over IPC, because the
    // renderer content security policy permits no outbound connection.
    expect(load).toHaveBeenCalledWith('mxc://example.org/abc')
    /*
      And into the identity store, which is where the user panel, home, the call
      dock and this account's own message rows read their picture from. This
      panel used to keep the new address to itself, so a picture appeared on the
      settings screen and nowhere else until the next launch.
    */
    expect(useIdentityStore.getState().identity?.avatarUrl).toBe('mxc://example.org/abc')
  })

  it('clears a picture through the native writer', async () => {
    const clear = vi.spyOn(bridge, 'matrixClearProfileAvatar').mockResolvedValue({
      userId: '@alice:example.org',
      displayName: 'Alice',
      avatarUrl: null,
    })

    await renderProfile()
    const remove = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Remove')
    // Only offered when there is something to remove.
    expect(remove).toBeUndefined()
    expect(clear).not.toHaveBeenCalled()
  })
})
