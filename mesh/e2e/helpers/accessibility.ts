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

export async function expectNoWcagViolations(page: Page, surface: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags([...WCAG_TAGS])
    .analyze()

  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target),
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
