import { test, expect, type Page } from '@playwright/test'

/*
  The user text-scale contract at its ceiling.

  --text-scale multiplies every size step, and it reaches 1.5. That puts the
  one display-step heading at 114px and a room title at 84px, which is the
  size at which a poster step stops being editorial and starts pushing a
  layout sideways. WCAG 1.4.4 asks that text scale without loss of content or
  function, and horizontal scrolling of prose is the loss it names.

  This is deliberately separate from the browser-zoom reachability specs:
  zoom scales the viewport, so the layout keeps its proportions. Text scale
  grows the type inside a viewport that does not move.
*/
const SCALES = [1, 1.25, 1.5] as const
const VIEWPORTS = [
  { width: 1280, height: 720, label: 'reference' },
  { width: 1100, height: 700, label: 'small desktop' },
  { width: 800, height: 600, label: 'minimum' },
] as const

async function applyTextScale(page: Page, scale: number) {
  await page.evaluate((value) => {
    document.documentElement.style.setProperty('--text-scale', String(value))
  }, scale)
  await page.waitForTimeout(200)
}

async function overflow(page: Page) {
  return page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    widest: [...document.querySelectorAll<HTMLElement>('h1, h2')]
      .map((heading) => ({
        text: heading.textContent?.slice(0, 24) ?? '',
        overflowing: heading.scrollWidth - heading.clientWidth,
      }))
      .filter((entry) => entry.overflowing > 1),
  }))
}

for (const viewport of VIEWPORTS) {
  for (const scale of SCALES) {
    test(`the conversation reflows at ${scale * 100}% text on the ${viewport.label} window`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.goto('/?dev=workspace')
      await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
      await page.getByRole('button', { name: /^Lantern Guild/ }).first().click()
      /*
        The room list is a drawer below 1000px. An M3 row is 340px wide, so at
        the 800px minimum window a docked list would leave the conversation
        336px; the list opens on demand there instead, and this is the same
        control the narrow-shell specs use.
      */
      const openRoomNavigation = page.getByRole('button', { name: 'Open room navigation' })
      if (await openRoomNavigation.isVisible()) await openRoomNavigation.click()
      await page.getByRole('button', { name: /Text room: concept-art/ }).click()
      await expect(page.getByRole('feed', { name: 'Messages in #concept-art' })).toBeVisible()
      await applyTextScale(page, scale)

      const measured = await overflow(page)
      expect(measured.page, `${viewport.label} at ${scale * 100}% scrolls horizontally`)
        .toBeLessThanOrEqual(1)
      // A truncated heading is fine; a heading wider than its own box is the
      // clipping this guards against.
      expect(measured.widest, `${viewport.label} at ${scale * 100}% clips a heading`).toEqual([])

      // The composer has to stay usable, which is the function WCAG 1.4.4
      // asks not to lose.
      // The composer is a persistent combobox, not a plain textbox: NVDA does
              // not reliably follow aria-activedescendant on a textbox, so the
              // role is stable rather than swapped when suggestions appear.
              await expect(page.getByRole('combobox', { name: /Message concept-art/ })).toBeVisible()
    })

    test(`setup reflows at ${scale * 100}% text on the ${viewport.label} window`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.goto('/?dev=workspace&simulateSignedOut=true')
      await page.waitForTimeout(400)
      await applyTextScale(page, scale)

      const measured = await overflow(page)
      expect(measured.page, `setup ${viewport.label} at ${scale * 100}% scrolls horizontally`)
        .toBeLessThanOrEqual(1)
      expect(measured.widest, `setup ${viewport.label} at ${scale * 100}% clips a heading`).toEqual([])
    })
  }
}
