export const MESH_THEME_SCHEMA = 'mesh.theme/1' as const
export const MESH_THEME_MIME = 'application/vnd.mesh.theme+json'
export const MAX_THEME_PACKAGE_BYTES = 64 * 1024
export const MAX_THEME_PACKAGE_DEPTH = 8
export const MAX_THEME_PACKAGE_KEYS = 256
export const MAX_THEME_HISTORY = 5

export type ThemeModeName = 'dark' | 'light'

export interface MeshThemeColors {
  canvas: string
  textPrimary: string
  textSecondary: string
  rule: string
  accent: string
  presence: string
  avatar1?: string
  avatar2?: string
  avatar3?: string
  avatar4?: string
  avatar5?: string
  avatar6?: string
  avatar7?: string
  avatar8?: string
}

export interface MeshThemeManifest {
  $schema: typeof MESH_THEME_SCHEMA
  id: string
  name: string
  version: string
  author: string
  modes: Partial<Record<ThemeModeName, { color: MeshThemeColors }>>
}

export interface ValidatedThemePackage {
  manifest: MeshThemeManifest
  hash: string
  normalized: string
  serialized: string
  modes: ThemeModeName[]
}

export class ThemePackageError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'ThemePackageError'
  }
}

interface StoredThemePackage {
  manifest: MeshThemeManifest
  hash: string
  confirmedAt: string
}

export interface ConfirmedThemeState {
  packageId: string | null
  packageHash: string | null
  baseTheme: ThemeModeName
  confirmedAt: string
}

export interface ThemeLibrary {
  schemaVersion: 1
  packages: StoredThemePackage[]
  activePackageId: string | null
  activePackageHash: string | null
  history: ConfirmedThemeState[]
}

const THEME_LIBRARY_KEY = 'mesh-theme-library-v1'
const ROOT_KEYS = ['$schema', 'id', 'name', 'version', 'author', 'modes'] as const
const REQUIRED_COLOR_KEYS = [
  'canvas',
  'textPrimary',
  'textSecondary',
  'rule',
  'accent',
  'presence',
] as const
const OPTIONAL_COLOR_KEYS = [
  'avatar1',
  'avatar2',
  'avatar3',
  'avatar4',
  'avatar5',
  'avatar6',
  'avatar7',
  'avatar8',
] as const
const COLOR_KEYS = new Set<string>([...REQUIRED_COLOR_KEYS, ...OPTIONAL_COLOR_KEYS])
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/
const REVERSE_DOMAIN_ID = /^(?=.{3,96}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const HASH = /^[0-9a-f]{64}$/
const METADATA_FORBIDDEN = /[<>\u0000-\u001F\u007F]|(?:https?|file|data|javascript):|url\s*\(/i
const THEME_CSS_PROPERTIES = [
  '--surface-canvas',
  '--surface-base',
  '--surface-base-rgb',
  '--surface-sunken',
  '--surface-sunken-rgb',
  '--surface-sidebar',
  '--surface-sidebar-rgb',
  '--surface-raised',
  '--surface-raised-rgb',
  '--surface-hover',
  '--surface-hover-rgb',
  '--surface-active',
  '--surface-active-rgb',
  '--surface-overlay',
  '--surface-overlay-rgb',
  '--content-normal',
  '--content-normal-rgb',
  '--content-primary',
  '--content-primary-rgb',
  '--content-secondary',
  '--content-secondary-rgb',
  '--content-muted',
  '--content-muted-rgb',
  '--border-default',
  '--border-default-rgb',
  '--border-emphasis',
  '--border-emphasis-rgb',
  '--border-subtle',
  '--border-strong',
  '--border-control',
  '--border-control-rgb',
  '--accent',
  '--accent-rgb',
  '--accent-hover',
  '--accent-hover-rgb',
  '--accent-muted',
  '--accent-muted-rgb',
  '--presence-dot-online',
  '--avatar-sand',
  '--avatar-blue',
  '--avatar-green',
  '--avatar-red',
  '--avatar-violet',
  '--avatar-orange',
  '--avatar-pink',
  '--avatar-emerald',
] as const

function emptyThemeLibrary(): ThemeLibrary {
  return {
    schemaVersion: 1,
    packages: [],
    activePackageId: null,
    activePackageHash: null,
    history: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ThemePackageError(`The theme contains an unsupported or locked key: ${field}.${key}.`, `${field}.${key}`)
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new ThemePackageError(`The theme is missing ${field}.${key}.`, `${field}.${key}`)
    }
  }
}

function assertPlainText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new ThemePackageError(`${field} must be plain text.`, field)
  }
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0 || normalized.length > maxLength || METADATA_FORBIDDEN.test(normalized)) {
    throw new ThemePackageError(`${field} must be plain text between 1 and ${maxLength} characters.`, field)
  }
  return normalized
}

function normalizeHex(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw new ThemePackageError(`${field} must be an opaque 6-digit hex color.`, field)
  }
  return value.toUpperCase()
}

function rgbFromHex(value: string): [number, number, number] {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ]
}

function luminance(value: string): number {
  const components = rgbFromHex(value).map((component) => {
    const channel = component / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * components[0] + 0.7152 * components[1] + 0.0722 * components[2]
}

export function contrastRatio(left: string, right: string): number {
  const first = luminance(left)
  const second = luminance(right)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

function assertContrast(
  foreground: string,
  canvas: string,
  minimum: number,
  field: string,
): void {
  const ratio = contrastRatio(foreground, canvas)
  if (ratio + Number.EPSILON < minimum) {
    throw new ThemePackageError(
      `${field} needs at least ${minimum}:1 contrast on color.canvas; this package provides ${ratio.toFixed(2)}:1.`,
      field,
    )
  }
}

function validateColors(value: unknown, field: string): MeshThemeColors {
  if (!isRecord(value)) {
    throw new ThemePackageError(`${field} must be a color object.`, field)
  }
  assertExactKeys(value, COLOR_KEYS, REQUIRED_COLOR_KEYS, field)
  const colors = {} as MeshThemeColors
  for (const key of REQUIRED_COLOR_KEYS) colors[key] = normalizeHex(value[key], `${field}.${key}`)
  for (const key of OPTIONAL_COLOR_KEYS) {
    if (value[key] !== undefined) colors[key] = normalizeHex(value[key], `${field}.${key}`)
  }
  assertContrast(colors.textPrimary, colors.canvas, 7, `${field}.textPrimary`)
  assertContrast(colors.textSecondary, colors.canvas, 4.5, `${field}.textSecondary`)
  assertContrast(colors.rule, colors.canvas, 3, `${field}.rule`)
  assertContrast(colors.accent, colors.canvas, 4.5, `${field}.accent`)
  assertContrast(colors.presence, colors.canvas, 4.5, `${field}.presence`)
  for (const key of OPTIONAL_COLOR_KEYS) {
    if (colors[key]) assertContrast(colors[key]!, colors.canvas, 3, `${field}.${key}`)
  }
  return colors
}

function measureShape(value: unknown, depth = 1): { depth: number; keys: number } {
  if (depth > MAX_THEME_PACKAGE_DEPTH) return { depth, keys: 0 }
  if (Array.isArray(value)) {
    return value.reduce(
      (result, entry) => {
        const child = measureShape(entry, depth + 1)
        return { depth: Math.max(result.depth, child.depth), keys: result.keys + child.keys }
      },
      { depth, keys: 0 },
    )
  }
  if (!isRecord(value)) return { depth, keys: 0 }
  return Object.entries(value).reduce(
    (result, [, entry]) => {
      const child = measureShape(entry, depth + 1)
      return { depth: Math.max(result.depth, child.depth), keys: result.keys + child.keys + 1 }
    },
    { depth, keys: 0 },
  )
}

function findDuplicateJsonKey(source: string): string | null {
  type Frame =
    | { kind: 'object'; state: 'key-or-end' | 'colon' | 'value' | 'comma-or-end'; keys: Set<string> }
    | { kind: 'array'; state: 'value-or-end' | 'comma-or-end' }
  const stack: Frame[] = []
  let index = 0
  let rootConsumed = false

  const skipSpace = () => {
    while (/\s/.test(source[index] ?? '')) index += 1
  }
  const readString = (): { value: string; end: number } | null => {
    const start = index
    index += 1
    let escaped = false
    while (index < source.length) {
      const character = source[index]
      if (!escaped && character === '"') {
        const end = index + 1
        try {
          return { value: JSON.parse(source.slice(start, end)) as string, end }
        } catch {
          return null
        }
      }
      if (!escaped && character === '\\') escaped = true
      else escaped = false
      index += 1
    }
    return null
  }
  const consumeValue = (): boolean => {
    skipSpace()
    const character = source[index]
    if (character === '{') {
      index += 1
      stack.push({ kind: 'object', state: 'key-or-end', keys: new Set() })
      return true
    }
    if (character === '[') {
      index += 1
      stack.push({ kind: 'array', state: 'value-or-end' })
      return true
    }
    if (character === '"') {
      const parsed = readString()
      if (!parsed) return false
      index = parsed.end
      return true
    }
    const start = index
    while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1
    return index > start
  }

  while (index < source.length) {
    skipSpace()
    if (index >= source.length) break
    const frame = stack[stack.length - 1]
    if (!frame) {
      if (rootConsumed) break
      rootConsumed = consumeValue()
      continue
    }
    if (frame.kind === 'object') {
      if (frame.state === 'key-or-end') {
        if (source[index] === '}') {
          index += 1
          stack.pop()
          continue
        }
        if (source[index] !== '"') return null
        const parsed = readString()
        if (!parsed) return null
        index = parsed.end
        if (frame.keys.has(parsed.value)) return parsed.value
        frame.keys.add(parsed.value)
        frame.state = 'colon'
        continue
      }
      if (frame.state === 'colon') {
        if (source[index] !== ':') return null
        index += 1
        frame.state = 'value'
        continue
      }
      if (frame.state === 'value') {
        frame.state = 'comma-or-end'
        if (!consumeValue()) return null
        continue
      }
      if (source[index] === ',') {
        index += 1
        frame.state = 'key-or-end'
        continue
      }
      if (source[index] === '}') {
        index += 1
        stack.pop()
        continue
      }
      return null
    }
    if (frame.state === 'value-or-end') {
      if (source[index] === ']') {
        index += 1
        stack.pop()
        continue
      }
      frame.state = 'comma-or-end'
      if (!consumeValue()) return null
      continue
    }
    if (source[index] === ',') {
      index += 1
      frame.state = 'value-or-end'
      continue
    }
    if (source[index] === ']') {
      index += 1
      stack.pop()
      continue
    }
    return null
  }
  return null
}

export function validateThemeManifest(value: unknown): MeshThemeManifest {
  if (!isRecord(value)) throw new ThemePackageError('The theme package must be a JSON object.')
  const shape = measureShape(value)
  if (shape.depth > MAX_THEME_PACKAGE_DEPTH) {
    throw new ThemePackageError(`The theme package exceeds the maximum nesting depth of ${MAX_THEME_PACKAGE_DEPTH}.`)
  }
  if (shape.keys > MAX_THEME_PACKAGE_KEYS) {
    throw new ThemePackageError(`The theme package exceeds the maximum of ${MAX_THEME_PACKAGE_KEYS} keys.`)
  }
  assertExactKeys(value, new Set(ROOT_KEYS), ROOT_KEYS, 'theme')
  if (value.$schema !== MESH_THEME_SCHEMA) {
    throw new ThemePackageError(
      value.$schema === undefined
        ? `The theme package must use ${MESH_THEME_SCHEMA}.`
        : `This Mesh version does not support theme schema ${String(value.$schema)}.`,
      '$schema',
    )
  }
  const id = assertPlainText(value.id, 'id', 96)
  if (!REVERSE_DOMAIN_ID.test(id)) {
    throw new ThemePackageError('id must use reverse-domain syntax, such as org.example.campfire.', 'id')
  }
  const name = assertPlainText(value.name, 'name', 80)
  const author = assertPlainText(value.author, 'author', 120)
  const version = assertPlainText(value.version, 'version', 64)
  if (!SEMVER.test(version)) {
    throw new ThemePackageError('version must use semantic versioning, such as 1.0.0.', 'version')
  }
  if (!isRecord(value.modes)) throw new ThemePackageError('modes must be an object.', 'modes')
  assertExactKeys(value.modes, new Set(['dark', 'light']), [], 'modes')
  const modes: MeshThemeManifest['modes'] = {}
  for (const modeName of ['dark', 'light'] as const) {
    const mode = value.modes[modeName]
    if (mode === undefined) continue
    if (!isRecord(mode)) throw new ThemePackageError(`modes.${modeName} must be an object.`, `modes.${modeName}`)
    assertExactKeys(mode, new Set(['color']), ['color'], `modes.${modeName}`)
    modes[modeName] = { color: validateColors(mode.color, `modes.${modeName}.color`) }
  }
  if (!modes.dark && !modes.light) {
    throw new ThemePackageError('The theme must provide at least one dark or light mode.', 'modes')
  }
  return { $schema: MESH_THEME_SCHEMA, id, name, version, author, modes }
}

export function normalizeThemeManifest(manifest: MeshThemeManifest): string {
  const modes: Record<string, unknown> = {}
  for (const modeName of ['dark', 'light'] as const) {
    const mode = manifest.modes[modeName]
    if (!mode) continue
    const color: Record<string, string> = {}
    for (const key of REQUIRED_COLOR_KEYS) color[key] = mode.color[key]
    for (const key of OPTIONAL_COLOR_KEYS) {
      if (mode.color[key]) color[key] = mode.color[key]!
    }
    modes[modeName] = { color }
  }
  return JSON.stringify({
    $schema: MESH_THEME_SCHEMA,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    modes,
  })
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new ThemePackageError('Mesh could not verify this theme on the current runtime.')
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function parseThemePackage(
  source: string,
  options: { fileName?: string; mimeType?: string } = {},
): Promise<ValidatedThemePackage> {
  if (options.fileName && !options.fileName.toLocaleLowerCase().endsWith('.meshtheme')) {
    throw new ThemePackageError('Choose a file ending in .meshtheme.')
  }
  if (options.mimeType && options.mimeType !== MESH_THEME_MIME) {
    throw new ThemePackageError(`The selected file must use ${MESH_THEME_MIME}.`)
  }
  if (new TextEncoder().encode(source).byteLength > MAX_THEME_PACKAGE_BYTES) {
    throw new ThemePackageError('The theme package is larger than 64 KiB.')
  }
  if (source.charCodeAt(0) === 0xfeff) {
    throw new ThemePackageError('The theme package must be UTF-8 JSON without a byte-order mark.')
  }
  const duplicateKey = findDuplicateJsonKey(source)
  if (duplicateKey) throw new ThemePackageError(`The theme repeats the key ${duplicateKey}.`)
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new ThemePackageError('The theme package is not valid UTF-8 JSON.')
  }
  const manifest = validateThemeManifest(parsed)
  const normalized = normalizeThemeManifest(manifest)
  const hash = await sha256(normalized)
  return {
    manifest,
    normalized,
    serialized: `${JSON.stringify(JSON.parse(normalized), null, 2)}\n`,
    hash,
    modes: (['dark', 'light'] as const).filter((mode) => Boolean(manifest.modes[mode])),
  }
}

function normalizeStoredState(value: unknown): ThemeLibrary {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.packages)) {
    return emptyThemeLibrary()
  }
  const packages: StoredThemePackage[] = []
  for (const candidate of value.packages.slice(0, 32)) {
    if (!isRecord(candidate) || typeof candidate.hash !== 'string' || !HASH.test(candidate.hash)) continue
    try {
      packages.push({
        manifest: validateThemeManifest(candidate.manifest),
        hash: candidate.hash,
        confirmedAt: typeof candidate.confirmedAt === 'string' ? candidate.confirmedAt : new Date(0).toISOString(),
      })
    } catch {
      // An invalid stored package is ignored and can never reach document styles.
    }
  }
  const activePackageId = typeof value.activePackageId === 'string' ? value.activePackageId : null
  const activePackageHash = typeof value.activePackageHash === 'string' && HASH.test(value.activePackageHash)
    ? value.activePackageHash
    : null
  const activeExists = packages.some(
    (entry) => entry.manifest.id === activePackageId && entry.hash === activePackageHash,
  )
  const history: ConfirmedThemeState[] = Array.isArray(value.history)
    ? value.history.slice(-MAX_THEME_HISTORY).flatMap((entry) => {
        if (!isRecord(entry) || (entry.baseTheme !== 'dark' && entry.baseTheme !== 'light')) return []
        const packageId = typeof entry.packageId === 'string' ? entry.packageId : null
        const packageHash = typeof entry.packageHash === 'string' && HASH.test(entry.packageHash)
          ? entry.packageHash
          : null
        if ((packageId == null) !== (packageHash == null)) return []
        return [{
          packageId,
          packageHash,
          baseTheme: entry.baseTheme,
          confirmedAt: typeof entry.confirmedAt === 'string' ? entry.confirmedAt : new Date(0).toISOString(),
        }]
      })
    : []
  return {
    schemaVersion: 1,
    packages,
    activePackageId: activeExists ? activePackageId : null,
    activePackageHash: activeExists ? activePackageHash : null,
    history,
  }
}

export function readThemeLibrary(): ThemeLibrary {
  if (typeof localStorage === 'undefined') return emptyThemeLibrary()
  try {
    const value = localStorage.getItem(THEME_LIBRARY_KEY)
    return value ? normalizeStoredState(JSON.parse(value)) : emptyThemeLibrary()
  } catch {
    return emptyThemeLibrary()
  }
}

function writeThemeLibrary(library: ThemeLibrary): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(THEME_LIBRARY_KEY, JSON.stringify(library))
}

function rgbCss(value: string): string {
  return rgbFromHex(value).join(' ')
}

function mixHex(background: string, foreground: string, amount: number): string {
  const back = rgbFromHex(background)
  const front = rgbFromHex(foreground)
  return `#${back.map((component, index) => Math.round(component * (1 - amount) + front[index] * amount)
    .toString(16)
    .padStart(2, '0')).join('').toUpperCase()}`
}

export function clearThemePreview(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const property of THEME_CSS_PROPERTIES) root.style.removeProperty(property)
  delete root.dataset.importedTheme
}

export function applyThemeManifest(
  manifest: MeshThemeManifest | null,
  mode: 'dark' | 'light' | 'high-contrast',
): boolean {
  clearThemePreview()
  if (!manifest || mode === 'high-contrast') return false
  const selected = manifest.modes[mode]
  if (!selected) return false
  const { color } = selected
  const root = document.documentElement
  const surfaces = {
    '--surface-canvas': color.canvas,
    '--surface-base': color.canvas,
    '--surface-sunken': mixHex(color.canvas, color.textPrimary, 0.035),
    '--surface-sidebar': mixHex(color.canvas, color.textPrimary, 0.05),
    '--surface-raised': mixHex(color.canvas, color.textPrimary, 0.07),
    '--surface-hover': mixHex(color.canvas, color.textPrimary, 0.1),
    '--surface-active': mixHex(color.canvas, color.textPrimary, 0.14),
    '--surface-overlay': mixHex(color.canvas, color.textPrimary, 0.08),
  } as const
  for (const [property, value] of Object.entries(surfaces)) {
    root.style.setProperty(property, value)
    root.style.setProperty(`${property}-rgb`, rgbCss(value))
  }
  const semanticPairs: Array<[string, string]> = [
    ['--content-normal', color.textPrimary],
    ['--content-primary', color.textPrimary],
    ['--content-secondary', color.textSecondary],
    ['--content-muted', color.textSecondary],
    ['--border-default', color.rule],
    ['--border-emphasis', color.rule],
    ['--border-control', color.rule],
    ['--accent', color.accent],
    ['--accent-hover', color.accent],
    ['--accent-muted', color.accent],
  ]
  for (const [property, value] of semanticPairs) {
    root.style.setProperty(property, value)
    root.style.setProperty(`${property}-rgb`, rgbCss(value))
  }
  root.style.setProperty('--border-subtle', color.rule)
  root.style.setProperty('--border-strong', color.rule)
  root.style.setProperty('--presence-dot-online', color.presence)
  const avatarProperties = [
    '--avatar-sand',
    '--avatar-blue',
    '--avatar-green',
    '--avatar-red',
    '--avatar-violet',
    '--avatar-orange',
    '--avatar-pink',
    '--avatar-emerald',
  ]
  OPTIONAL_COLOR_KEYS.forEach((key, index) => {
    if (color[key]) root.style.setProperty(avatarProperties[index], color[key]!)
  })
  root.dataset.importedTheme = manifest.id
  return true
}

export function applyConfirmedTheme(mode: 'dark' | 'light' | 'high-contrast'): boolean {
  const library = readThemeLibrary()
  const active = library.packages.find(
    (entry) => entry.manifest.id === library.activePackageId && entry.hash === library.activePackageHash,
  )
  return applyThemeManifest(active?.manifest ?? null, mode)
}

function sameThemeState(left: ConfirmedThemeState | undefined, right: ConfirmedThemeState): boolean {
  return left?.packageId === right.packageId
    && left?.packageHash === right.packageHash
    && left?.baseTheme === right.baseTheme
}

export function confirmThemePackage(
  validated: ValidatedThemePackage,
  baseTheme: ThemeModeName,
  now = new Date(),
): ThemeLibrary {
  const library = readThemeLibrary()
  const confirmedAt = now.toISOString()
  const current: ConfirmedThemeState = {
    packageId: library.activePackageId,
    packageHash: library.activePackageHash,
    baseTheme,
    confirmedAt,
  }
  const next: ConfirmedThemeState = {
    packageId: validated.manifest.id,
    packageHash: validated.hash,
    baseTheme,
    confirmedAt,
  }
  const history = [...library.history]
  if (!sameThemeState(history[history.length - 1], current)) history.push(current)
  if (!sameThemeState(history[history.length - 1], next)) history.push(next)
  const updated: ThemeLibrary = {
    schemaVersion: 1,
    packages: [
      ...library.packages.filter((entry) => entry.manifest.id !== validated.manifest.id),
      { manifest: validated.manifest, hash: validated.hash, confirmedAt },
    ].slice(-32),
    activePackageId: validated.manifest.id,
    activePackageHash: validated.hash,
    history: history.slice(-MAX_THEME_HISTORY),
  }
  writeThemeLibrary(updated)
  applyThemeManifest(validated.manifest, baseTheme)
  return updated
}

export function resetConfirmedTheme(baseTheme: ThemeModeName, now = new Date()): ThemeLibrary {
  const library = readThemeLibrary()
  const next: ConfirmedThemeState = {
    packageId: null,
    packageHash: null,
    baseTheme,
    confirmedAt: now.toISOString(),
  }
  const history = [...library.history]
  if (!sameThemeState(history[history.length - 1], next)) history.push(next)
  const updated = {
    ...library,
    activePackageId: null,
    activePackageHash: null,
    history: history.slice(-MAX_THEME_HISTORY),
  }
  writeThemeLibrary(updated)
  clearThemePreview()
  return updated
}

export function rollbackConfirmedTheme(): ConfirmedThemeState | null {
  const library = readThemeLibrary()
  if (library.history.length < 2) return null
  const history = library.history.slice(0, -1)
  const target = history[history.length - 1]!
  const targetPackage = target.packageId && target.packageHash
    ? library.packages.find(
        (entry) => entry.manifest.id === target.packageId && entry.hash === target.packageHash,
      )
    : null
  const updated: ThemeLibrary = {
    ...library,
    activePackageId: targetPackage?.manifest.id ?? null,
    activePackageHash: targetPackage?.hash ?? null,
    history,
  }
  writeThemeLibrary(updated)
  applyThemeManifest(targetPackage?.manifest ?? null, target.baseTheme)
  return target
}

export function removeStoredTheme(packageId: string): ThemeLibrary {
  const library = readThemeLibrary()
  if (library.activePackageId === packageId) {
    throw new ThemePackageError('Reset the active imported theme before removing it.')
  }
  const updated = {
    ...library,
    packages: library.packages.filter((entry) => entry.manifest.id !== packageId),
    history: library.history.filter((entry) => entry.packageId !== packageId),
  }
  writeThemeLibrary(updated)
  return updated
}

export function serializeStoredTheme(packageId: string): string | null {
  const stored = readThemeLibrary().packages.find((entry) => entry.manifest.id === packageId)
  if (!stored) return null
  return `${JSON.stringify(JSON.parse(normalizeThemeManifest(stored.manifest)), null, 2)}\n`
}

export function saveThemeFile(serialized: string, fileName: string): void {
  if (new TextEncoder().encode(serialized).byteLength > MAX_THEME_PACKAGE_BYTES) {
    throw new ThemePackageError('The theme package is larger than 64 KiB.')
  }
  const safeName = fileName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'mesh-theme'
  const blob = new Blob([serialized], { type: MESH_THEME_MIME })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = safeName.toLocaleLowerCase().endsWith('.meshtheme')
    ? safeName
    : `${safeName}.meshtheme`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
