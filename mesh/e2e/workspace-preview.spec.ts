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
  // The zero-padded numeral belonged to a row whose leading gutter was also a
  // numeral; with that gutter gone, the count is a plain number again. The
  // row's accessible name still says "1 unread message".
  await expect(mayaConversation.locator('.badge-count')).toHaveText('1')
  await mayaConversation.click()

  await expect(page.getByRole('feed', { name: 'Messages with Maya Chen', exact: true })).toBeVisible()
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

  await page.getByRole('button', { name: 'I already have an account', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in with Matrix.org', exact: true }).click()
  await page.getByRole('textbox', { name: 'Username or account address', exact: true })
    .fill('taylor')
  await page.getByLabel('Password', { exact: true }).fill('a long preview passphrase')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await expect(page.getByRole('heading', {
    name: 'Invitation to Canyon Collective',
    exact: true,
  })).toBeVisible()
  await page.getByRole('button', { name: 'Join Canyon Collective', exact: true }).click()

  const composer = page.getByRole('combobox', { name: 'Message controller lab', exact: true })
  await expect(composer).toBeVisible()
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
  await page.getByRole('button', { name: 'Back to account', exact: true }).first().click()
  await page.getByRole('button', { name: /^Safety and devices/ }).click()
  // The routed section body is a tab panel now, not a second main landmark
  // nested inside the shell's own main. The accessible name is unchanged.
  const you = page.getByRole('tabpanel', { name: 'Safety and devices' })
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

test('saved messages remain visible while delivery waits for a connection', async ({ page }) => {
  await page.goto('/?dev=workspace&simulateQueue=true&simulateOffline=true')
  await page.getByRole('button', { name: /^Lantern Guild/ }).first().click()
  await page.getByRole('button', { name: 'Text room: concept-art', exact: true }).click()

  await expect(page.getByText(
    'Uploading the controller-lighting notes when the connection is ready.',
    { exact: true },
  )).toBeVisible()
  await expect(page.getByText('Saved for later', { exact: true })).toBeVisible()
  await expect(page.getByText('You are offline.', { exact: false })).toHaveCount(0)
  // The rail's compact connection pill is the one place allowed to say
  // "Offline": it is the deliberate indicator for a paused link, and its full
  // sentence lives in the accessible name. Anything beyond that single pill
  // would mean scare copy leaked back into the shell.
  await expect(page.getByText('Offline', { exact: true })).toHaveCount(1)
})

test('workspace preview exposes reproducible room loading, empty, and error states', async ({ page }) => {
  await page.goto('/?dev=workspace&simulateRoomState=loading')
  await page.getByRole('button', { name: /^Lantern Guild/ }).first().click()
  await page.getByRole('button', { name: 'Text room: concept-art', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Bringing in this room' })).toBeVisible()
  await expect(page.getByText(
    'Checking for new activity.',
    { exact: true },
  )).toBeVisible()

  await page.goto('/?dev=workspace&simulateRoomState=empty')
  await page.getByRole('button', { name: /^Lantern Guild/ }).first().click()
  await page.getByRole('button', { name: 'Text room: concept-art', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Nothing here yet', exact: true })).toBeVisible()

  await page.goto('/?dev=workspace&simulateRoomState=error')
  await page.getByRole('button', { name: /^Lantern Guild/ }).first().click()
  await page.getByRole('button', { name: 'Text room: concept-art', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Messages could not be loaded.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry messages', exact: true })).toBeVisible()
})

test('workspace preview exposes reproducible direct-message list states', async ({ page }) => {
  await page.goto('/?dev=workspace&simulateDmListState=loading')
  await page.getByRole('button', { name: 'Direct messages', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Bringing in your conversations' })).toBeVisible()

  await page.goto('/?dev=workspace&simulateDmListState=empty')
  await page.getByRole('button', { name: 'Direct messages', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Start a direct message', exact: true })).toBeVisible()

  await page.goto('/?dev=workspace&simulateDmListState=error')
  await page.getByRole('button', { name: 'Direct messages', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Conversations could not be loaded.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry conversations', exact: true })).toBeVisible()
})

test('workspace preview exposes reproducible direct-message timeline states', async ({ page }) => {
  await page.goto('/?dev=workspace&simulateDmMessageState=loading')
  await page.getByRole('button', { name: 'Direct messages', exact: true }).click()
  await page.getByRole('button', { name: /Direct message with Maya Chen/ }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Bringing in this conversation' })).toBeVisible()

  await page.goto('/?dev=workspace&simulateDmMessageState=empty')
  await page.getByRole('button', { name: 'Direct messages', exact: true }).click()
  await page.getByRole('button', { name: /Direct message with Maya Chen/ }).click()
  await expect(page.getByRole('heading', { name: 'Nothing here yet', exact: true })).toBeVisible()

  await page.goto('/?dev=workspace&simulateDmMessageState=error')
  await page.getByRole('button', { name: 'Direct messages', exact: true }).click()
  await page.getByRole('button', { name: /Direct message with Maya Chen/ }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Messages could not be loaded.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry messages', exact: true })).toBeVisible()
})

test('saved message state recovers after restore and update-listener failures', async ({ page }) => {
  await page.goto('/?dev=workspace&simulateQueue=true&simulateQueueRestoreFailure=true')

  const restoreNotice = page.getByRole('alert').filter({ hasText: 'restore saved messages' })
  await expect(restoreNotice).toBeVisible()
  await restoreNotice.getByRole('button', { name: 'Try again' }).click()
  await expect(restoreNotice).toHaveCount(0)
  await page.getByRole('button', { name: /^Lantern Guild/ }).first().click()
  await page.getByRole('button', { name: 'Text room: concept-art', exact: true }).click()
  await expect(page.getByText('Saved for later', { exact: true })).toBeVisible()

  await page.goto('/?dev=workspace&simulateQueue=true&simulateQueueListenerFailure=true')
  const updateNotice = page.getByRole('status').filter({
    hasText: 'status may not update yet',
  })
  await expect(updateNotice).toBeVisible()
  await updateNotice.getByRole('button', { name: 'Try again' }).click()
  await expect(updateNotice).toHaveCount(0)
  await page.getByRole('button', { name: /^Lantern Guild/ }).first().click()
  await page.getByRole('button', { name: 'Text room: concept-art', exact: true }).click()
  await expect(page.getByText('Saved for later', { exact: true })).toBeVisible()
})

/*
  A room created in this community after this account arrived. Nothing joins an
  existing member to a new room, so before this it was dropped from the listing
  and counted as a room Mesh could not open safely, with no way to reach it.
*/
test('offers a room this account has not joined, and opens it once joined', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/?dev=workspace')
  await page.getByRole('button', { name: /^Lantern Guild/ }).first().click()

  const unjoinedRoom = page.getByRole('button', { name: /^Text room: raid-planning, not joined yet/ })
  await unjoinedRoom.scrollIntoViewIfNeeded()
  await expect(unjoinedRoom).toBeVisible()
  // The state is a word, not a shade: a quiet joined room and an unjoined one
  // are otherwise the same row.
  await expect(unjoinedRoom).toContainText('Join')
  await expectNoWcagViolations(page, 'Room list carrying an unjoined room')

  await unjoinedRoom.click()

  // Joined, opened, and no longer offering a join it has already done.
  const joinedRoom = page.getByRole('button', { name: 'Text room: raid-planning' })
  await expect(joinedRoom).toHaveAttribute('aria-current', 'page')
  await expect(joinedRoom).not.toContainText('Join')
  await expect(page.getByRole('combobox', { name: 'Message raid-planning', exact: true })).toBeVisible()
})
