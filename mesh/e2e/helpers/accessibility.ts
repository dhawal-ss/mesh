import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
] as const

/*
  'best-practice' is deliberately not in that list yet, and this is a measured
  decision rather than an oversight. Adding it on 2026-08-20 surfaced violations
  in six rule classes across the suite. Three were real and are fixed: the skip
  links sat outside any landmark (24 hits, now none), the room-navigation column
  claimed role="dialog" on an <aside> that may not take it, and the embedded
  settings frame dropped the h2 its dialog form provides, so its sections
  followed the route's h1 and skipped a level.

  What remains needs a product decision rather than a mechanical repair, so it
  stays out of this list rather than being half-applied here: landmark-one-main
  and page-has-heading-one ask which surface owns <main> and the page heading in
  a shell whose routes swap under a persistent frame, and aria-allowed-role
  objects to role="combobox" on the composer's <textarea>, which is what makes
  the mention autocomplete announce at all.
*/

/**
 * Scans the page, or one overlay on it.
 *
 * `within` exists for menus and dialogs. Radix marks the shell behind an open
 * overlay `aria-hidden` while trapping focus inside it, and `aria-hidden-focus`
 * is a static rule that cannot see the trap, so it reports the whole shell.
 * Scoping the scan to the overlay is only honest if focus really is trapped, so
 * the specs that pass `within` assert that separately by walking Tab and
 * checking where focus lands.
 */
export async function expectNoWcagViolations(
  page: Page,
  surface: string,
  within?: string,
): Promise<void> {
  if (within) {
    /*
      An overlay animates in, and its surface is what fades: Modal wraps its
      content in a motion.div carrying .mesh-overlay-surface, so the role=dialog
      node reaches opacity 1 while the surface behind the text is still arriving.
      Scanning then composites the text through a partly transparent surface and
      the scrim, which reports contrast failures that do not exist once it has
      landed -- and reports a different ratio on each run, which is what gave it
      away.
    */
    await expect(page.locator(within).first()).toHaveCSS('opacity', '1')
    // The class sits on the overlay itself for menus and popovers, and on the
    // motion.div inside it for dialogs, so both shapes are matched.
    const overlaySurface = page
      .locator(`${within}.mesh-overlay-surface, ${within} .mesh-overlay-surface`)
      .first()
    // Named failure rather than a silent skip: if this class is ever renamed or
    // moved, a guarded `if` would quietly resume scanning mid-animation and
    // reinvent the contrast failures described above.
    expect(
      await overlaySurface.count(),
      `${surface} scan found no .mesh-overlay-surface inside ${within} to wait on`,
    ).toBeGreaterThan(0)
    await expect(overlaySurface).toHaveCSS('opacity', '1')
  }
  const builder = new AxeBuilder({ page }).withTags([...WCAG_TAGS])
  const results = await (within ? builder.include(within) : builder).analyze()

  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target),
    html: violation.nodes.map((node) => node.html),
    data: violation.nodes.map((node) => node.any.map((check) => check.data)),
  }))

  if (results.incomplete.length > 0) {
    await test.info().attach(`${surface} axe manual-review items`, {
      body: JSON.stringify(results.incomplete, null, 2),
      contentType: 'application/json',
    })
  }

  expect(
    results.violations,
    `${surface} has WCAG A/AA violations:\n${JSON.stringify(summary, null, 2)}`,
  ).toEqual([])
}
