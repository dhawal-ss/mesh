import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/*
  Computed contrast for the container quintuples.

  check-design-tokens.mjs already asserts contrast, but it does it against
  fifteen hex literals typed into the script. Three of them (#1f6f43, #855b08,
  #a3313a) are not in the stylesheet at all — the shipped tokens are #237548,
  #815900 and #b4232a — so those three assertions were passing against colours
  Mesh does not ship. A gate that hardcodes what it is meant to be checking
  cannot detect drift, which is the only thing it exists to detect.

  So this module resolves colours out of globals.css instead: it reads the
  theme blocks, follows var() chains, and evaluates the two forms Mesh uses to
  express translucency. Nothing here is typed twice.

  The specific surface it was built for is --*-container-line. Those five
  tokens are the border of every notice, and under .mesh-notice-advisory the
  border is the whole of the component's chrome: `background: transparent`, one
  2px rule on the leading edge. A translucent rule on a pale canvas can fall
  below the 3:1 that WCAG 1.4.11 asks of a meaningful graphical boundary
  without anyone noticing, because the text beside it still reads fine.
*/

/** WCAG 2.2 SC 1.4.11 Non-text Contrast. */
export const NON_TEXT_CONTRAST_MINIMUM = 3

/** WCAG 2.2 SC 1.4.3 Contrast (Minimum), normal-size text. */
export const TEXT_CONTRAST_MINIMUM = 4.5

/*
  Mesh renders in WebView2, which has supported color-mix() since Chromium 111,
  so the @supports block is the branch that actually runs. The plain
  declarations above it are a fallback for a runtime Mesh does not ship on.
  Both are checked: they are written to produce the same colour, and if they
  ever stop agreeing the gate says so.
*/
const SUPPORTS_COLOR_MIX = '@supports (color: color-mix(in oklch, white, black))'

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Splits a stylesheet into `{ selector, body, guard }` records in source
 * order, descending into at-rules so a block inside `@supports` is still seen.
 * `guard` carries the at-rule preludes the block sits under, which is how the
 * caller tells a color-mix override from a `@media (min-width: 2560px)` one.
 */
export function collectRuleBlocks(css, stripped = false) {
  const source = stripped ? css : stripComments(css)
  const blocks = []
  let index = 0
  let pending = ''
  while (index < source.length) {
    const character = source[index]
    if (character === '{') {
      const prelude = pending.trim()
      pending = ''
      index += 1
      const start = index
      let depth = 1
      while (index < source.length && depth > 0) {
        if (source[index] === '{') depth += 1
        else if (source[index] === '}') depth -= 1
        index += 1
      }
      const body = source.slice(start, index - 1)
      if (prelude.startsWith('@')) {
        // An at-rule wraps further rules; re-scan its body under this guard.
        for (const nested of collectRuleBlocks(body, true)) {
          blocks.push({ ...nested, guard: [prelude, ...nested.guard] })
        }
      } else {
        blocks.push({ selector: prelude, body, guard: [] })
      }
      continue
    }
    if (character === '}') {
      pending = ''
      index += 1
      continue
    }
    pending += character
    index += 1
  }
  return blocks
}

/** `--name: value;` pairs from a declaration body, in source order. */
export function collectDeclarations(body) {
  const declarations = []
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]?/g)) {
    declarations.push([match[1], match[2].trim()])
  }
  return declarations
}

/**
 * True when `selector` styles the root element for `theme`.
 *
 * The base `:root` block applies to every theme; a `[data-theme='x']` block
 * applies only to x. `[data-contrast='high']` is the same surface as the
 * high-contrast theme, so it is folded in.
 */
function selectorAppliesTo(selector, theme) {
  return selector.split(',').some((part) => {
    const trimmed = part.trim()
    if (trimmed === ':root' || trimmed === 'html') return true
    const themed = /^:?[\w-]*(?:\[data-theme='([\w-]+)'\])$/.exec(trimmed)
    if (themed) return themed[1] === theme
    if (theme === 'high-contrast' && /^:?[\w-]*\[data-contrast='high'\]$/.test(trimmed)) return true
    return false
  })
}

/**
 * Every custom property in effect on the root element for one theme.
 *
 * `includeColorMix` picks the branch: true resolves the `@supports` overrides
 * the shipping WebView takes, false resolves the plain fallbacks beneath them.
 */
export function themeVariables(css, theme, { includeColorMix = true } = {}) {
  const variables = new Map()
  for (const block of collectRuleBlocks(css)) {
    if (block.guard.some((guard) => guard.startsWith('@media'))) continue
    if (block.guard.some((guard) => guard.startsWith('@supports'))) {
      if (!includeColorMix) continue
      if (!block.guard.includes(SUPPORTS_COLOR_MIX)) continue
    }
    if (!selectorAppliesTo(block.selector, theme)) continue
    for (const [name, value] of collectDeclarations(block.body)) {
      variables.set(name, value)
    }
  }
  return variables
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const NAMED = new Map([
  ['transparent', { r: 0, g: 0, b: 0, a: 0 }],
  ['white', { r: 255, g: 255, b: 255, a: 1 }],
  ['black', { r: 0, g: 0, b: 0, a: 1 }],
])

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(source) {
  const parts = []
  let depth = 0
  let current = ''
  for (const character of source) {
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  parts.push(current)
  return parts
}

/** Substitutes `var(--x)` / `var(--x, fallback)` until no references remain. */
export function expandVariables(value, variables, depth = 0) {
  if (depth > 32) return null
  const start = value.indexOf('var(')
  if (start === -1) return value.trim()
  let open = 0
  let end = -1
  for (let index = start + 3; index < value.length; index += 1) {
    if (value[index] === '(') open += 1
    else if (value[index] === ')') {
      open -= 1
      if (open === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) return null
  const parts = splitTopLevel(value.slice(start + 4, end))
  const name = parts[0].trim()
  const fallback = parts.slice(1).join(',').trim()
  const resolved = variables.has(name) ? variables.get(name) : fallback
  if (!resolved) return null
  return expandVariables(
    `${value.slice(0, start)}${resolved}${value.slice(end + 1)}`,
    variables,
    depth + 1,
  )
}

const expandHex = (hex) => (hex.length === 4
  ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
  : hex)

/**
 * Resolves one declaration to `{ r, g, b, a }`, or null when the value is not
 * a colour this module understands. Returning null rather than guessing is
 * deliberate: a silently-skipped token is a gate reporting success on a surface
 * it never looked at, so the caller treats null as a failure to explain rather
 * than a pass.
 */
export function resolveColor(value, variables) {
  const expanded = expandVariables(String(value), variables)
  if (expanded == null) return null
  const text = expanded.trim()
  const named = NAMED.get(text.toLowerCase())
  if (named) return { ...named }
  if (HEX.test(text)) {
    const hex = expandHex(text)
    return {
      r: Number.parseInt(hex.slice(1, 3), 16),
      g: Number.parseInt(hex.slice(3, 5), 16),
      b: Number.parseInt(hex.slice(5, 7), 16),
      a: 1,
    }
  }
  const rgb = /^rgba?\(\s*([^)]+)\)$/i.exec(text)
  if (rgb) {
    const [channels, alpha] = rgb[1].split('/')
    const parts = channels.trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null
    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: alpha === undefined ? (parts[3] ?? 1) : Number.parseFloat(alpha),
    }
  }
  return resolveColorMix(text, variables)
}

/*
  color-mix(in oklch, C P%, transparent) is exactly C at alpha P/100.

  CSS Color 5 mixes in premultiplied space. `transparent` is rgb(0 0 0 / 0), so
  its premultiplied contribution is zero on every channel: the mix is
  (P x C_oklch) carrying alpha P, and un-premultiplying divides straight back
  out to C_oklch. The colour is unchanged; only the alpha moves. That is why
  globals.css can offer `rgb(var(--accent-rgb) / 0.55)` as the fallback for
  `color-mix(in oklch, var(--accent) 55%, transparent)` and get the same pixel.

  Only this one form is evaluated. A mix between two opaque colours would need
  a full sRGB<->OKLab implementation, and rather than approximate one, the
  resolver returns null so the caller reports the token as unevaluated.
*/
export function resolveColorMix(text, variables) {
  const match = /^color-mix\(\s*in\s+oklch\s*,([\s\S]+)\)$/i.exec(text)
  if (!match) return null
  const parts = splitTopLevel(match[1])
  if (parts.length !== 2) return null
  if (parts[1].trim().toLowerCase() !== 'transparent') return null
  const percentage = /^([\s\S]+?)\s+([\d.]+)%$/.exec(parts[0].trim())
  if (!percentage) return null
  const base = resolveColor(percentage[1], variables)
  if (!base) return null
  return { ...base, a: base.a * (Number.parseFloat(percentage[2]) / 100) }
}

/**
 * Alpha-composites `color` onto an opaque `background`.
 *
 * Simple source-over in gamma-encoded sRGB, which is what the compositor does
 * for ordinary content: the border pixel is blended with the backdrop before
 * either is linearized.
 */
export function compositeOver(color, background) {
  const blend = (channel) => Math.round(
    color[channel] * color.a + background[channel] * (1 - color.a),
  )
  return { r: blend('r'), g: blend('g'), b: blend('b'), a: 1 }
}

const channelLuminance = (channel) => {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance({ r, g, b }) {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

export const CONTAINER_TONES = ['primary', 'secondary', 'error', 'marker']

/*
  The themes a person can actually be looking at. The base `:root` block is the
  dark palette, and `[data-theme='dark']` re-states it, so measuring `dark`
  covers both.
*/
export const MEASURED_THEMES = ['dark', 'light', 'high-contrast']

/*
  Surfaces a notice sits on. `.mesh-notice-advisory` sets
  `background: transparent`, so its rule composites straight onto whichever of
  these is behind it, and the rule is judged against that same surface.
*/
const NOTICE_BACKDROPS = ['--surface', '--surface-container', '--surface-container-high']

/**
 * Contrast of every container line against every surface it can land on.
 *
 * Returns one row per (theme, tone, backdrop) so a caller can print the whole
 * grid; `findContainerLineFailures` is the gate built on top of it.
 */
export function measureContainerLines(css, { includeColorMix = true } = {}) {
  const rows = []
  for (const theme of MEASURED_THEMES) {
    const variables = themeVariables(css, theme, { includeColorMix })
    for (const tone of CONTAINER_TONES) {
      const token = `--${tone}-container-line`
      const line = resolveColor(`var(${token})`, variables)
      for (const backdrop of NOTICE_BACKDROPS) {
        const surface = resolveColor(`var(${backdrop})`, variables)
        if (!line || !surface) {
          rows.push({ theme, tone, token, backdrop, ratio: null, alpha: line?.a ?? null })
          continue
        }
        rows.push({
          theme,
          tone,
          token,
          backdrop,
          alpha: line.a,
          ratio: contrastRatio(compositeOver(line, surface), surface),
        })
      }
    }
  }
  return rows
}

/*
  Shortfalls this gate reports but does not fail on.

  One entry, and it is written down rather than scoped away so that the number
  stays visible: the neutral rule (`--border-default`, #948B7F) reaches 3.10:1
  on the light canvas but only 2.86:1 on the light rail, which is a slightly
  darker paper. Unlike the five status tones, this line carries no state — it
  separates two regions of the same surface and every component it borders is
  identified by its own text and controls, so 1.4.11 does not bind it. Raising
  it means re-authoring `--ref-quiet-light-rule`, which is the app's universal
  border colour in light mode and a governed value in
  check-design-tokens.mjs's Indie Workshop palette. That is a design change
  with an owner, not a defect fix, so it is recorded here instead of made.

  Add an entry only with the measured ratio and the reason it does not bind.
*/
/*
  Empty, and meant to stay that way. The one entry this map used to carry was
  the light-theme surface divider, which fell short because
  --ref-quiet-light-rule was a warm #948B7F. Quiet Structure re-derives the
  light rule against its own canvas at #6E716F, so the shortfall is gone rather
  than waived.
*/
export const ACCEPTED_CONTRAST_SHORTFALLS = new Map([])

export function findContainerLineFailures(css, minimum = NON_TEXT_CONTRAST_MINIMUM) {
  const failures = []
  const unusedAcceptances = new Set(ACCEPTED_CONTRAST_SHORTFALLS.keys())
  for (const includeColorMix of [true, false]) {
    for (const row of measureContainerLines(css, { includeColorMix })) {
      const branch = includeColorMix ? 'color-mix' : 'fallback'
      if (row.ratio === null) {
        failures.push({ ...row, branch, reason: 'could not be resolved to a colour' })
        continue
      }
      if (row.ratio >= minimum) continue
      const signature = `${row.theme} ${row.token} ${row.backdrop}`
      if (ACCEPTED_CONTRAST_SHORTFALLS.has(signature)) {
        unusedAcceptances.delete(signature)
        continue
      }
      failures.push({
        ...row,
        branch,
        reason: `${row.ratio.toFixed(2)}:1 is below the ${minimum}:1 a meaningful boundary needs`,
      })
    }
  }
  // A stale acceptance is its own defect: it says a surface still falls short
  // when it no longer does, which is how an exception list outlives its reason.
  for (const stale of unusedAcceptances) {
    failures.push({
      theme: stale.split(' ')[0],
      token: stale.split(' ')[1],
      backdrop: stale.split(' ')[2],
      branch: 'acceptance',
      reason: 'now clears the minimum. Remove it from ACCEPTED_CONTRAST_SHORTFALLS.',
    })
  }
  return failures
}

/**
 * The two declaration branches must produce the same pixel.
 *
 * globals.css writes each translucent token twice — once as `rgb(... / A)` for
 * a WebView without color-mix, once as `color-mix(in oklch, C P%, transparent)`
 * for one with it. They are meant to be the same colour. Nothing checked that,
 * so a change to one could silently ship a different palette to the fallback.
 */
export function findBranchDisagreements(css) {
  const problems = []
  for (const theme of MEASURED_THEMES) {
    const mixed = themeVariables(css, theme, { includeColorMix: true })
    const plain = themeVariables(css, theme, { includeColorMix: false })
    for (const tone of CONTAINER_TONES) {
      for (const suffix of ['', '-hover', '-active', '-line']) {
        const token = `--${tone}-container${suffix}`
        const withMix = resolveColor(`var(${token})`, mixed)
        const withoutMix = resolveColor(`var(${token})`, plain)
        if (!withMix || !withoutMix) {
          problems.push({ theme, token, reason: 'one branch did not resolve to a colour' })
          continue
        }
        const sameColor = withMix.r === withoutMix.r
          && withMix.g === withoutMix.g
          && withMix.b === withoutMix.b
        if (!sameColor || Math.abs(withMix.a - withoutMix.a) > 0.005) {
          problems.push({
            theme,
            token,
            reason: `the color-mix branch is rgb(${withMix.r} ${withMix.g} ${withMix.b} / ${withMix.a}) `
              + `but the fallback is rgb(${withoutMix.r} ${withoutMix.g} ${withoutMix.b} / ${withoutMix.a})`,
          })
        }
      }
    }
  }
  return problems
}

/*
  Text pairs, resolved rather than typed.

  These mirror what check-design-tokens.mjs asserted with literals, plus
  --content-link, whose absence from that list is exactly why a 2.00:1 link
  colour shipped.
*/
export const TEXT_PAIRS = [
  ['body text', '--on-surface', '--surface'],
  ['supporting text', '--on-surface-variant', '--surface'],
  ['supporting text on a container', '--on-surface-variant', '--surface-container-high'],
  ['body text on a container', '--on-surface', '--surface-container-highest'],
  ['link text', '--primary', '--surface'],
  ['link text on a container', '--primary', '--surface-container-high'],
  ['error text', '--error', '--surface'],
  ['error text on a container', '--error', '--surface-container-high'],
  ['marker text', '--marker', '--surface'],
  ['text on a primary fill', '--on-primary', '--primary'],
  ['text on a primary container', '--on-primary-container', '--primary-container'],
  ['text on a secondary container', '--on-secondary-container', '--secondary-container'],
  ['text on an error fill', '--on-error', '--error'],
  ['text on an error container', '--on-error-container', '--error-container'],
  ['text on a marker fill', '--on-marker', '--marker'],
  ['text on a marker container', '--on-marker-container', '--marker-container'],
]

export function measureTextPairs(css) {
  const rows = []
  for (const theme of MEASURED_THEMES) {
    const variables = themeVariables(css, theme)
    for (const [label, foregroundToken, backgroundToken] of TEXT_PAIRS) {
      const background = resolveColor(`var(${backgroundToken})`, variables)
      const foreground = resolveColor(`var(${foregroundToken})`, variables)
      if (!background || !foreground) {
        rows.push({ theme, label, foregroundToken, backgroundToken, ratio: null })
        continue
      }
      rows.push({
        theme,
        label,
        foregroundToken,
        backgroundToken,
        ratio: contrastRatio(compositeOver(foreground, background), background),
      })
    }
  }
  return rows
}

export function findTextContrastFailures(css, minimum = TEXT_CONTRAST_MINIMUM) {
  return measureTextPairs(css)
    .filter((row) => row.ratio === null || row.ratio < minimum)
    .map((row) => ({
      ...row,
      reason: row.ratio === null
        ? 'could not be resolved to a colour'
        : `${row.ratio.toFixed(2)}:1 is below the ${minimum}:1 body text needs`,
    }))
}

function printReport(css) {
  console.log('Container line, composited over each surface it can sit on:')
  for (const row of measureContainerLines(css)) {
    const ratio = row.ratio === null ? 'unresolved' : `${row.ratio.toFixed(2)}:1`
    console.log(
      `  ${row.theme.padEnd(14)} ${row.tone.padEnd(8)} ${row.backdrop.padEnd(18)}`
      + ` alpha ${String(row.alpha).padEnd(6)} ${ratio}`,
    )
  }
  console.log('')
  console.log('Text pairs:')
  for (const row of measureTextPairs(css)) {
    const ratio = row.ratio === null ? 'unresolved' : `${row.ratio.toFixed(2)}:1`
    console.log(`  ${row.theme.padEnd(14)} ${row.label.padEnd(32)} ${ratio}`)
  }
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const css = await readFile(path.join(projectRoot, 'src', 'styles', 'globals.css'), 'utf8')

  if (process.argv.includes('--report')) {
    printReport(css)
    return
  }

  const failures = [
    ...findBranchDisagreements(css)
      .map((problem) => `${problem.theme}: ${problem.token} — ${problem.reason}`),
    ...findContainerLineFailures(css)
      .map((f) => `${f.theme}: ${f.token} on ${f.backdrop} (${f.branch} branch) ${f.reason}`),
    ...findTextContrastFailures(css)
      .map((f) => `${f.theme}: ${f.label} — ${f.foregroundToken} on ${f.backgroundToken} ${f.reason}`),
  ]

  if (failures.length > 0) {
    console.error('Computed contrast check failed:')
    for (const failure of failures) console.error(`- ${failure}`)
    console.error('')
    console.error('Run `node scripts/check-container-contrast.mjs --report` for the full grid.')
    process.exitCode = 1
    return
  }

  console.log(
    `Computed contrast check passed (${measureContainerLines(css).length} container-line measurements`
    + ` and ${measureTextPairs(css).length} text pairs resolved out of globals.css;`
    + ' both declaration branches agree).',
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
