import { expect, test, type Page } from '@playwright/test'
import { expectNoWcagViolations } from './helpers/accessibility'

const runtimeErrors = new WeakMap<Page, string[]>()

async function waitForAccountScreenMotion(page: Page): Promise<void> {
  const form = page.locator('form')
  const shell = page.locator('[data-onboarding-shell]')
  await expect(form).toBeVisible()
  await expect(shell).toHaveCSS('opacity', '1')
  await expect.poll(() => form.evaluate((element) => (
    getComputedStyle(element.parentElement ?? element).opacity
  ))).toBe('1')
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  runtimeErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await waitForAccountScreenMotion(page)
})

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) ?? [], 'onboarding emitted runtime errors').toEqual([])
})

test('@a11y has no automated WCAG A/AA violations on account creation', async ({ page }) => {
  await expectNoWcagViolations(page, 'Create Account screen')
})

test('@a11y has no automated WCAG A/AA violations on sign in', async ({ page }) => {
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const signInHeading = page.getByRole('heading', { name: 'Welcome back' })
  await expect(signInHeading).toBeVisible()
  await waitForAccountScreenMotion(page)
  await expect(signInHeading).toBeFocused()

  await expectNoWcagViolations(page, 'Sign In screen')
})

test('keeps the primary account actions visible at a compact desktop height', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })

  const createAccount = page.getByRole('button', { name: 'Create account' })
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true })
  await expect(createAccount).toBeVisible()
  await expect(signIn).toBeVisible()

  const createBounds = await createAccount.boundingBox()
  const signInBounds = await signIn.boundingBox()
  expect((createBounds?.y ?? 720) + (createBounds?.height ?? 0)).toBeLessThanOrEqual(720)
  expect((signInBounds?.y ?? 720) + (signInBounds?.height ?? 0)).toBeLessThanOrEqual(720)
  expect(await page.locator('main').evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true)
})

test('keeps trust context and account setup usable in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })

  const shell = page.getByRole('region', { name: 'Set up Mesh' })
  await expect(shell).toBeVisible()
  await expect(page.getByText('Conversations that stay yours.')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Setup progress' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible()

  const bounds = await shell.boundingBox()
  expect(bounds?.x).toBeGreaterThanOrEqual(0)
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expectNoWcagViolations(page, 'Narrow account setup')
})

test('keeps the onboarding masthead compact at tablet widths', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.reload()

  const shell = page.locator('[data-onboarding-shell]')
  const masthead = shell.locator('aside')
  await expect(shell).toBeVisible()
  await expect(masthead).toBeVisible()

  const dimensions = await masthead.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }))
  expect(dimensions.width).toBeLessThanOrEqual(768)
  expect(dimensions.height).toBeLessThan(240)
})
