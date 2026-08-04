import { expect, test } from '@playwright/test'

test('workspace preview keeps the direct-message journey healthy', async ({ page }) => {
  await page.goto('/?dev=workspace')

  await page.getByRole('button', { name: 'Direct messages', exact: true }).click()

  await expect(page.getByText('Conversations could not be loaded.', { exact: true })).toHaveCount(0)
  const mayaConversation = page.getByRole('button', {
    name: 'Direct message with Maya Chen',
    exact: true,
  })
  await expect(mayaConversation).toBeVisible()
  await expect(mayaConversation.locator('.badge-count')).toHaveText('1')
  await mayaConversation.click()

  await expect(page.getByRole('log', { name: 'Messages with Maya Chen', exact: true })).toBeVisible()
  await expect(page.getByRole('button', {
    name: 'Open Safety with Maya Chen',
    exact: true,
  })).toBeVisible()
  await expect(page.getByText(
    'I added the lighting reference to concept-art. The warmer pass is ready for another look.',
    { exact: true },
  )).toBeVisible()
  await expect(page.getByPlaceholder('Message #Maya Chen')).toBeEnabled()
  await expect(page.getByText('Conversations could not be loaded.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Messages could not be loaded.', { exact: false })).toHaveCount(0)
})
