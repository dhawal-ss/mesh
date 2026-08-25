import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectDeclarations,
  collectRuleBlocks,
  compositeOver,
  contrastRatio,
  expandVariables,
  findBranchDisagreements,
  findContainerLineFailures,
  findTextContrastFailures,
  measureContainerLines,
  relativeLuminance,
  resolveColor,
  resolveColorMix,
  themeVariables,
} from './check-container-contrast.mjs'

/*
  A stylesheet shaped like globals.css: a base :root, a color-mix @supports
  override, a light theme that redefines the referenced colours, and a
  min-width media query that must not leak into any theme.
*/
const STYLESHEET = `
:root {
  --ref-dark: #141311;
  --ref-light: #F7F6F2;
  --status-warning-rgb: 243 166 74;
  --status-warning: #F3A64A;
  --surface-base: var(--ref-dark);
  --warning-container-line: rgb(var(--status-warning-rgb) / 0.78);
}

@media (min-width: 2560px) {
  :root {
    --surface-base: #ff0000;
  }
}

@supports (color: color-mix(in oklch, white, black)) {
  :root {
    --warning-container-line: color-mix(in oklch, var(--status-warning) 78%, transparent);
  }
}

:root[data-theme='light'],
[data-theme='light'] {
  --status-warning-rgb: 129 89 0;
  --status-warning: #815900;
  --surface-base: var(--ref-light);
}
`

test('at-rule bodies are scanned, and the guard says which at-rule they sat under', () => {
  const blocks = collectRuleBlocks(STYLESHEET)
  const supported = blocks.find((block) => block.guard.some((guard) => guard.startsWith('@supports')))
  assert.ok(supported, 'the @supports block must be visited, not skipped')
  assert.equal(supported.selector, ':root')
  const media = blocks.find((block) => block.guard.some((guard) => guard.startsWith('@media')))
  assert.ok(media, 'the @media block must be visited so it can be deliberately excluded')
})

test('declarations are read in source order', () => {
  assert.deepEqual(
    collectDeclarations('--a: 1; --b: var(--a);'),
    [['--a', '1'], ['--b', 'var(--a)']],
  )
})

test('a width media query never reaches a theme', () => {
  const variables = themeVariables(STYLESHEET, 'dark')
  assert.equal(resolveColor('var(--surface-base)', variables).r, 0x14)
})

test('a theme block redirects the variables the base block referenced', () => {
  const dark = themeVariables(STYLESHEET, 'dark')
  const light = themeVariables(STYLESHEET, 'light')
  assert.deepEqual(resolveColor('var(--surface-base)', dark), { r: 20, g: 19, b: 17, a: 1 })
  assert.deepEqual(resolveColor('var(--surface-base)', light), { r: 247, g: 246, b: 242, a: 1 })
})

test('includeColorMix picks the declaration branch', () => {
  const mixed = themeVariables(STYLESHEET, 'light', { includeColorMix: true })
  const plain = themeVariables(STYLESHEET, 'light', { includeColorMix: false })
  assert.match(mixed.get('--warning-container-line'), /^color-mix/)
  assert.match(plain.get('--warning-container-line'), /^rgb\(/)
})

test('color-mix with transparent is the same colour at the mixed alpha', () => {
  // The whole gate rests on this: premultiplied mixing against rgb(0 0 0 / 0)
  // leaves the colour alone and only moves the alpha, which is why the two
  // branches in globals.css are meant to be interchangeable.
  const variables = themeVariables(STYLESHEET, 'light')
  const mixed = resolveColorMix('color-mix(in oklch, #815900 78%, transparent)', variables)
  assert.deepEqual(mixed, { r: 129, g: 89, b: 0, a: 0.78 })
})

test('a mix between two opaque colours is refused rather than approximated', () => {
  assert.equal(resolveColorMix('color-mix(in oklch, #815900 78%, #ffffff)', new Map()), null)
})

test('var() fallbacks are honoured and cycles terminate', () => {
  const variables = new Map([['--defined', '#010203'], ['--loop', 'var(--loop)']])
  assert.equal(expandVariables('var(--missing, #abcdef)', variables), '#abcdef')
  assert.equal(expandVariables('var(--defined)', variables), '#010203')
  assert.equal(expandVariables('var(--loop)', variables), null)
})

test('an unrecognised value resolves to null instead of a guess', () => {
  assert.equal(resolveColor('linear-gradient(red, blue)', new Map()), null)
  assert.equal(resolveColor('var(--never-declared)', new Map()), null)
})

test('compositing and the contrast formula match the WCAG definitions', () => {
  assert.deepEqual(
    compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 }),
    { r: 128, g: 128, b: 128, a: 1 },
  )
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1)
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0)
  // Black on white is the definitional 21:1.
  assert.equal(
    contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }).toFixed(2),
    '21.00',
  )
})

test('the gate reproduces the ratio that was computed by hand in the audit', () => {
  // #815900 at 55% over #F7F6F2 was reported as 2.36:1. That number is what
  // motivated raising the alpha, so the arithmetic behind it is pinned here.
  const line = { r: 0x81, g: 0x59, b: 0x00, a: 0.55 }
  const surface = { r: 0xf7, g: 0xf6, b: 0xf2, a: 1 }
  assert.equal(contrastRatio(compositeOver(line, surface), surface).toFixed(2), '2.36')
})

test('a shortfall in either declaration branch is a failure', () => {
  const weakened = STYLESHEET.replace(/0\.78/, '0.2').replace(/78%/, '20%')
  const failures = findContainerLineFailures(weakened)
  assert.ok(failures.length > 0, 'a 20% line on a pale canvas must not pass')
  assert.ok(
    failures.some((failure) => failure.branch === 'fallback'),
    'the non-color-mix fallback must be measured too',
  )
})

test('the branches must agree, and disagreement is reported', () => {
  const skewed = STYLESHEET.replace('78%, transparent', '30%, transparent')
  const problems = findBranchDisagreements(skewed)
  assert.ok(
    problems.some((problem) => problem.token === '--warning-container-line'),
    'a fallback that no longer matches its color-mix override must be caught',
  )
})

test('the shipped stylesheet passes every check', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const css = await readFile(path.join(root, 'src', 'styles', 'globals.css'), 'utf8')

  assert.deepEqual(findBranchDisagreements(css), [])
  assert.deepEqual(findContainerLineFailures(css), [])
  assert.deepEqual(findTextContrastFailures(css), [])

  // Every measurement must have actually resolved. A gate that silently skips
  // an unparsed token reports success on a surface it never looked at.
  const rows = measureContainerLines(css)
  assert.ok(rows.length > 0)
  assert.deepEqual(rows.filter((row) => row.ratio === null), [])
})
