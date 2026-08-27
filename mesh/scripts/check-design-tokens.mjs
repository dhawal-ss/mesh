import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectRuleBlocks,
  findBranchDisagreements,
  findContainerLineFailures,
  findTextContrastFailures,
} from './check-container-contrast.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tailwindPath = path.join(root, 'tailwind.config.ts')
const globalsPath = path.join(root, 'src', 'styles', 'globals.css')
const mainPath = path.join(root, 'src', 'main.tsx')
const motionPath = path.join(root, 'src', 'lib', 'motion.ts')
const componentsPath = path.join(root, 'src', 'components')
const designLanguagePath = path.join(root, 'DESIGN_LANGUAGE.md')
const iconPath = path.join(root, 'src', 'components', 'ui', 'Icon.tsx')
const voiceGridPath = path.join(root, 'src', 'components', 'voice', 'VoicePeerGrid.tsx')

const [tailwind, globals, main, motion, designLanguage, icon, voiceGrid] = await Promise.all([
  readFile(tailwindPath, 'utf8'),
  readFile(globalsPath, 'utf8'),
  readFile(mainPath, 'utf8'),
  readFile(motionPath, 'utf8'),
  readFile(designLanguagePath, 'utf8'),
  readFile(iconPath, 'utf8'),
  readFile(voiceGridPath, 'utf8'),
])

const errors = []

for (const heading of [
  '# Mesh design language: Material 3 Expressive',
  '## Principles',
  '## Positioning against Discord',
  '## Typography',
  '## Spacing and density',
  '## Color system',
  '## Elevation, radius, and border',
  '## Motion',
  '## Iconography',
  '## Component anatomy and states',
  '## Voice and video',
  '## Mechanical enforcement',
  '## Budget decision',
]) {
  if (!designLanguage.includes(heading)) {
    errors.push(`DESIGN_LANGUAGE.md must include ${heading}`)
  }
}

const principleLines = designLanguage.match(/^\d+\. \*\*[^\r\n]+\*\*[^\r\n]+$/gm) ?? []
if (principleLines.length < 1 || principleLines.length > 5) {
  errors.push(`DESIGN_LANGUAGE.md must define between one and five named principles, found ${principleLines.length}`)
}

const normalizedDesignLanguage = designLanguage.toLowerCase()
for (const contractPhrase of [
  '`Roboto Flex`',
  'Reference tokens',
  'Semantic tokens',
  'Component tokens',
  'WCAG AA',
  'reduced motion',
  '1280 by 720',
  '2 participants',
  'With 3',
  '4 to 8',
  'persistent call bar',
  'shape scale',
  'state layers',
  'chroma-free',
]) {
  if (!normalizedDesignLanguage.includes(contractPhrase.toLowerCase())) {
    errors.push(`DESIGN_LANGUAGE.md must include the contract phrase ${contractPhrase}`)
  }
}

for (const iconSize of ['sm: 20', 'md: 24', 'lg: 40']) {
  if (!icon.includes(iconSize)) {
    errors.push(`Icon.tsx must retain the design-language size ${iconSize}`)
  }
}
for (const iconRule of [
  "strokeWidth={size === 'lg' ? 2.25 : 2}",
  'absoluteStrokeWidth',
  'focusable="false"',
]) {
  if (!icon.includes(iconRule)) {
    errors.push(`Icon.tsx must retain ${iconRule}`)
  }
}

for (const callContract of [
  'data-participant-count={peers.length}',
  'mesh-call-grid',
  'mesh-call-tile',
  'lg:grid-cols-4',
  "visiblePeers.length <= 8",
]) {
  if (!voiceGrid.includes(callContract)) {
    errors.push(`VoicePeerGrid.tsx must retain the call-grid contract ${callContract}`)
  }
}

function literalColorViolations(source) {
  const violations = []
  if (/#[\da-f]{3,8}\b/i.test(source)) {
    violations.push('hex color literal')
  }
  if (/\boklch\(/i.test(source)) {
    violations.push('OKLCH color literal')
  }
  if (/rgba?\(\s*(?:\d|\.\d)/i.test(source)) {
    violations.push('numeric rgb/rgba color literal')
  }
  return violations
}

const visualPatterns = [
  {
    kind: 'hex color literal',
    expression: /#[\da-f]{3,8}\b/gi,
  },
  {
    kind: 'numeric rgb/rgba color literal',
    expression: /\brgba?\(\s*(?:\d|\.\d)[^)]*\)/gi,
  },
  {
    kind: 'OKLCH color literal',
    expression: /\boklch\([^)]*\)/gi,
  },
  {
    kind: 'reference-tier token',
    expression: /var\(\s*--ref-[\w-]+\s*\)/gi,
  },
  {
    kind: 'arbitrary visual Tailwind class',
    expression: /\b(?:bg|text|border|rounded|w|h|min-w|max-w|min-h|max-h|p[xytrbl]?|m[xytrbl]?|gap|z|top|right|bottom|left|inset|tracking|leading|shadow|ring)-\[[^\]\r\n]+\]/gi,
  },
  {
    kind: 'raw white/black class',
    expression: /\b(?:bg|border|text)-(?:white|black)(?:\/(?:\d+|\[[^\]\r\n]+\]))?(?![\w-])/gi,
  },
  {
    kind: 'stock palette class',
    expression: /\b(?:bg|border|text)-(?:blue|green|red|yellow|purple|orange|pink|indigo|violet|emerald|teal|cyan|sky|lime|amber|rose)-\d{2,3}(?:\/\d+)?/gi,
  },
  {
    kind: 'unsupported font-weight class',
    expression: /\bfont-(?:thin|extralight|light|bold|extrabold|black)\b/gi,
  },
  {
    kind: 'unsupported font-size class',
    expression: /\btext-(?:xl|[2-9]xl)\b/gi,
  },
  {
    kind: 'box-shadow focus ring',
    expression: /\bfocus(?:-visible)?:ring(?:-[^\s'"]+)?/gi,
  },
  {
    kind: 'stock elevation class',
    expression: /\bshadow-(?:sm|md|lg|xl|2xl)\b/gi,
  },
  {
    kind: 'hardcoded layout Tailwind class',
    expression: /\b(?:grid-cols|min|max)-\[[^\]\r\n]*(?:\d(?:\.\d+)?(?:px|rem|fr))[^\]\r\n]*\](?::[\w-]+)?/gi,
  },
  {
    kind: 'hardcoded animation Tailwind class',
    expression: /(?:\banimate-\[[^\]\r\n]*(?:\d(?:\.\d+)?(?:ms|s))[^\]\r\n]*\]|\[animation-delay:\s*\d(?:\.\d+)?(?:ms|s)\])/gi,
  },
]

function visualViolations(source) {
  const violations = []
  for (const { kind, expression } of visualPatterns) {
    expression.lastIndex = 0
    for (const match of source.matchAll(expression)) {
      violations.push({ kind, token: match[0] })
    }
  }
  return violations
}

function undersizedControlTokens(source) {
  const violations = []
  for (const match of source.matchAll(/(--density-control-[\w-]+)\s*:\s*([\d.]+)px\s*;/g)) {
    const value = Number(match[2])
    if (value < 32) {
      violations.push({ token: match[1], value })
    }
  }
  return violations
}

function hardcodedMotionViolations(source) {
  const violations = []
  for (const match of source.matchAll(/\b(?:initial|animate|exit|whileHover|whileTap)=\{\{([^}\r\n]+)\}\}/g)) {
    for (const value of match[1].matchAll(/\b(x|y|rotate|scale)\s*:\s*(-?\d+(?:\.\d+)?)/g)) {
      const property = value[1]
      const amount = Number(value[2])
      const neutral = property === 'scale' ? amount === 0 || amount === 1 : amount === 0
      if (!neutral) violations.push(`${property}: ${value[2]}`)
    }
  }
  return violations
}

// Keep self-tests here so weakening either detector cannot silently pass.
const detectorFixture = "colors: { bad: '#fff', worse: 'rgb(1 2 3)', alsoBad: 'oklch(50% 0.1 240)' }"
const componentFixture = 'bg-[#fff] text-[11px] border-white/10 bg-yellow-500/10 font-bold text-xl var(--ref-neutral-1) oklch(50% 0.1 240) focus-visible:ring-2 shadow-lg'
const densityFixture = '--density-control-sm: 28px; --density-control-md: 32px;'
const motionFixture = 'initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} whileTap={{ scale: 0.96 }}'
if (
  literalColorViolations(detectorFixture).length !== 3
  || visualViolations(componentFixture).length !== 11
  || undersizedControlTokens(densityFixture).length !== 1
  || hardcodedMotionViolations(motionFixture).length !== 2
) {
  throw new Error('Design-token checker self-test failed')
}

for (const violation of literalColorViolations(tailwind)) {
  errors.push(`tailwind.config.ts contains a ${violation}`)
}

const rootBlock = globals.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1]
if (!rootBlock) {
  throw new Error('Design-token checker could not parse the base :root token block')
}

const declarations = new Map()
for (const match of rootBlock.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)) {
  declarations.set(match[1], match[2].trim())
}

/*
  Material 3 Expressive's product palette, asserted by value.

  The neutral ramp is chroma-free, which is the one decision that stops an M3
  palette reading as stock. The three chromatic families are the whole colour
  budget: azure carries structure and selection, coral carries exceptions, and
  amber marks pinned and live. There is no green, because a healthy state is
  silence and coral only means something while it is the only red thing here.
*/
const expectedMaterialColors = new Map([
  ['--ref-n-0', '#050507'],
  ['--ref-n-4', '#0F1011'],
  ['--ref-n-6', '#17171C'],
  ['--ref-n-10', '#1D1D23'],
  ['--ref-n-14', '#26262E'],
  ['--ref-n-17', '#313139'],
  ['--ref-n-22', '#3D3D46'],
  ['--ref-n-56', '#8E8E99'],
  ['--ref-n-80', '#C6C6CE'],
  ['--ref-n-96', '#F5F5F8'],
  ['--ref-azure-20', '#002E4E'],
  ['--ref-azure-30', '#1F3B5C'],
  ['--ref-azure-40', '#00548F'],
  ['--ref-azure-80', '#7FC0FF'],
  ['--ref-azure-90', '#CFE8FF'],
  ['--ref-azure-92', '#D6E7FA'],
  ['--ref-coral-20', '#5F1005'],
  ['--ref-coral-40', '#B3271A'],
  ['--ref-coral-80', '#FF8F80'],
  ['--ref-coral-90', '#FFDAD4'],
  ['--ref-amber-20', '#3D2E00'],
  ['--ref-amber-40', '#7A5A00'],
  ['--ref-amber-80', '#FFD24A'],
  ['--ref-amber-90', '#FFEFC2'],
])

for (const [name, expected] of expectedMaterialColors) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must use the approved Material 3 value (${expected})`)
  }
}

/*
  Six container tones, six distinct values.

  Depth is tonal in this contract: a pane is separated from its neighbour by a
  step on this ramp and a 28px radius, never by a hairline. Two tones resolving
  to the same value is not a cosmetic near-miss, it is a boundary that has
  silently stopped existing -- and the rule this replaces asserted the exact
  opposite, that the rail and the canvas were one ground divided by a rule.
*/
const SURFACE_TONES = [
  '--surface',
  '--surface-container-lowest',
  '--surface-container-low',
  '--surface-container',
  '--surface-container-high',
  '--surface-container-highest',
]

function resolveReference(name, depth = 0) {
  const declared = declarations.get(name)
  if (declared === undefined || depth > 8) return declared
  const indirection = declared.match(/^var\(\s*(--[\w-]+)\s*\)$/)
  return indirection ? resolveReference(indirection[1], depth + 1) : declared
}

const toneValues = new Map()
for (const tone of SURFACE_TONES) {
  if (!declarations.has(tone)) {
    errors.push(`globals.css must define surface tone ${tone}`)
    continue
  }
  const value = resolveReference(tone)
  if (toneValues.has(value)) {
    errors.push(
      `${tone} resolves to ${value}, the same value as ${toneValues.get(value)}. The six surface `
      + 'tones must be six distinct values; a repeated tone is a pane boundary that stopped existing.',
    )
    continue
  }
  toneValues.set(value, tone)
}

/*
  State layers replace the four structural alpha-white fills.

  The old vocabulary named four strengths of white and composited two of them
  against the canvas by hand, which is why this checker used to carry a copy of
  the canvas channels. An M3 state layer is an opacity applied over whatever
  role colour is underneath, so there is nothing to pre-composite and nothing
  to drift out of step.
*/
const expectedStateLayers = new Map([
  ['--state-hover', '0.08'],
  ['--state-focus', '0.10'],
  ['--state-pressed', '0.10'],
  ['--state-drag', '0.16'],
])

for (const [name, expected] of expectedStateLayers) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must use the M3 state-layer opacity (${expected})`)
  }
}

/*
  Retired by this contract. Each of these was load-bearing under Quiet
  Structure and each is now a different mechanism: the hairlines became tonal
  steps, the alpha fills became state layers, the zero-radius structural plane
  became the shape scale, and the mono family left the bundle.
*/
for (const retired of [
  '--ref-quiet-rule-alpha',
  '--ref-quiet-fill-alpha',
  '--surface-fill',
  '--border-structural',
  '--border-row',
  '--surface-rail',
  '--radius-plane',
  '--font-mono',
]) {
  if (declarations.has(retired)) {
    errors.push(`${retired} is retired by the Material 3 contract and must not be redeclared in :root`)
  }
}

for (const [index, line] of globals.split(/\r?\n/).entries()) {
  if (
    (/#(?:[\da-f]{3,8})\b/i.test(line) || /\boklch\(/i.test(line))
    && !/^\s*--ref-[\w-]+\s*:/.test(line)
    && !/^\s*@supports\s+\(color:\s*oklch\(/.test(line)
  ) {
    errors.push(`globals.css:${index + 1} contains a color literal outside the reference tier`)
  }
}

for (const violation of undersizedControlTokens(globals)) {
  errors.push(`${violation.token} must be at least 32px, found ${violation.value}px`)
}

/*
  The closed type scale, in M3 role names.

  Thirteen roles, one family, and a floor of 11px for anything informational.
  The 9.5px uppercase eyebrow and the 10px count are retired rather than
  renamed: both were below the legible floor and both existed to fit a ruled
  geometry this contract replaced. Nothing here is uppercased, so there is no
  tracking token above 0.5px and no eyebrow letter-spacing left to alias.
*/
const expectedTypography = new Map([
  ['--ref-size-11', '11px'],
  ['--ref-size-12', '12px'],
  ['--ref-size-14', '14px'],
  ['--ref-size-16', '16px'],
  ['--ref-size-22', '22px'],
  ['--ref-size-28', '28px'],
  ['--ref-size-32', '32px'],
  ['--ref-size-45', '45px'],
  ['--ref-size-57', '57px'],
  ['--type-display-lg', 'var(--ref-size-57)'],
  ['--type-display-sm', 'var(--ref-size-45)'],
  ['--type-headline-lg', 'var(--ref-size-32)'],
  ['--type-headline-md', 'var(--ref-size-28)'],
  ['--type-title-lg', 'var(--ref-size-22)'],
  ['--type-title-md', 'var(--ref-size-16)'],
  ['--type-title-sm', 'var(--ref-size-14)'],
  ['--type-body-lg', 'var(--ref-size-16)'],
  ['--type-body-md', 'var(--ref-size-14)'],
  ['--type-body-sm', 'var(--ref-size-12)'],
  ['--type-label-lg', 'var(--ref-size-14)'],
  ['--type-label-md', 'var(--ref-size-12)'],
  ['--type-label-sm', 'var(--ref-size-11)'],
  ['--type-line-display-lg', '64px'],
  ['--type-line-display-sm', '52px'],
  ['--type-line-headline-lg', '40px'],
  ['--type-line-headline-md', '36px'],
  ['--type-line-title-lg', '28px'],
  ['--type-line-title-md', '24px'],
  ['--type-line-title-sm', '20px'],
  ['--type-line-body-lg', '24px'],
  ['--type-line-body-md', '20px'],
  ['--type-line-body-sm', '16px'],
  ['--type-line-label-lg', '20px'],
  ['--type-line-label-md', '16px'],
  ['--type-line-label-sm', '16px'],
  ['--type-track-display-lg', '-0.25px'],
  ['--type-track-title-md', '0.15px'],
  ['--type-track-title-sm', '0.1px'],
  ['--type-track-body-lg', '0.5px'],
  ['--type-track-body-md', '0.25px'],
  ['--type-track-body-sm', '0.4px'],
  ['--type-track-label-lg', '0.1px'],
  ['--type-track-label-md', '0.5px'],
  ['--type-track-label-sm', '0.5px'],
  ['--font-weight-regular', '400'],
  ['--font-weight-medium', '500'],
  ['--font-weight-semibold', '600'],
  ['--font-sans', "'Roboto Flex', Roboto, ui-sans-serif, system-ui, sans-serif"],
  /*
    Not --font-mono. There is no vendored monospace family any more; this is a
    system stack, and it is legal in exactly two places: a fenced code block,
    and a device key or session id. Both are machine values a person copies.
  */
  ['--font-code', "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"],
])

/*
  Nothing informational may sit below 11px.

  The floor is asserted against the reference tier rather than the roles, so a
  new role cannot reach past the scale for a smaller literal, and --ref-size-11
  is the smallest step the scale is allowed to contain.
*/
for (const [name, value] of declarations) {
  if (!/^--ref-size-/.test(name)) continue
  const px = Number(value.replace('px', ''))
  if (Number.isFinite(px) && px < 11) {
    errors.push(`${name} is ${value}; 11px is the floor for anything informational`)
  }
}

/*
  The semantic type steps carry the user text-scale multiplier (WCAG 1.4.4), so
  the accepted value is either the bare reference or that reference multiplied
  by --text-scale, and nothing else. Written as an exact pair rather than a
  loose "contains" so a step still cannot drift onto a different reference, a
  hard-coded px value, or a second multiplier.
*/
const scaledTypography = (expected) => `calc(${expected} * var(--text-scale))`

for (const [name, expected] of expectedTypography) {
  const declared = declarations.get(name)
  const scalable = name.startsWith('--type-') && !name.startsWith('--type-track-')
  if (declared !== expected && !(scalable && declared === scaledTypography(expected))) {
    errors.push(`${name} must use the production typography value (${expected})`)
  }
}

const TYPE_ROLES = [
  'display-lg', 'display-sm',
  'headline-lg', 'headline-md',
  'title-lg', 'title-md', 'title-sm',
  'body-lg', 'body-md', 'body-sm',
  'label-lg', 'label-md', 'label-sm',
]

for (const role of TYPE_ROLES) {
  for (const name of [`--type-${role}`, `--type-line-${role}`]) {
    if (!tailwind.includes(`var(${name})`)) {
      errors.push(`Tailwind must consume typography token ${name}`)
    }
  }
}

for (const name of ['--font-weight-regular', '--font-weight-medium', '--font-sans', '--font-code']) {
  if (!tailwind.includes(`var(${name})`)) {
    errors.push(`Tailwind must consume typography token ${name}`)
  }
}

/*
  The scale is closed. A step outside the thirteen roles is how the old system
  grew a 9.5px eyebrow, a 10px count and a 10px chip label without anybody
  deciding to, so a --type-* token that is not one of the roles fails here.
*/
const legalTypeTokens = new Set([
  ...TYPE_ROLES.map((role) => `--type-${role}`),
  ...TYPE_ROLES.map((role) => `--type-line-${role}`),
  ...TYPE_ROLES.map((role) => `--type-track-${role}`),
])
for (const name of declarations.keys()) {
  if (name.startsWith('--type-') && !legalTypeTokens.has(name)) {
    errors.push(`${name} is not one of the thirteen M3 type roles; the scale is closed`)
  }
}

const expectedMotion = new Map([
  ['--ref-dur-50', '50ms'],
  ['--ref-dur-100', '100ms'],
  ['--ref-dur-150', '150ms'],
  ['--ref-dur-200', '200ms'],
  ['--ref-dur-250', '250ms'],
  ['--ref-dur-300', '300ms'],
  ['--ref-dur-1000', '1000ms'],
  ['--ref-dur-2000', '2000ms'],
  ['--ref-ease-out-quart', 'cubic-bezier(0.165, 0.84, 0.44, 1)'],
  ['--ref-ease-out-quint', 'cubic-bezier(0.23, 1, 0.32, 1)'],
  ['--ref-ease-in-out-cubic', 'cubic-bezier(0.645, 0.045, 0.355, 1)'],
  ['--ref-ease-hover', 'ease'],
  ['--motion-dur-none', '0ms'],
  ['--motion-dur-press', 'var(--ref-dur-50)'],
  ['--motion-dur-micro', 'var(--ref-dur-100)'],
  ['--motion-dur-fast', 'var(--ref-dur-150)'],
  ['--motion-dur-base', 'var(--ref-dur-200)'],
  ['--motion-dur-deliberate', 'var(--ref-dur-250)'],
  ['--motion-dur-maximum', 'var(--ref-dur-300)'],
  ['--motion-dur-activity', 'var(--ref-dur-1000)'],
  ['--motion-dur-highlight', 'var(--ref-dur-2000)'],
  ['--motion-ease-arrive', 'var(--ref-ease-out-quart)'],
  ['--motion-ease-emphasize', 'var(--ref-ease-out-quint)'],
  ['--motion-ease-reposition', 'var(--ref-ease-in-out-cubic)'],
  ['--motion-ease-progress', 'linear'],
  ['--motion-offset-tight', '4px'],
  ['--motion-offset-subtle', '6px'],
  ['--motion-offset-panel', '8px'],
  ['--motion-offset-dock', '20px'],
  ['--motion-scale-recede', '0.9'],
  ['--motion-scale-press', '0.96'],
  ['--motion-scale-hover', '1.04'],
])

for (const [name, expected] of expectedMotion) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must use the researched motion value (${expected})`)
  }
}

if (globals.includes('--ease-spring')) {
  errors.push('globals.css must not restore the overshooting --ease-spring token')
}

if (globals.includes('--animation-pulse-soft') || tailwind.includes('pulseSoft')) {
  errors.push('Party Response must not restore the indefinite pulse animation')
}

for (const requiredRule of [
  "font-feature-settings: 'liga' 1, 'calt' 1",
  'font-optical-sizing: auto',
  'font-family: var(--font-code)',
  "font-feature-settings: 'tnum' 1, 'calt' 1",
  'outline: 2px solid var(--border-focus)',
  'outline-offset: 2px',
]) {
  if (!globals.includes(requiredRule)) {
    errors.push(`globals.css must include ${requiredRule}`)
  }
}

/*
  One vendored family. Inter, IBM Plex Mono and Spline Sans are all gone: every
  UI role is Roboto Flex, and the only monospace left is a system stack behind
  --font-code, which ships no bytes.

  "Locally" is the load-bearing word rather than any particular directory. Mesh
  is a Tauri binary that has to render with no network, so the face is resolved
  out of the installed dependency tree at build time and emitted into dist/. It
  is not fetched from a font host, which is what the last assertion here is
  for -- and keeping it a tracked dependency is also what keeps its OFL notice
  in the generated THIRD_PARTY_NOTICES.md instead of hand-maintained.
*/
for (const retiredFamily of ['Spline Sans', 'Inter Variable', 'IBM Plex Mono']) {
  if (globals.includes(retiredFamily)) {
    errors.push(`globals.css must not restore ${retiredFamily}; Material 3 Expressive ships one family`)
  }
}

for (const fontAsset of [
  '@fontsource-variable/roboto-flex/files/roboto-flex-latin-opsz-normal.woff2',
]) {
  if (!globals.includes(fontAsset)) {
    errors.push(`globals.css must load the local ${fontAsset} font asset`)
  }
}

if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(globals) || /fonts\.googleapis\.com/.test(main)) {
  errors.push('the renderer must not fetch a font from a remote host; Mesh has to render offline')
}

if (/@fontsource/.test(main)) {
  errors.push('src/main.tsx must not duplicate a font asset owned by globals.css')
}

/*
  The shape scale, asserted by value.

  Everything you touch has a radius, and the scale is the system: there is no
  0px structural plane left for an active row or a chip to fall back to.
  --shape-none is the single exception and exists only for full-bleed media
  clipped by an ancestor that carries its own radius, which is why it is the
  only entry here allowed to be zero.
*/
const expectedShapeScale = new Map([
  ['--shape-none', '0'],
  ['--shape-xs', '4px'],
  ['--shape-sm', '8px'],
  ['--shape-md', '12px'],
  ['--shape-lg', '16px'],
  ['--shape-lg-inc', '20px'],
  ['--shape-xl', '28px'],
  ['--shape-xl-inc', '32px'],
  ['--shape-full', '100px'],
])

for (const [name, expected] of expectedShapeScale) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must use the approved Material 3 shape value (${expected})`)
  }
}

for (const [name, value] of expectedShapeScale) {
  if (name === '--shape-none') continue
  if (declarations.get(name) === '0' || declarations.get(name) === '0px') {
    errors.push(`${name} is zero; only --shape-none may be, and only for full-bleed media (${value})`)
  }
}

/*
  The elevation ladder.

  Level 0 is `none` and is what everything in normal document flow uses. Tone
  and shape carry structure now, so a shadow on a pane, a card, a list row or a
  message bubble is a regression to a system this contract replaced, not a
  refinement of it. The five lifted steps exist for things that are genuinely
  above the page.
*/
const expectedElevation = new Map([
  ['--elev-0', 'none'],
  ['--elev-1', '0 1px 2px rgb(0 0 0 / .40), 0 1px 3px 1px rgb(0 0 0 / .28)'],
  ['--elev-2', '0 1px 2px rgb(0 0 0 / .40), 0 2px 6px 2px rgb(0 0 0 / .28)'],
  ['--elev-3', '0 1px 3px rgb(0 0 0 / .45), 0 4px 8px 3px rgb(0 0 0 / .30)'],
  ['--elev-4', '0 2px 3px rgb(0 0 0 / .45), 0 6px 10px 4px rgb(0 0 0 / .30)'],
  ['--elev-5', '0 4px 4px rgb(0 0 0 / .45), 0 8px 12px 6px rgb(0 0 0 / .30)'],
])

for (const [name, expected] of expectedElevation) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must use the approved Material 3 elevation value (${expected})`)
  }
}

/*
  Shell geometry, asserted by value.

  Every pane is a 28px rounded surface inset by --shell-pane-gap from the
  window and from its neighbours, so the rule widths, the gutters and the
  columns the old shell measured its hairlines with are all gone: there is no
  shared edge left to draw, no row-number gutter, and no message time column.
*/
const expectedShellGeometry = new Map([
  ['--shape-round', '50%'],
  ['--border-width-status', '1px'],
  ['--shell-rail-width', '88px'],
  ['--shell-list-width', '340px'],
  ['--shell-roster-width', '400px'],
  ['--shell-pane-gap', '12px'],
  ['--shell-pane-radius', 'var(--shape-xl)'],
  ['--shell-header-height', '64px'],
  ['--shell-pin-height', '40px'],
  ['--shell-composer-height', '46px'],
  ['--shell-strip-height', '60px'],
  ['--shell-media-max-height', '274px'],
  ['--shell-channel-row-height', '56px'],
  ['--shell-occupant-row-height', '72px'],
  ['--shell-message-padding-block', '4px'],
  ['--shell-message-measure', '65ch'],
  ['--shell-media-max-width', '960px'],
  ['--shell-bubble-measure', '62%'],
  ['--command-band-padding', '60px'],
  ['--route-surface-columns', 'var(--shell-list-width) minmax(0, 1fr)'],
  ['--device-code-columns', '7rem 1fr'],
  ['--invitation-confirmation-columns', 'minmax(0, 1.15fr) minmax(18rem, 0.85fr)'],
])

for (const [name, expected] of expectedShellGeometry) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must use the approved Material 3 foundation value (${expected})`)
  }
}

for (const variable of [
  '--shell-rail-width',
  '--shell-list-width',
  '--shell-roster-width',
  '--shell-pane-gap',
  '--shell-header-height',
  '--shell-pin-height',
  '--shell-composer-height',
  '--shell-strip-height',
  '--shell-media-max-height',
  '--shell-channel-row-height',
  '--shell-occupant-row-height',
  '--shell-message-padding-block',
]) {
  if (!tailwind.includes(`var(${variable})`)) {
    errors.push(`Tailwind must expose Material 3 geometry token ${variable}`)
  }
}

/*
  Retired shell measurements. Each of these measured something the shell no
  longer draws: a hairline, the gutter a row number sat in, the fixed column a
  timestamp sat in, the trust rail, or the 3px inset marker the rail slot used
  before the selection pill replaced it.
*/
for (const retired of [
  '--rule-width',
  '--trust-rail-width',
  '--row-index-width',
  '--message-time-width',
  '--message-rail-gap',
  '--message-gutter',
  '--community-marker',
  '--rail-unread-marker-height',
  '--shell-channel-width',
  '--shell-conversation-padding',
  '--conversation-title-padding-top',
  '--conversation-title-padding-bottom',
  '--conversation-title-padding-compact',
  '--settings-layout-columns',
]) {
  if (declarations.has(retired)) {
    errors.push(`${retired} measures something this contract no longer draws; delete it`)
  }
}

/*
  The Discord-era CSS compatibility aliases are gone.

  All fifteen pointed at semantic names this contract retires, and fourteen of
  them had no call site left at all. An alias nothing consumes is not
  compatibility, it is a second name for a token that can drift away from the
  first one unnoticed.
*/
for (const retiredAlias of [
  '--bg-tertiary', '--bg-secondary', '--bg-primary',
  '--bg-modifier-hover', '--bg-modifier-active', '--bg-modifier-selected', '--bg-floating',
  '--text-primary', '--text-secondary', '--text-muted', '--text-link',
  '--green', '--red', '--yellow', '--blue',
]) {
  if (declarations.has(retiredAlias)) {
    errors.push(`${retiredAlias} is a retired compatibility alias; consume the semantic role directly`)
  }
}

const colorReferences = [...tailwind.matchAll(/withAlpha\('(--[\w-]+)'\)/g)]
if (colorReferences.length < 25) {
  errors.push('Tailwind colors must use the CSS-variable-aware withAlpha helper')
}
for (const [, variable] of colorReferences) {
  if (!variable.endsWith('-rgb')) {
    errors.push(`Tailwind color ${variable} must reference RGB channels for opacity support`)
  }
  if (!declarations.has(variable)) {
    errors.push(`Tailwind references missing CSS token ${variable}`)
  }
}

const requiredVariableBackedValues = [
  '--font-sans',
  '--font-code',
  '--type-label-sm',
  '--type-display-lg',
  '--shape-sm',
  '--shape-xl',
  '--shape-full',
  '--elev-0',
  '--elev-3',
  '--z-dropdown',
  '--z-modal',
  '--motion-dur-micro',
  '--motion-dur-deliberate',
  '--motion-ease-arrive',
  '--motion-ease-reposition',
  '--ref-ease-hover',
  '--density-row-block',
  '--density-control-lg',
  '--route-surface-columns',
  '--device-code-columns',
  '--invitation-confirmation-columns',
]

for (const variable of requiredVariableBackedValues) {
  if (!tailwind.includes(`var(${variable})`)) {
    errors.push(`Tailwind must consume ${variable} from globals.css`)
  }
  if (!declarations.has(variable)) {
    errors.push(`globals.css must define ${variable}`)
  }
}

const requiredSemanticColorChannels = [
  '--surface-rgb',
  '--surface-container-lowest-rgb',
  '--surface-container-low-rgb',
  '--surface-container-rgb',
  '--surface-container-high-rgb',
  '--surface-container-highest-rgb',
  '--on-surface-rgb',
  '--on-surface-variant-rgb',
  '--outline-rgb',
  '--outline-variant-rgb',
  '--primary-rgb',
  '--on-primary-rgb',
  '--primary-container-rgb',
  '--on-primary-container-rgb',
  '--secondary-container-rgb',
  '--on-secondary-container-rgb',
  '--error-rgb',
  '--on-error-rgb',
  '--error-container-rgb',
  '--on-error-container-rgb',
  '--marker-rgb',
  '--on-marker-rgb',
  '--marker-container-rgb',
  '--on-marker-container-rgb',
]

for (const variable of requiredSemanticColorChannels) {
  if (!tailwind.includes(`'${variable}'`)) {
    errors.push(`Tailwind must expose semantic color channel ${variable}`)
  }
  if (!declarations.has(variable)) {
    errors.push(`globals.css must define semantic color channel ${variable}`)
  }
}

if (declarations.get('--surface-asset-preview') !== 'var(--ref-black)') {
  errors.push('--surface-asset-preview must use the black reference token')
}
if (!globals.includes('.mesh-asset-preview') || !globals.includes('background-color: var(--surface-asset-preview)')) {
  errors.push('The asset preview class must consume --surface-asset-preview')
}

/*
  The M3 tonal role pairs.

  The old six-role container quintuple named four strengths of the same fill
  per role, which is twelve authors guessing at an intensity. A tonal container
  is one value with one legible foreground, and interaction on top of it is a
  state layer rather than a second, third and fourth container token.
*/
const containerRoles = ['primary', 'secondary', 'error', 'marker']
for (const role of containerRoles) {
  for (const variable of [`--${role}-container`, `--on-${role}-container`]) {
    if (!declarations.has(variable)) {
      errors.push(`globals.css must define tonal role ${variable}`)
    }
    if (!tailwind.includes(`var(${variable})`) && !tailwind.includes(`'${variable}-rgb'`)) {
      errors.push(`Tailwind must expose tonal role ${variable}`)
    }
  }
}

for (const tone of SURFACE_TONES) {
  if (!tailwind.includes(`'${tone}-rgb'`)) {
    errors.push(`Tailwind must expose surface tone ${tone}`)
  }
}

if (!globals.includes('@supports (color: color-mix(in oklch, white, black))')) {
  errors.push('globals.css must derive supported container states in perceptual OKLCH')
}

/*
 * Contrast is measured, not asserted against literals.
 *
 * This check used to compare sixteen hex pairs typed into this script. Three
 * of the foregrounds — #1f6f43, #855b08, #a3313a — were not in globals.css at
 * all; the shipped tokens are #237548, #815900 and #b4232a. Those assertions
 * had been passing against colours Mesh does not ship, which is the one thing
 * a drift gate exists to prevent. The light backgrounds were wrong the same
 * way: the canvas is #F7F6F2, not #ffffff.
 *
 * check-container-contrast.mjs resolves every pair out of this stylesheet
 * instead, following var() chains through the theme blocks, so a token can
 * only be checked against the value it actually has. It also covers
 * --content-link, whose absence from the old list is why a 2.00:1 link colour
 * shipped, and the five container lines, which nothing measured at all.
 */
/*
 * The reduced-motion contract.
 *
 * globals.css does something no other client in the category does: it knows
 * that killing `animate-spin` turns a status indicator into decoration, so it
 * swaps continuous movement for a discrete three-step tick that still
 * advances. Nothing protected that. It was also expressed twice — once for the
 * OS media query, once for the in-app attribute — and the two copies did not
 * agree, so a person who asked for reduced motion got different behaviour
 * depending on where they asked.
 *
 * `applyAppearancePreferences` now ORs the two into `data-reduce-motion`
 * before the first render, and these four rules keep it that way.
 */
const reducedMotionBlocks = collectRuleBlocks(globals)
  .filter((block) => block.selector.includes("[data-reduce-motion='true']"))

const blanketMotionRule = reducedMotionBlocks
  .find((block) => /\*$/.test(block.selector.split(',')[0].trim()))

if (!blanketMotionRule) {
  errors.push(
    "globals.css must carry a blanket rule under html[data-reduce-motion='true'] that removes movement",
  )
} else if (/transition\s*:\s*none/.test(blanketMotionRule.body)) {
  errors.push(
    'the reduced-motion blanket rule uses `transition: none`, which deletes cross-fades along with '
    + 'movement and overrides the per-component motion-reduce variants that ask to keep them. '
    + 'Name the properties that may still change instead.',
  )
} else if (!/transition-property\s*:[^;]*\bopacity\b/.test(blanketMotionRule.body)) {
  errors.push(
    'the reduced-motion blanket rule must allow opacity through transition-property; a cross-fade '
    + 'is not movement',
  )
} else if (/transition-property\s*:[^;]*\b(?:transform|translate|rotate|scale|all)\b/.test(blanketMotionRule.body)) {
  errors.push('the reduced-motion transition-property allowlist must not carry a movement property')
}

/*
 * The blanket rule collapses every animation to `animation-duration: 0.01ms`
 * and `animation-iteration-count: 1`, both !important. A bounded-progress
 * indicator has to take those two back by name, at the same weight, or it
 * renders as a frozen glyph: still on screen, no longer saying anything.
 */
for (const indicator of ['mesh-progress-step', 'mesh-async-tick']) {
  const reentry = reducedMotionBlocks.find((block) => block.body.includes(indicator))
  if (!reentry) {
    errors.push(
      `globals.css must keep the ${indicator} indicator running under reduced motion; a process `
      + 'indicator may not disappear merely because duration is reduced',
    )
    continue
  }
  for (const property of ['animation-duration', 'animation-iteration-count']) {
    const declared = new RegExp(`${property}\\s*:[^;]*!important`).test(reentry.body)
    if (!declared) {
      errors.push(
        `the ${indicator} re-entry must restate ${property} as !important, or the blanket `
        + 'reduced-motion rule wins and the indicator stops advancing',
      )
    }
  }
}

/*
 * One mechanism. The only `@media (prefers-reduced-motion: reduce)` rule left
 * is the pre-hydration net, and it is scoped so it cannot contradict the
 * resolved attribute once the store module has written it.
 */
for (const block of collectRuleBlocks(globals)) {
  if (!block.guard.some((guard) => guard.includes('prefers-reduced-motion: reduce'))) continue
  if (block.selector.startsWith('html:not([data-reduce-motion])')) continue
  errors.push(
    `globals.css styles \`${block.selector}\` from a prefers-reduced-motion media query. Reduced `
    + "motion resolves to html[data-reduce-motion='true'] in applyAppearancePreferences; only the "
    + 'html:not([data-reduce-motion]) pre-hydration net may key off the media query.',
  )
}

for (const problem of findBranchDisagreements(globals)) {
  errors.push(`${problem.theme} theme: ${problem.token} — ${problem.reason}`)
}
for (const failure of findContainerLineFailures(globals)) {
  errors.push(
    `${failure.theme} theme: ${failure.token} on ${failure.backdrop} `
    + `(${failure.branch} branch) ${failure.reason}`,
  )
}
for (const failure of findTextContrastFailures(globals)) {
  errors.push(
    `${failure.theme} theme: ${failure.label} — ${failure.foregroundToken} on `
    + `${failure.backgroundToken} ${failure.reason}`,
  )
}

for (const variable of [
  '--motion-offset-tight',
  '--motion-offset-subtle',
  '--motion-offset-panel',
  '--motion-offset-dock',
  '--motion-scale-recede',
  '--motion-scale-press',
  '--motion-scale-hover',
]) {
  if (!motion.includes(`getPropertyValue('${variable}')`)) {
    errors.push(`src/lib/motion.ts must consume ${variable} from globals.css`)
  }
}

for (const selector of [
  ":root[data-theme='dark']",
  ":root[data-theme='light']",
  ":root[data-theme='high-contrast']",
  ":root[data-accent='sand']",
  ":root[data-accent='ocean']",
  ":root[data-accent='violet']",
  ":root[data-accent='forest']",
  ":root[data-accent='ember']",
  ":root[data-accent='rose']",
  ":root[data-density='compact']",
  ":root[data-density='default']",
  ":root[data-density='comfortable']",
]) {
  if (!globals.includes(selector)) {
    errors.push(`globals.css must define ${selector}`)
  }
}

async function componentSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return componentSourceFiles(entryPath)
    if (
      entry.isFile()
      && /\.(?:ts|tsx)$/.test(entry.name)
      && !/\.test\.(?:ts|tsx)$/.test(entry.name)
    ) {
      return [entryPath]
    }
    return []
  }))
  return nested.flat()
}

const componentViolations = []
for (const filePath of await componentSourceFiles(componentsPath)) {
  const relativePath = path.relative(root, filePath).replaceAll('\\', '/')
  const source = await readFile(filePath, 'utf8')
  for (const violation of visualViolations(source)) {
    componentViolations.push({ relativePath, ...violation })
  }
  for (const token of hardcodedMotionViolations(source)) {
    componentViolations.push({
      relativePath,
      kind: 'hardcoded Framer Motion value',
      token,
    })
  }
}

for (const violation of componentViolations) {
  errors.push(`${violation.relativePath} contains ${violation.kind}: ${violation.token}`)
}

/*
 * ---------------------------------------------------------------------------
 * Pass: every class token must resolve against the compiled Tailwind surface
 * ---------------------------------------------------------------------------
 *
 * An undefined utility is not an error at build time, at type-check time, or at
 * runtime: Tailwind simply emits nothing and the element keeps the inherited
 * value. That is how `tracking-section`, `tracking-signal`, `tracking-control`,
 * `tracking-status`, `text-body` and `animate-in` shipped across twenty-six
 * call sites while every check passed.
 *
 * The resolver is built from tailwind.config.ts itself plus the default keys
 * Tailwind keeps under `extend`, so adding a theme key is all it takes to make
 * a new utility legal. Anything that cannot be resolved statically is skipped
 * rather than guessed at, and the skip counts are printed.
 */

function objectBlock(source, key) {
  const start = source.indexOf(`${key}: {`)
  if (start === -1) return null
  let depth = 0
  for (let index = start + key.length + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

function blockKeys(block) {
  if (!block) return []
  const names = []
  const stack = []
  for (const rawLine of block.split(/\r?\n/).slice(1)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    const group = line.match(/^'?([\w-]+)'?\s*:\s*\{$/)
    if (group) {
      stack.push(group[1])
      continue
    }
    if (/^\},?$/.test(line)) {
      stack.pop()
      continue
    }
    const entry = line.match(/^'?([\w-]+)'?\s*:/)
    if (!entry) continue
    const parts = entry[1] === 'DEFAULT' ? [...stack] : [...stack, entry[1]]
    if (parts.length > 0) names.push(parts.join('-'))
  }
  return names
}

const themeKeys = (key) => new Set(blockKeys(objectBlock(tailwind, key)))

const configuredColors = themeKeys('colors')
const configuredSections = {
  letterSpacing: themeKeys('letterSpacing'),
  lineHeight: themeKeys('lineHeight'),
  fontSize: themeKeys('fontSize'),
  fontFamily: themeKeys('fontFamily'),
  fontWeight: themeKeys('fontWeight'),
  borderRadius: themeKeys('borderRadius'),
  borderWidth: themeKeys('borderWidth'),
  spacing: themeKeys('spacing'),
  width: themeKeys('width'),
  height: themeKeys('height'),
  minWidth: themeKeys('minWidth'),
  minHeight: themeKeys('minHeight'),
  maxWidth: themeKeys('maxWidth'),
  maxHeight: themeKeys('maxHeight'),
  zIndex: themeKeys('zIndex'),
  transitionDuration: themeKeys('transitionDuration'),
  transitionTimingFunction: themeKeys('transitionTimingFunction'),
  animation: themeKeys('animation'),
  boxShadow: themeKeys('boxShadow'),
  gridTemplateColumns: themeKeys('gridTemplateColumns'),
  gridAutoRows: themeKeys('gridAutoRows'),
}

// Tailwind keeps its own keys under `extend`, so these stay legal too.
const CORE_PALETTE = /^(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|\d{3})$/
const CORE_COLOR_KEYWORDS = ['inherit', 'current', 'transparent', 'black', 'white']
const CORE_SIZE_KEYWORDS = ['auto', 'full', 'screen', 'min', 'max', 'fit', 'px', 'svh', 'lvh', 'dvh', 'svw', 'lvw', 'dvw', 'none']
const CORE_MAX_WIDTHS = ['0', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', 'prose', 'screen-sm', 'screen-md', 'screen-lg', 'screen-xl', 'screen-2xl']

const classNamespaces = [
  {
    prefixes: ['tracking'],
    label: 'letter spacing',
    sections: ['letterSpacing'],
    keywords: ['tighter', 'tight', 'normal', 'wide', 'wider', 'widest'],
  },
  {
    prefixes: ['leading'],
    label: 'line height',
    sections: ['lineHeight'],
    keywords: ['none', 'tight', 'snug', 'normal', 'relaxed', 'loose'],
  },
  {
    prefixes: ['animate'],
    label: 'animation',
    sections: ['animation'],
    keywords: ['none', 'spin', 'ping', 'pulse', 'bounce'],
  },
  {
    prefixes: ['duration'],
    label: 'transition duration',
    sections: ['transitionDuration'],
    keywords: [],
  },
  {
    prefixes: ['ease'],
    label: 'transition timing',
    sections: ['transitionTimingFunction'],
    keywords: ['linear', 'in', 'out', 'in-out', 'initial'],
  },
  {
    prefixes: ['z'],
    label: 'z index',
    sections: ['zIndex'],
    keywords: ['auto'],
  },
  {
    prefixes: ['shadow'],
    label: 'box shadow',
    sections: ['boxShadow'],
    keywords: ['none', 'inner', 'sm', 'md', 'lg', 'xl', '2xl'],
    colors: true,
  },
  {
    prefixes: ['font'],
    label: 'font family or weight',
    sections: ['fontFamily', 'fontWeight'],
    keywords: ['sans', 'serif', 'mono', 'thin', 'extralight', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black'],
  },
  {
    prefixes: ['rounded', 'rounded-t', 'rounded-r', 'rounded-b', 'rounded-l', 'rounded-s', 'rounded-e', 'rounded-tl', 'rounded-tr', 'rounded-br', 'rounded-bl'],
    label: 'border radius',
    sections: ['borderRadius'],
    keywords: ['none', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full'],
  },
  {
    prefixes: ['text'],
    label: 'font size or text color',
    sections: ['fontSize'],
    colors: true,
    keywords: [
      'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
      'left', 'center', 'right', 'justify', 'start', 'end',
      'wrap', 'nowrap', 'balance', 'pretty', 'ellipsis', 'clip',
    ],
  },
  {
    prefixes: ['bg'],
    label: 'background',
    colors: true,
    keywords: [
      'fixed', 'local', 'scroll', 'clip-border', 'clip-padding', 'clip-content', 'clip-text',
      'bottom', 'center', 'left', 'left-bottom', 'left-top', 'right', 'right-bottom', 'right-top', 'top',
      'repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'repeat-round', 'repeat-space',
      'auto', 'cover', 'contain', 'none',
      'origin-border', 'origin-padding', 'origin-content',
      'gradient-to-t', 'gradient-to-tr', 'gradient-to-r', 'gradient-to-br',
      'gradient-to-b', 'gradient-to-bl', 'gradient-to-l', 'gradient-to-tl',
      'blend-normal', 'blend-multiply', 'blend-screen', 'blend-overlay', 'blend-darken', 'blend-lighten',
    ],
  },
  {
    prefixes: ['border', 'border-x', 'border-y', 'border-t', 'border-r', 'border-b', 'border-l', 'border-s', 'border-e'],
    label: 'border color or width',
    sections: ['borderWidth'],
    colors: true,
    keywords: [
      'solid', 'dashed', 'dotted', 'double', 'hidden', 'none', 'collapse', 'separate',
      // Bare side utilities: `border-b` is a 1px bottom border, not a color.
      'x', 'y', 't', 'r', 'b', 'l', 's', 'e',
    ],
  },
  {
    prefixes: ['fill', 'stroke', 'caret', 'accent', 'decoration', 'placeholder', 'from', 'via', 'to', 'divide', 'outline', 'ring'],
    label: 'color',
    colors: true,
    keywords: [
      'none', 'auto', 'inset', 'dashed', 'dotted', 'solid', 'double', 'wavy',
      'x', 'y', 'reverse',
      // outline-offset and ring-offset take the spacing scale.
      'offset-0', 'offset-1', 'offset-2', 'offset-4', 'offset-8',
      'through', 'line-through', 'clone', 'slice',
    ],
  },
  {
    prefixes: ['w'],
    label: 'width',
    sections: ['spacing', 'width'],
    keywords: [...CORE_SIZE_KEYWORDS],
  },
  {
    prefixes: ['h'],
    label: 'height',
    sections: ['spacing', 'height'],
    keywords: [...CORE_SIZE_KEYWORDS],
  },
  {
    prefixes: ['min-w'],
    label: 'minimum width',
    sections: ['spacing', 'minWidth'],
    keywords: [...CORE_SIZE_KEYWORDS],
  },
  {
    prefixes: ['min-h'],
    label: 'minimum height',
    sections: ['spacing', 'minHeight'],
    keywords: [...CORE_SIZE_KEYWORDS],
  },
  {
    prefixes: ['max-w'],
    label: 'maximum width',
    sections: ['spacing', 'maxWidth'],
    keywords: [...CORE_SIZE_KEYWORDS, ...CORE_MAX_WIDTHS],
  },
  {
    prefixes: ['max-h'],
    label: 'maximum height',
    sections: ['spacing', 'maxHeight'],
    keywords: [...CORE_SIZE_KEYWORDS],
  },
  {
    prefixes: ['grid-cols'],
    label: 'grid template',
    sections: ['gridTemplateColumns'],
    keywords: ['none', 'subgrid'],
  },
  {
    prefixes: ['auto-rows'],
    label: 'grid auto rows',
    sections: ['gridAutoRows'],
    keywords: ['auto', 'min', 'max', 'fr'],
  },
]

const namespaceByPrefix = new Map()
for (const namespace of classNamespaces) {
  for (const prefix of namespace.prefixes) namespaceByPrefix.set(prefix, namespace)
}

function resolvesUtility(namespace, value) {
  if (/^\d+(?:\.\d+)?(?:\/\d+)?$/.test(value)) return true
  if (namespace.keywords.includes(value)) return true
  for (const section of namespace.sections ?? []) {
    if (configuredSections[section]?.has(value)) return true
  }
  if (namespace.colors) {
    if (configuredColors.has(value)) return true
    if (CORE_COLOR_KEYWORDS.includes(value)) return true
    if (CORE_PALETTE.test(value)) return true
    if (/^opacity-\d+$/.test(value)) return true
  }
  return false
}

/*
 * Class strings are read out of the source rather than parsed as TypeScript,
 * so the scanner has to know where a literal ends and an interpolation begins.
 * A chunk that touches `${` on either side has a partial token at that edge,
 * and partial tokens are skipped instead of reported.
 */
function classChunks(source) {
  const chunks = []
  let index = 0
  const readString = (quote) => {
    let text = ''
    index += 1
    while (index < source.length) {
      const character = source[index]
      if (character === '\\') {
        text += source.slice(index, index + 2)
        index += 2
        continue
      }
      if (character === quote) {
        index += 1
        return text
      }
      text += character
      index += 1
    }
    return text
  }

  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end + 1
      continue
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (character === '"' || character === "'") {
      chunks.push({ text: readString(character), openLeft: false, openRight: false })
      continue
    }
    if (character === '`') {
      index += 1
      let text = ''
      let openLeft = false
      while (index < source.length) {
        const current = source[index]
        if (current === '\\') {
          text += source.slice(index, index + 2)
          index += 2
          continue
        }
        if (current === '$' && source[index + 1] === '{') {
          chunks.push({ text, openLeft, openRight: true })
          text = ''
          openLeft = true
          let depth = 0
          const start = index + 2
          index += 2
          while (index < source.length) {
            const inner = source[index]
            if (inner === '{') depth += 1
            else if (inner === '}') {
              if (depth === 0) break
              depth -= 1
            } else if (inner === '"' || inner === "'" || inner === '`') {
              const quote = inner
              index += 1
              while (index < source.length && source[index] !== quote) {
                index += source[index] === '\\' ? 2 : 1
              }
            }
            index += 1
          }
          chunks.push(...classChunks(source.slice(start, index)))
          index += 1
          continue
        }
        if (current === '`') {
          chunks.push({ text, openLeft, openRight: false })
          index += 1
          break
        }
        text += current
        index += 1
      }
      continue
    }
    index += 1
  }
  return chunks
}

const utilitySkips = { interpolated: 0, arbitrary: 0, outsideNamespace: 0 }

function unknownUtilityViolations(source) {
  const violations = []
  for (const chunk of classChunks(source)) {
    const pieces = chunk.text.split(/\s+/)
    pieces.forEach((raw, position) => {
      if (!raw) return
      const partialLeft = chunk.openLeft && position === 0 && !/^\s/.test(chunk.text)
      const partialRight = chunk.openRight && position === pieces.length - 1 && !/\s$/.test(chunk.text)
      if (partialLeft || partialRight) {
        utilitySkips.interpolated += 1
        return
      }
      if (raw.includes('[')) {
        utilitySkips.arbitrary += 1
        return
      }
      if (!/^-?!?[a-z][a-z0-9-]*(?::-?!?[a-z][a-z0-9-]*)*(?:\/\d{1,3})?$/.test(raw)) return
      const variantless = raw.slice(raw.lastIndexOf(':') + 1).replace(/^[-!]+/, '').replace(/\/\d{1,3}$/, '')
      const separator = variantless.indexOf('-')
      if (separator === -1) return
      let namespace = null
      let value = ''
      // Longest matching prefix wins, so `min-h` beats a bare `min`.
      for (let cut = variantless.lastIndexOf('-'); cut > 0; cut = variantless.lastIndexOf('-', cut - 1)) {
        const candidate = namespaceByPrefix.get(variantless.slice(0, cut))
        if (candidate) {
          namespace = candidate
          value = variantless.slice(cut + 1)
          break
        }
      }
      if (!namespace) {
        utilitySkips.outsideNamespace += 1
        return
      }
      if (resolvesUtility(namespace, value)) return
      violations.push({ token: variantless, label: namespace.label, value })
    })
  }
  return violations
}

/*
 * Rule: an opacity modifier on a status or accent utility.
 *
 * Twelve strengths of the same idea (`bg-status-warning/5 /10 /15 /20 /25 /80`,
 * `border-status-warning/20 /30 /40 /50 /60`) is not a palette, it is twelve
 * authors guessing. The container quintuples already name every strength these
 * surfaces need.
 *
 * All 210 call sites are converted, so this is enforced rather than reported.
 * Fills resting at 5-20% became `container-<tone>`, their `hover:` faces became
 * `container-<tone>-hover`, and every border and ring between 20% and 60%
 * became `container-<tone>-line`. Two `hover:bg-status-info/80` and `/90` were
 * not notices at all but the darker face of a solid button, and took the
 * `status-info-hover` token that already existed for exactly that. One site
 * kept a distinction the mapping would have flattened: a mention of *you*
 * renders a stronger fill than a mention of somebody else, so it holds
 * `container-accent-active` against the other's `container-accent`.
 */
const ENFORCE_NOTICE_INTENSITY = true
/*
 * Off by default. Porting this check against Quiet Structure's own
 * hand-authored globals.css (screens the Quiet Structure pass never touched --
 * invite, diagnostics, security, feedback) surfaces roughly fifteen
 * pre-existing cancelling rules that predate this checker and predate this
 * merge. They are real (verified: .mesh-invite-section zeroes the border,
 * background, and padding that InviteModal.tsx declares at its second call
 * site), but fixing them is a dedicated cleanup pass, not a merge-conflict
 * side effect. Warn for now; flip to true once that pass lands.
 */
const ENFORCE_CLASS_LIST_TRUTH = false
const statusOpacityExpression = /\b(?:bg|text|border|border-[xytrbl]|ring|fill|stroke|outline|divide|from|via|to|shadow|caret|decoration|placeholder)-(?:on-)?(?:primary|error|marker)(?:-container)?\/\d{1,3}\b/g

function statusOpacityViolations(source) {
  const violations = []
  statusOpacityExpression.lastIndex = 0
  for (const match of source.matchAll(statusOpacityExpression)) {
    violations.push({
      token: match[0],
      line: source.slice(0, match.index).split('\n').length,
    })
  }
  return violations
}

/*
 * Rule: a fixed-rem line-height (leading-3..leading-10) on an element that
 * also carries a font-size token.
 *
 * Every size step in tailwind.config.ts ships its own density-aware leading
 * (line-height-11..28) — some as unitless ratios that scale with the size,
 * some as px that grow on high-density displays. Tailwind's numeric leading-*
 * utilities are fixed rem: leading-5 is 20px whatever the font or the display.
 * Pairing one with a size token overrides the contracted leading with a value
 * that ignores the density system, so 12px body copy ships at 1.67 on a normal
 * display and 1.43 on a 4K one against a contracted 1.33. Semantic ratio
 * leadings (none/tight/snug/prose) are unitless, scale with the size, and are a
 * deliberate typographic tool, so they are not flagged.
 */
const FONT_SIZE_CLASSES = new Set(
  [
    // The thirteen M3 roles. Each ships its own density-aware leading, so a
    // fixed-rem leading-* utility beside one of these overrides the contracted
    // line-height with a value that ignores the density system.
    'display-lg', 'display-sm',
    'headline-lg', 'headline-md',
    'title-lg', 'title-md', 'title-sm',
    'body-lg', 'body-md', 'body-sm',
    'label-lg', 'label-md', 'label-sm',
  ].map((token) => `text-${token}`),
)

const fixedLeadingClass = /^leading-(?:3|4|5|6|7|8|9|10)$/

function contractedLeadingViolations(source) {
  const violations = []
  for (const chunk of classChunks(source)) {
    // Strip variant prefixes (`sm:`, `motion-safe:`) and any `-`/`!` markers,
    // the same normalization unknownUtilityViolations applies.
    const pieces = chunk.text
      .split(/\s+/)
      .filter(Boolean)
      .map((raw) => raw.slice(raw.lastIndexOf(':') + 1).replace(/^[-!]+/, ''))
    if (!pieces.some((piece) => FONT_SIZE_CLASSES.has(piece))) continue
    for (const piece of pieces) {
      if (!fixedLeadingClass.test(piece)) continue
      const at = source.indexOf(piece)
      violations.push({
        token: piece,
        line: at === -1 ? 0 : source.slice(0, at).split('\n').length,
      })
    }
  }
  return violations
}

// Self-tests. `animate-in` is the real defect that motivated the pass: it needs
// a plugin the project does not depend on, and it compiled to nothing.
if (
  unknownUtilityViolations("'tracking-nonsense text-nonsense animate-in rounded-nonsense'").length !== 4
  || unknownUtilityViolations("'tracking-label-md text-body-lg animate-spin rounded-xl bg-primary-container'").length !== 0
  || unknownUtilityViolations('`text-${size} h-4`').length !== 0
  || statusOpacityViolations("'bg-error/20 border-primary/50 bg-surface-container/50'").length !== 2
  || contractedLeadingViolations("'mt-1 text-body-sm leading-5 text-on-surface-variant'").length !== 1
  || contractedLeadingViolations("'text-body-lg leading-prose text-on-surface'").length !== 0
  || contractedLeadingViolations("'text-title-sm leading-none'").length !== 0
  || contractedLeadingViolations("'leading-5 text-on-surface'").length !== 0
) {
  throw new Error('Design-token class resolution self-test failed')
}

async function renderedSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return renderedSourceFiles(entryPath)
    if (entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      return [entryPath]
    }
    return []
  }))
  return nested.flat()
}

/*
 * No accepted exceptions: the pass fails hard on every unresolved utility.
 *
 * The last entry was `text-section-title` in InviteModal, which is not a step
 * on the closed type scale. That call site now reads `text-md`, the 18px
 * section-heading step it was reaching for. Add an entry here only with a
 * named owner and the edit that will retire it.
 */
const KNOWN_UNRESOLVED_UTILITIES = new Set([])
const unusedKnownUtilities = new Set(KNOWN_UNRESOLVED_UTILITIES)

const noticeIntensityWarnings = []
let scannedRenderedFiles = 0
const declaredMeshClassLists = new Map()
for (const filePath of await renderedSourceFiles(path.join(root, 'src'))) {
  const relativePath = path.relative(root, filePath).replaceAll('\\', '/')
  const source = await readFile(filePath, 'utf8')
  scannedRenderedFiles += 1
  for (const [, quoted, templated] of source.matchAll(/class(?:Name)?=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const classes = (quoted ?? templated ?? '').split(/\s+/).filter(Boolean)
    for (const name of classes) {
      if (!name.startsWith('mesh-')) continue
      const lists = declaredMeshClassLists.get(name) ?? []
      lists.push(` ${classes.join(' ')} `)
      declaredMeshClassLists.set(name, lists)
    }
  }
  for (const violation of unknownUtilityViolations(source)) {
    const signature = `${relativePath} ${violation.token}`
    if (KNOWN_UNRESOLVED_UTILITIES.has(signature)) {
      unusedKnownUtilities.delete(signature)
      continue
    }
    errors.push(
      `${relativePath} uses ${violation.token}, which compiles to nothing: `
      + `no ${violation.label} named "${violation.value}" exists in tailwind.config.ts`,
    )
  }
  for (const violation of statusOpacityViolations(source)) {
    noticeIntensityWarnings.push(`${relativePath}:${violation.line} ${violation.token}`)
  }
  for (const violation of contractedLeadingViolations(source)) {
    errors.push(
      `${relativePath}:${violation.line} pairs ${violation.token} with a font-size token, overriding `
      + "the size step's contracted, density-aware line-height with a fixed rem value. Delete the leading-* "
      + 'utility; the size token already carries its leading.',
    )
  }
}

for (const stale of unusedKnownUtilities) {
  errors.push(`KNOWN_UNRESOLVED_UTILITIES lists ${stale}, which no longer exists. Remove the exception.`)
}

{
  /*
    A component's class list must be the truth about what it renders.

    Everything after `@tailwind utilities` in globals.css is unlayered, so at
    equal specificity it beats the utilities a component declares --
    `border` cancelled by `border-left: 0; border-right: 0`, `bg-surface-sunken`
    cancelled by `background: transparent`, `p-4` cancelled by `padding-left:
    0`, or a `text-<colour>` utility overridden outright by an unconditional
    `color:` declaration. This checker reads class lists, so it would otherwise
    stay green while a rule quietly cancels what the markup says.

    A cancelling declaration is only a problem when the component declared the
    opposite: `background: transparent` on a backdrop that never asked for a
    fill says nothing false. So both halves have to be present -- the rule
    cancels, and some component carrying that class declares the thing being
    cancelled -- and only the unconditional form is banned. A contextual rule
    such as `.mesh-route-main .mesh-form-card` flattens a card inside one
    region, which no className on the card can express, and the card's own
    class stays right everywhere else.
  */
  const declaresTextColor = (list) => {
    for (const [, value] of list.matchAll(/(?:^|\s)(?:[a-z-]+:)*text-([\w-]+)(?=\s|$)/g)) {
      if (configuredColors.has(value) || CORE_PALETTE.test(value)) return true
    }
    return false
  }
  const cancelledProperty = [
    { css: /(?:^|;)\s*border(?:-(?:top|right|bottom|left))?(?:-width)?\s*:\s*0/, utility: /(?:^|\s)border(?:-[xytrbl])?(?:\s|$)/ },
    { css: /(?:^|;)\s*background(?:-color)?\s*:\s*transparent/, utility: /(?:^|\s)bg-[\w-]+/ },
    { css: /(?:^|;)\s*padding(?:-(?:right|left))?\s*:\s*0(?:;|$)/, utility: /(?:^|\s)p[xytrbl]?-[\d.]/ },
    /*
      A rule that names a colour outright does not have to say `transparent` to
      cancel: it replaces whatever `text-<colour>` the component declared, and
      it wins for the same unlayered reason. Whether the two happen to resolve
      to the same value does not save it -- one of the two is then dead, and the
      next theme edit decides which.
    */
    { css: /(?:^|;)\s*color\s*:/, utility: declaresTextColor },
  ]
  const classListTruthWarnings = []
  for (const block of collectRuleBlocks(globals)) {
    const selectors = block.selector.split(',').map((one) => one.trim())
    // Only the unconditional form. A contextual rule such as
    // `.mesh-route-main .mesh-form-card` flattens a card inside one region,
    // which no className on the card can express, and the card's own class
    // stays right everywhere else.
    for (const selector of selectors) {
      if (!/^\.[a-z][\w-]*$/.test(selector)) continue
      const className = selector.slice(1)
      const lists = declaredMeshClassLists.get(className)
      if (!lists) continue
      for (const { css, utility } of cancelledProperty) {
        if (!css.test(block.body)) continue
        const declares = typeof utility === 'function'
          ? utility
          : (list) => utility.test(list)
        if (!lists.some(declares)) continue
        classListTruthWarnings.push(
          `globals.css rule "${block.selector}" overrides something the component carrying `
          + `.${className} declares in its own class list. Everything after @tailwind utilities is `
          + 'unlayered, so at equal specificity the rule wins and the class becomes a lie -- and this '
          + 'checker reads class lists, so it reports a treatment that is not on screen. Say it in '
          + 'the class list instead (border-y, border-l-2, no bg utility, no text-<colour>), or scope '
          + 'the rule to the context that makes it conditional.',
        )
        break
      }
    }
  }
  if (classListTruthWarnings.length > 0) {
    if (ENFORCE_CLASS_LIST_TRUTH) {
      errors.push(...classListTruthWarnings)
    } else {
      console.warn(
        `Class list truth: ${classListTruthWarnings.length} pre-existing cancelling rules in globals.css remain.`,
      )
      console.warn('Fix each so the class list is the truth about what it renders, then set ENFORCE_CLASS_LIST_TRUTH to true.')
      for (const warning of classListTruthWarnings) console.warn(`  ${warning}`)
    }
  }
}

if (noticeIntensityWarnings.length > 0) {
  if (ENFORCE_NOTICE_INTENSITY) {
    for (const warning of noticeIntensityWarnings) {
      errors.push(`${warning} uses an opacity modifier on a status or accent utility`)
    }
  } else {
    console.warn(
      `Notice intensity: ${noticeIntensityWarnings.length} opacity modifiers on status or accent utilities remain.`,
    )
    console.warn(
      'Replace each with a container token (container-<tone>, container-<tone>-hover, container-<tone>-line,',
    )
    console.warn(
      'on-container-<tone>) and then set ENFORCE_NOTICE_INTENSITY to true in this script.',
    )
    for (const warning of noticeIntensityWarnings) console.warn(`  ${warning}`)
  }
}

if (errors.length > 0) {
  console.error('Design token check failed:')
  for (const error of errors) {
    console.error(`- ${error}`)
  }
  process.exitCode = 1
} else {
  console.log(
    `Design token check passed: ${colorReferences.length} Tailwind colors plus theme, density, typography, geometry, elevation, and motion resolve through globals.css.`,
  )
  console.log(
    `Class resolution passed: every statically resolvable utility in ${scannedRenderedFiles} rendered files exists in the compiled Tailwind surface `
    + `(skipped ${utilitySkips.interpolated} interpolated fragments, ${utilitySkips.arbitrary} arbitrary values, `
    + `${utilitySkips.outsideNamespace} tokens outside a token-backed namespace).`,
  )
}
