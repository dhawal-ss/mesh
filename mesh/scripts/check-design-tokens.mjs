import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tailwindPath = path.join(root, 'tailwind.config.ts')
const globalsPath = path.join(root, 'src', 'styles', 'globals.css')
const componentsPath = path.join(root, 'src', 'components')

const [tailwind, globals] = await Promise.all([
  readFile(tailwindPath, 'utf8'),
  readFile(globalsPath, 'utf8'),
])

const errors = []

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

// Keep self-tests here so weakening either detector cannot silently pass.
const detectorFixture = "colors: { bad: '#fff', worse: 'rgb(1 2 3)', alsoBad: 'oklch(50% 0.1 240)' }"
const componentFixture = 'bg-[#fff] text-[11px] border-white/10 bg-yellow-500/10 font-bold text-xl var(--ref-neutral-1) oklch(50% 0.1 240)'
const densityFixture = '--density-control-sm: 28px; --density-control-md: 32px;'
if (
  literalColorViolations(detectorFixture).length !== 3
  || visualViolations(componentFixture).length !== 9
  || undersizedControlTokens(densityFixture).length !== 1
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

const expectedReferenceColors = new Map([
  ['--ref-neutral-1', '#101013'],
  ['--ref-neutral-2', '#17181c'],
  ['--ref-neutral-3', '#202127'],
  ['--ref-neutral-4', '#27292f'],
  ['--ref-neutral-5', '#2e3037'],
  ['--ref-neutral-6', '#373941'],
  ['--ref-neutral-7', '#454751'],
  ['--ref-neutral-8', '#5d606b'],
  ['--ref-neutral-9', '#6b6e79'],
  ['--ref-neutral-10', '#797b86'],
  ['--ref-neutral-11', '#b2b4bb'],
  ['--ref-neutral-12', '#edeef2'],
  ['--ref-accent-9', '#c19f66'],
  ['--ref-accent-10', '#cfaf79'],
  ['--ref-accent-11', '#e3c697'],
  ['--ref-green-11', '#57bd72'],
  ['--ref-red-11', '#ed756e'],
  ['--ref-amber-11', '#edb345'],
  ['--ref-blue-11', '#52b5f4'],
])

for (const [name, expected] of expectedReferenceColors) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must use the researched fallback value (${expected})`)
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

const expectedTypography = new Map([
  ['--font-size-2xs', '11px'],
  ['--font-size-micro', '11px'],
  ['--font-size-meta', '11px'],
  ['--font-size-xs', '12px'],
  ['--font-size-code', '13px'],
  ['--font-size-sm', '15px'],
  ['--font-size-base', '17px'],
  ['--font-size-md', '22px'],
  ['--font-size-lg', '28px'],
  ['--font-weight-regular', '400'],
  ['--font-weight-medium', '500'],
  ['--font-weight-semibold', '600'],
])

for (const [name, expected] of expectedTypography) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must use the production typography value (${expected})`)
  }
  if (!tailwind.includes(`var(${name})`)) {
    errors.push(`Tailwind must consume typography token ${name}`)
  }
}

const expectedAliases = new Map([
  ['--bg-tertiary', 'var(--surface-sunken)'],
  ['--bg-secondary', 'var(--surface-sidebar)'],
  ['--bg-primary', 'var(--surface-base)'],
  ['--bg-modifier-hover', 'var(--surface-hover)'],
  ['--bg-modifier-active', 'var(--surface-active)'],
  ['--bg-modifier-selected', 'var(--surface-active)'],
  ['--bg-floating', 'var(--surface-overlay)'],
  ['--text-primary', 'var(--content-primary)'],
  ['--text-secondary', 'var(--content-secondary)'],
  ['--text-muted', 'var(--content-muted)'],
  ['--text-link', 'var(--content-link)'],
  ['--green', 'var(--status-success)'],
  ['--red', 'var(--status-danger)'],
  ['--yellow', 'var(--status-warning)'],
  ['--blue', 'var(--status-info)'],
])

for (const [name, expected] of expectedAliases) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must remain a compatibility alias to ${expected}`)
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
  '--font-mono',
  '--font-size-2xs',
  '--font-size-lg',
  '--radius-default',
  '--radius-xl',
  '--elev-overlay',
  '--animation-pulse-soft',
  '--z-dropdown',
  '--z-modal',
  '--duration-instant',
  '--duration-slow',
  '--density-row-block',
  '--density-control-lg',
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
  '--surface-sunken-rgb',
  '--surface-base-rgb',
  '--surface-raised-rgb',
  '--surface-overlay-rgb',
  '--surface-hover-rgb',
  '--surface-active-rgb',
  '--content-primary-rgb',
  '--content-secondary-rgb',
  '--content-muted-rgb',
  '--content-on-accent-rgb',
  '--status-success-rgb',
  '--status-danger-rgb',
  '--status-warning-rgb',
  '--status-info-rgb',
]

for (const variable of requiredSemanticColorChannels) {
  if (!tailwind.includes(`'${variable}'`)) {
    errors.push(`Tailwind must expose semantic color channel ${variable}`)
  }
  if (!declarations.has(variable)) {
    errors.push(`globals.css must define semantic color channel ${variable}`)
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
}

for (const violation of componentViolations) {
  errors.push(`${violation.relativePath} contains ${violation.kind}: ${violation.token}`)
}

if (errors.length > 0) {
  console.error('Design token check failed:')
  for (const error of errors) {
    console.error(`- ${error}`)
  }
  process.exitCode = 1
} else {
  console.log(
    `Design token check passed: ${colorReferences.length} Tailwind colors, theme/density roles, typography, and production component styles resolve through globals.css.`,
  )
}
