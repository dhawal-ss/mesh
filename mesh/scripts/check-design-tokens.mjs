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

// Keep self-tests here so weakening either detector cannot silently pass.
const detectorFixture = "colors: { bad: '#fff', worse: 'rgb(1 2 3)' }"
const componentFixture = 'bg-[#fff] text-[11px] border-white/10 bg-yellow-500/10 font-bold text-xl'
if (
  literalColorViolations(detectorFixture).length !== 2
  || visualViolations(componentFixture).length !== 7
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

const expectedPrimitiveChannels = new Map([
  ['--gray-1-rgb', '17 18 20'],
  ['--gray-3-rgb', '30 31 34'],
  ['--gray-4-rgb', '43 45 49'],
  ['--gray-5-rgb', '49 51 56'],
  ['--gray-6-rgb', '63 65 71'],
  ['--gray-7-rgb', '78 80 88'],
  ['--gray-8-rgb', '148 155 164'],
  ['--gray-9-rgb', '181 186 193'],
  ['--gray-10-rgb', '219 222 225'],
  ['--gray-11-rgb', '242 243 245'],
  ['--gray-hover-rgb', '46 48 53'],
  ['--gray-active-rgb', '64 66 73'],
  ['--gray-raised-rgb', '53 55 60'],
  ['--link-rgb', '0 168 252'],
  ['--accent-rgb', '212 192 161'],
  ['--accent-hover-rgb', '239 224 195'],
  ['--accent-muted-rgb', '141 125 103'],
  ['--success-rgb', '35 165 89'],
  ['--danger-rgb', '218 55 60'],
  ['--warning-rgb', '240 178 50'],
  ['--info-rgb', '88 101 242'],
])

for (const [name, expected] of expectedPrimitiveChannels) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must preserve its current value (${expected})`)
  }
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
  '--shadow-elevation-low',
  '--shadow-elevation-high',
  '--shadow-floating',
  '--shadow-pane',
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
  '--success-rgb',
  '--danger-rgb',
  '--warning-rgb',
  '--info-rgb',
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
