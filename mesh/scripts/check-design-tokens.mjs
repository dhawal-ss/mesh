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
  {
    kind: 'box-shadow focus ring',
    expression: /\bfocus(?:-visible)?:ring(?:-[^\s'"]+)?/gi,
  },
  {
    kind: 'stock elevation class',
    expression: /\bshadow-(?:sm|md|lg|xl|2xl)\b/gi,
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
const componentFixture = 'bg-[#fff] text-[11px] border-white/10 bg-yellow-500/10 font-bold text-xl var(--ref-neutral-1) oklch(50% 0.1 240) focus-visible:ring-2 shadow-lg'
const densityFixture = '--density-control-sm: 28px; --density-control-md: 32px;'
if (
  literalColorViolations(detectorFixture).length !== 3
  || visualViolations(componentFixture).length !== 11
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
  ['--ref-neutral-1', '#101113'],
  ['--ref-neutral-2', '#1b1c1f'],
  ['--ref-neutral-3', '#202125'],
  ['--ref-neutral-4', '#27292e'],
  ['--ref-neutral-5', '#2e3036'],
  ['--ref-neutral-6', '#383a40'],
  ['--ref-neutral-7', '#4a4d54'],
  ['--ref-neutral-8', '#5a5e65'],
  ['--ref-neutral-9', '#71757c'],
  ['--ref-neutral-10', '#9fa3aa'],
  ['--ref-neutral-11', '#c6c8cc'],
  ['--ref-neutral-12', '#f0f1f2'],
  ['--ref-accent-9', '#d4c0a1'],
  ['--ref-accent-10', '#e3d4bb'],
  ['--ref-accent-11', '#f1e8db'],
  ['--ref-green-11', '#3dbe72'],
  ['--ref-red-11', '#f06a73'],
  ['--ref-amber-11', '#f0b232'],
  ['--ref-blue-11', '#6fafff'],
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
  ['--ref-size-11', '11px'],
  ['--ref-size-12', '12px'],
  ['--ref-size-13', '13px'],
  ['--ref-size-14', '14px'],
  ['--ref-size-15', '15px'],
  ['--ref-size-18', '18px'],
  ['--ref-size-22', '22px'],
  ['--ref-size-28', '28px'],
  ['--font-size-2xs', 'var(--ref-size-11)'],
  ['--font-size-xs', 'var(--ref-size-12)'],
  ['--font-size-code', 'var(--ref-size-13)'],
  ['--font-size-dense', 'var(--ref-size-13)'],
  ['--font-size-sm', 'var(--ref-size-14)'],
  ['--font-size-base', 'var(--ref-size-15)'],
  ['--font-size-md', 'var(--ref-size-18)'],
  ['--font-size-title', 'var(--ref-size-22)'],
  ['--font-size-lg', 'var(--ref-size-28)'],
  ['--font-weight-regular', '400'],
  ['--font-weight-medium', '500'],
  ['--font-weight-semibold', '600'],
])

for (const [name, expected] of expectedTypography) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must use the production typography value (${expected})`)
  }
}

for (const name of [
  '--font-size-2xs',
  '--font-size-xs',
  '--font-size-code',
  '--font-size-dense',
  '--font-size-sm',
  '--font-size-base',
  '--font-size-md',
  '--font-size-title',
  '--font-size-lg',
  '--font-weight-regular',
  '--font-weight-medium',
  '--font-weight-semibold',
]) {
  if (!tailwind.includes(`var(${name})`)) {
    errors.push(`Tailwind must consume typography token ${name}`)
  }
}

const expectedMotion = new Map([
  ['--ref-dur-50', '50ms'],
  ['--ref-dur-100', '100ms'],
  ['--ref-dur-150', '150ms'],
  ['--ref-dur-200', '200ms'],
  ['--ref-dur-250', '250ms'],
  ['--ref-dur-300', '300ms'],
  ['--ref-ease-out-quart', 'cubic-bezier(0.165, 0.84, 0.44, 1)'],
  ['--ref-ease-out-quint', 'cubic-bezier(0.23, 1, 0.32, 1)'],
  ['--ref-ease-in-out-cubic', 'cubic-bezier(0.645, 0.045, 0.355, 1)'],
  ['--ref-ease-hover', 'ease'],
  ['--motion-dur-micro', 'var(--ref-dur-100)'],
  ['--motion-dur-fast', 'var(--ref-dur-150)'],
  ['--motion-dur-base', 'var(--ref-dur-200)'],
  ['--motion-dur-slow', 'var(--ref-dur-250)'],
  ['--motion-dur-exit', 'var(--ref-dur-150)'],
  ['--motion-ease-enter', 'var(--ref-ease-out-quart)'],
  ['--motion-ease-exit', 'var(--ref-ease-out-quart)'],
  ['--motion-ease-move', 'var(--ref-ease-in-out-cubic)'],
  ['--motion-ease-hover', 'var(--ref-ease-hover)'],
])

for (const [name, expected] of expectedMotion) {
  if (declarations.get(name) !== expected) {
    errors.push(`${name} must use the researched motion value (${expected})`)
  }
}

if (globals.includes('--ease-spring')) {
  errors.push('globals.css must not restore the overshooting --ease-spring token')
}

for (const requiredRule of [
  "font-feature-settings: 'liga' 1, 'calt' 1",
  "font-variation-settings: 'opsz' 14",
  "font-variation-settings: 'opsz' 28",
  "font-feature-settings: 'tnum' 1, 'calt' 1",
  'outline: 2px solid var(--border-focus)',
  'outline-offset: 2px',
]) {
  if (!globals.includes(requiredRule)) {
    errors.push(`globals.css must include ${requiredRule}`)
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
  '--motion-dur-micro',
  '--motion-dur-slow',
  '--motion-ease-enter',
  '--motion-ease-exit',
  '--motion-ease-move',
  '--motion-ease-hover',
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

const containerRoles = ['surface', 'accent', 'success', 'warning', 'danger', 'info']
for (const role of containerRoles) {
  for (const suffix of ['container', 'container-hover', 'container-active', 'container-line']) {
    const variable = `--${role}-${suffix}`
    if (!declarations.has(variable)) {
      errors.push(`globals.css must define container role ${variable}`)
    }
    if (!tailwind.includes(`var(${variable})`)) {
      errors.push(`Tailwind must expose container role ${variable}`)
    }
  }
  const onContainer = `--${role}-on-container`
  if (!declarations.has(onContainer)) {
    errors.push(`globals.css must define container role ${onContainer}`)
  }
  if (!tailwind.includes(`var(${onContainer})`)) {
    errors.push(`Tailwind must expose container role ${onContainer}`)
  }
}

if (!globals.includes('@supports (color: color-mix(in oklch, white, black))')) {
  errors.push('globals.css must derive supported container states in perceptual OKLCH')
}

const hexToRgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}
const relativeLuminance = (hex) => {
  const channels = hexToRgb(hex).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}
const contrastRatio = (foreground, background) => {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}
for (const [label, foreground, background] of [
  ['dark accent content', '#101113', '#d4c0a1'],
  ['light accent content', '#ffffff', '#6b5636'],
  ['light success content', '#1f6f43', '#ffffff'],
  ['light warning content', '#855b08', '#ffffff'],
  ['light danger content', '#a3313a', '#ffffff'],
  ['light info content', '#1f5fae', '#ffffff'],
]) {
  const ratio = contrastRatio(foreground, background)
  if (ratio < 4.5) {
    errors.push(`${label} contrast must be at least 4.5:1, found ${ratio.toFixed(2)}:1`)
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
