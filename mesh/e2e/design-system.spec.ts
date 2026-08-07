import { expect, test, type Page } from '@playwright/test'
import { expectNoWcagViolations } from './helpers/accessibility'

const runtimeErrors = new WeakMap<Page, string[]>()

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  )
}

async function samplePartyResponseMotion(page: Page): Promise<string[]> {
  const probe = page.locator('[data-party-response-probe]')
  await expect(probe).toBeAttached()
  return probe.evaluate(async (element) => {
    const transforms: string[] = []
    for (let index = 0; index < 5; index += 1) {
      transforms.push(getComputedStyle(element).transform)
      await new Promise((resolve) => window.setTimeout(resolve, 80))
    }
    return transforms
  })
}

async function expectPartyResponseMotionAfterPreferenceChange(page: Page) {
  const probe = page.locator('[data-party-response-probe]')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(probe).toHaveAttribute('data-reduced-motion', 'true')
  await probe.evaluate((element) => {
    const target = element as HTMLElement & {
      meshMotionFrame?: number
      meshMotionSamples?: string[]
    }
    if (target.meshMotionFrame !== undefined) cancelAnimationFrame(target.meshMotionFrame)
    target.meshMotionSamples = []
    const sample = () => {
      target.meshMotionSamples?.push(getComputedStyle(target).transform)
      target.meshMotionFrame = requestAnimationFrame(sample)
    }
    sample()
  })

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(probe).toHaveAttribute('data-reduced-motion', 'false')
  await expect.poll(async () => probe.evaluate((element) => {
    const target = element as HTMLElement & { meshMotionSamples?: string[] }
    return new Set(target.meshMotionSamples ?? []).size
  })).toBeGreaterThan(1)

  await probe.evaluate((element) => {
    const target = element as HTMLElement & { meshMotionFrame?: number }
    if (target.meshMotionFrame !== undefined) cancelAnimationFrame(target.meshMotionFrame)
  })
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  runtimeErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  await page.goto('/?dev=kitchen-sink')
  await expect(page.getByRole('heading', { name: 'Mesh design-system kitchen sink' })).toBeVisible()
})

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) ?? [], 'design-system gallery emitted runtime errors').toEqual([])
})

test('renders every supported theme and exposes keyboard-operable primitives', async ({ page }) => {
  for (const theme of ['dark', 'light', 'high-contrast']) {
    await expect(page.locator(`section[data-theme="${theme}"]`)).toBeVisible()
  }
  const themeSurfaceColors = await page.locator('section[data-theme]').evaluateAll((sections) =>
    Object.fromEntries(sections.map((section) => [
      section.getAttribute('data-theme'),
      getComputedStyle(section).backgroundColor,
    ])),
  )
  expect(themeSurfaceColors.light).not.toBe(themeSurfaceColors.dark)
  expect(themeSurfaceColors['high-contrast']).toBe('rgb(0, 0, 0)')

  await page.getByRole('button', { name: 'ocean' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'ocean')

  const menuButton = page.getByRole('button', { name: 'Menu' })
  await menuButton.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Remove' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menuButton).toBeFocused()

  await page.getByRole('tab', { name: 'Details' }).click()
  await expect(page.getByRole('tabpanel').getByText('Detail content')).toBeVisible()
})

test('keeps semantic foregrounds and focus indicators contrast-safe in light theme', async ({ page }) => {
  const lightTheme = page.locator('section[data-theme="light"]')
  const tokens = await lightTheme.evaluate((element) => {
    const styles = getComputedStyle(element)
    const value = (name: string) => styles.getPropertyValue(name).trim()
    return {
      canvas: value('--surface-canvas'),
      accent: value('--content-accent'),
      link: value('--content-link'),
      focus: value('--border-focus'),
      success: value('--status-success'),
      warning: value('--status-warning'),
      avatar: value('--avatar-sand'),
      onAvatar: value('--content-on-avatar'),
    }
  })

  expect(contrastRatio(tokens.accent, tokens.canvas)).toBeGreaterThanOrEqual(4.5)
  expect(contrastRatio(tokens.link, tokens.canvas)).toBeGreaterThanOrEqual(4.5)
  expect(contrastRatio(tokens.success, tokens.canvas)).toBeGreaterThanOrEqual(4.5)
  expect(contrastRatio(tokens.warning, tokens.canvas)).toBeGreaterThanOrEqual(4.5)
  expect(contrastRatio(tokens.focus, tokens.canvas)).toBeGreaterThanOrEqual(3)
  expect(contrastRatio(tokens.onAvatar, tokens.avatar)).toBeGreaterThanOrEqual(4.5)
})

test('renders the command palette as one compact surface', async ({ page }) => {
  await page.getByRole('button', { name: /Commands/ }).click()

  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  const input = dialog.getByRole('combobox', { name: 'Command palette' })
  const listbox = dialog.getByRole('listbox')
  await expect(dialog).toBeVisible()
  await expect(input).toBeFocused()
  await expect(listbox).toBeVisible()
  await expect(dialog).toHaveCSS('padding', '0px')
  await expect(input).toHaveCSS('border-top-width', '0px')
  await expect(listbox).toHaveCSS('position', 'static')
  await expect(listbox).toHaveCSS('box-shadow', 'none')
  await expect(dialog).not.toContainText('Mute microphone')
  await expect(dialog).not.toContainText('Deafen audio')
})

test('runs bounded Party Response motion when the operating system allows it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Mesh design-system kitchen sink' })).toBeVisible()

  await expectPartyResponseMotionAfterPreferenceChange(page)
})

test('updates Party Response motion when the OS preference changes without a reload', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Mesh design-system kitchen sink' })).toBeVisible()
  await expectPartyResponseMotionAfterPreferenceChange(page)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('[data-party-response-probe]')).toHaveAttribute(
    'data-reduced-motion',
    'true',
  )
  expect(new Set((await samplePartyResponseMotion(page)).slice(1)).size).toBe(1)

  await expectPartyResponseMotionAfterPreferenceChange(page)
})

test('@a11y has no automated WCAG A/AA violations across the component gallery', async ({ page }) => {
  await expectNoWcagViolations(page, 'Design-system component gallery')
})

test('traps dialog focus, closes with Escape, and restores the trigger', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Open dialog' })
  await trigger.click()

  const dialog = page.getByRole('dialog', { name: 'Accessible dialog' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test.describe('reduced motion and narrow layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })

  test('honors the OS preference and has no horizontal page overflow', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Mesh design-system kitchen sink' })).toBeVisible()
    await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto')

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    }))
    expect(dimensions.reduced).toBe(true)
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport)
    expect(new Set(await samplePartyResponseMotion(page)).size).toBe(1)
  })
})
