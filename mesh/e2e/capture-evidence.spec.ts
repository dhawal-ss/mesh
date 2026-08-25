import { test, expect, type Page } from '@playwright/test'

/*
  Writes the 1280x720 evidence set DESIGN_CONFORMANCE.md cites.

  The previous set records the Indie Workshop contract and is superseded, so a
  governance document was pointing at nine screenshots of a design that no
  longer ships. These are captured from the workspace preview at the reference
  matrix so a reviewer sees the same pixels the acceptance bar describes.
*/
const DIRECTORY = 'audit/design-2026-08-current'

/*
  Refuse to capture a build that is not this one.

  The committed config carries `reuseExistingServer: !process.env.CI`, so a dev
  server already listening on the port -- for a different worktree, a different
  branch, anything -- is silently reused. For an ordinary test that produces a
  confusing failure; for a generator that writes files it produces a corrupted
  evidence set with no failure at all, which is what happened once.

  The ground is the cheapest thing to check and the first thing Quiet Structure
  changes, so it is the guard.
*/
async function assertQuietStructure(page: Page) {
  const canvas = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ref-quiet-canvas').trim(),
  )
  expect(
    canvas.toLowerCase(),
    'the server under test is not serving Quiet Structure. A dev server for another '
      + 'checkout was probably already listening on this port, and capturing from it would '
      + 'write a different design into the evidence set.',
  ).toBe('#0a0a0b')
}

async function openPreview(page: Page, query = '') {
  await page.goto(`/?dev=workspace${query}`)
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
  await assertQuietStructure(page)
}

async function settle(page: Page) {
  await page.waitForTimeout(400)
}

test('captures the Quiet Structure evidence set', async ({ page }) => {
  await openPreview(page)
  await settle(page)
  await page.screenshot({ path: `${DIRECTORY}/01-home-1280x720.png` })

  // Community desk: the room list, the conversation header and the roster.
  // The rail is the way in; Home shows no room list of its own.
  await page.getByRole('button', { name: /^Lantern Guild/ }).first().click()
  await page.getByRole('button', { name: /Text room: concept-art/ }).click()
  await expect(page.getByRole('feed', { name: 'Messages in #concept-art' })).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${DIRECTORY}/02-community-1280x720.png` })

  // The conversation with the details panel open, which is the four-pane shell.
  await page.getByRole('button', { name: 'Show Details' }).click()
  await settle(page)
  await page.screenshot({ path: `${DIRECTORY}/04-private-conversation-1280x720.png` })
  await page.getByRole('button', { name: 'Close room context' }).click()

  // Direct messages.
  await page.getByRole('button', { name: /^Direct messages/ }).first().click()
  await settle(page)
  await page.screenshot({ path: `${DIRECTORY}/03-direct-messages-1280x720.png` })

  // Settings, on Appearance.
  // Settings, on Appearance. It is a routed surface in the preview rather
  // than a dialog, so the tab list is reached through the account route.
  await page.getByRole('button', { name: 'You and settings' }).click()
  await page.getByRole('button', { name: 'Back to account', exact: true }).first().click()
  await page.getByRole('tab', { name: 'Appearance' }).click()
  await expect(page.getByRole('tabpanel', { name: 'Appearance' })).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${DIRECTORY}/05-settings-1280x720.png` })

  // The command palette as a full-width band.
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${DIRECTORY}/10-command-palette-1280x720.png` })
  await page.keyboard.press('Escape')
})

/*
  The voice room and the call bar are not captured here.

  `shouldExposeVoiceRoutes` gates the voice destinations on backend
  capabilities the workspace preview's mock does not report, so there is no
  path to a call in this fixture. Capturing them needs a real Matrix RTC
  session, which is a Track G acceptance activity rather than a design one.
*/
test('captures account setup', async ({ page }) => {
  await page.goto('/?dev=workspace&simulateSignedOut=true')
  await assertQuietStructure(page)
  await settle(page)
  await page.screenshot({ path: `${DIRECTORY}/06-onboarding-1280x720.png` })
})
