import { expect, test } from '@playwright/test'
import { expectNoWcagViolations } from './helpers/accessibility'

test('workspace preview keeps the direct-message journey healthy', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/?dev=workspace')

  await page.getByRole('button', { name: 'Direct messages', exact: true }).click()

  await expect(page.getByText('Conversations could not be loaded.', { exact: true })).toHaveCount(0)
  const mayaConversation = page.getByRole('button', {
    name: 'Direct message with Maya Chen, 1 unread message',
    exact: true,
  })
  await expect(mayaConversation).toBeVisible()
  await expect(mayaConversation.locator('.badge-count')).toHaveText('1')
  await mayaConversation.click()

  await expect(page.getByRole('log', { name: 'Messages with Maya Chen', exact: true })).toBeVisible()
  const safetyToggle = page.getByRole('button', {
    name: 'Open Safety with Maya Chen',
    exact: true,
  })
  await expect(safetyToggle).toBeVisible()
  await expect(page.getByText(
    'I added the lighting reference to concept-art. The warmer pass is ready for another look.',
    { exact: true },
  )).toBeVisible()
  await expect(page.getByPlaceholder('Message Maya Chen')).toBeEnabled()
  await expect(page.getByText('Conversations could not be loaded.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Messages could not be loaded.', { exact: false })).toHaveCount(0)

  await safetyToggle.click()
  const safety = page.getByRole('complementary', { name: 'Safety with Maya Chen' })
  await expect(safety).toBeVisible()
  await expect(page.getByPlaceholder('Message Maya Chen')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await safety.getByRole('button', { name: 'Close Safety' }).click()
  await expect(safety).toHaveCount(0)
  await expect(safetyToggle).toBeFocused()
})

test('invitation preview reaches a room with a working visible send control', async ({ page }) => {
  await page.goto('/?dev=workspace&simulateInvitation=true&simulateSignedOut=true')

  await page.getByRole('button', { name: 'Sign in with Public account service', exact: true }).click()
  await page.getByRole('textbox', { name: 'Username or full account ID', exact: true })
    .fill('taylor')
  await page.getByLabel('Password', { exact: true }).fill('a long preview passphrase')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Open Mesh', exact: true }).click()

  await expect(page.getByRole('heading', {
    name: 'Invitation to Canyon Crew',
    exact: true,
  })).toBeVisible()
  await page.getByRole('button', { name: 'Join Canyon Crew', exact: true }).click()
  await page.getByRole('button', { name: 'Text room: controller lab', exact: true }).click()

  const composer = page.getByRole('textbox', { name: 'Message controller lab', exact: true })
  await composer.fill('Glad to be here.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  await expect(composer).toHaveValue('')
  await expect(page.getByText('Glad to be here.', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No messages yet', exact: true })).toHaveCount(0)
})

test('workspace preview keeps recovery usable in a compact-height window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 })
  await page.goto('/?dev=workspace')

  await page.getByRole('button', { name: 'You and settings' }).click()
  const you = page.getByRole('main', { name: 'Safety and devices' })
  await page.getByRole('combobox', { name: 'You section', exact: true })
    .selectOption('safety-devices')
  await you.getByRole('button', { name: 'Open your devices' }).click()

  const securityPanel = page.getByRole('region', { name: 'Safety and devices' })
  const testSavedCopy = securityPanel.getByRole('button', { name: 'Test saved copy' })
  await testSavedCopy.scrollIntoViewIfNeeded()
  await expect(testSavedCopy).toBeInViewport()
  await expect(testSavedCopy).toBeEnabled()
  await testSavedCopy.click()
  await expect(securityPanel.getByText('Message backup is ready')).toBeVisible()

  await expect(securityPanel.getByRole('button', { name: 'Create backup code' })).toHaveCount(0)
  await expect(securityPanel.getByText('Unhandled Mesh design preview IPC command', {
    exact: false,
  })).toHaveCount(0)
  await expectNoWcagViolations(page, 'Compact recovery preview')
})
