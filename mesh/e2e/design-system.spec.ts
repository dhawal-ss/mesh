import { expect, test, type Page } from '@playwright/test'
import { expectNoWcagViolations } from './helpers/accessibility'

const runtimeErrors = new WeakMap<Page, string[]>()

async function sampleAmbientMotion(page: Page): Promise<string[]> {
  const probe = page.locator('[data-ambient-motion-probe]')
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
    sections.map((section) => getComputedStyle(section).backgroundColor),
  )
  expect(new Set(themeSurfaceColors).size).toBe(3)

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

test('runs ambient motion when the operating system allows it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Mesh design-system kitchen sink' })).toBeVisible()

  expect(new Set(await sampleAmbientMotion(page)).size).toBeGreaterThan(1)
})

test('updates ambient motion when the OS preference changes without a reload', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Mesh design-system kitchen sink' })).toBeVisible()
  expect(new Set(await sampleAmbientMotion(page)).size).toBeGreaterThan(1)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('[data-ambient-motion-probe]')).toHaveAttribute(
    'data-reduced-motion',
    'true',
  )
  expect(new Set((await sampleAmbientMotion(page)).slice(1)).size).toBe(1)

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(page.locator('[data-ambient-motion-probe]')).toHaveAttribute(
    'data-reduced-motion',
    'false',
  )
  expect(new Set(await sampleAmbientMotion(page)).size).toBeGreaterThan(1)
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
    expect(new Set(await sampleAmbientMotion(page)).size).toBe(1)
  })
})
