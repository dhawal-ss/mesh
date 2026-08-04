import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyThemeManifest,
  confirmThemePackage,
  parseThemePackage,
  readThemeLibrary,
  resetConfirmedTheme,
  rollbackConfirmedTheme,
  ThemePackageError,
  validateThemeManifest,
} from './theme-package'

function validTheme(overrides: Record<string, unknown> = {}) {
  return {
    $schema: 'mesh.theme/1',
    id: 'org.example.campfire',
    name: 'Campfire',
    version: '1.0.0',
    author: 'Example author',
    modes: {
      dark: {
        color: {
          canvas: '#10100F',
          textPrimary: '#FFFFFF',
          textSecondary: '#B8B8B8',
          rule: '#6F6F6F',
          accent: '#F5B84B',
          presence: '#72D69A',
          avatar1: '#888888',
        },
      },
      light: {
        color: {
          canvas: '#FFFFFF',
          textPrimary: '#111111',
          textSecondary: '#595959',
          rule: '#767676',
          accent: '#7A3E00',
          presence: '#006B3C',
        },
      },
    },
    ...overrides,
  }
}

describe('mesh.theme/1 packages', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('style')
    delete document.documentElement.dataset.importedTheme
  })

  it('normalizes approved colors and computes a stable package hash', async () => {
    const parsed = await parseThemePackage(JSON.stringify(validTheme()), {
      fileName: 'campfire.meshtheme',
      mimeType: 'application/vnd.mesh.theme+json',
    })

    expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.modes).toEqual(['dark', 'light'])
    expect(parsed.manifest.modes.dark?.color.canvas).toBe('#10100F')
    expect(parsed.serialized).toContain('"$schema": "mesh.theme/1"')
  })

  it('rejects duplicate, unknown, and locked keys instead of ignoring them', async () => {
    const duplicate = JSON.stringify(validTheme()).replace(
      '"name":"Campfire"',
      '"name":"Campfire","name":"Duplicate"',
    )
    await expect(parseThemePackage(duplicate)).rejects.toThrow('repeats the key name')

    const locked = validTheme()
    ;(locked.modes.dark.color as Record<string, string>).danger = '#FFFFFF'
    expect(() => validateThemeManifest(locked)).toThrow('unsupported or locked key')

    expect(() => validateThemeManifest(validTheme({ unexpected: true }))).toThrow(
      'unsupported or locked key',
    )
  })

  it('rejects future schemas, executable references, alpha colors, and unsafe contrast', async () => {
    expect(() => validateThemeManifest(validTheme({ $schema: 'mesh.theme/2' }))).toThrow(
      'does not support theme schema mesh.theme/2',
    )
    expect(() => validateThemeManifest(validTheme({ author: 'https://example.org/theme' }))).toThrow(
      'author must be plain text',
    )

    const alpha = validTheme()
    alpha.modes.dark.color.accent = '#F5B84B99'
    expect(() => validateThemeManifest(alpha)).toThrow('opaque 6-digit hex color')

    const lowContrast = validTheme()
    lowContrast.modes.dark.color.textPrimary = '#333333'
    expect(() => validateThemeManifest(lowContrast)).toThrow('needs at least 7:1 contrast')

    await expect(
      parseThemePackage(JSON.stringify(validTheme()), { fileName: 'campfire.json' }),
    ).rejects.toThrow('ending in .meshtheme')
  })

  it('applies only approved semantic colors and leaves safety tokens locked', async () => {
    const parsed = await parseThemePackage(JSON.stringify(validTheme()))
    const root = document.documentElement
    root.style.setProperty('--status-danger', '#DE0000')
    root.style.setProperty('--border-focus', '#00FFFF')

    expect(applyThemeManifest(parsed.manifest, 'dark')).toBe(true)
    expect(root.dataset.importedTheme).toBe('org.example.campfire')
    expect(root.style.getPropertyValue('--surface-canvas')).toBe('#10100F')
    expect(root.style.getPropertyValue('--accent')).toBe('#F5B84B')
    expect(root.style.getPropertyValue('--status-danger')).toBe('#DE0000')
    expect(root.style.getPropertyValue('--border-focus')).toBe('#00FFFF')

    expect(applyThemeManifest(parsed.manifest, 'high-contrast')).toBe(false)
    expect(root.dataset.importedTheme).toBeUndefined()
    expect(root.style.getPropertyValue('--accent')).toBe('')
    expect(root.style.getPropertyValue('--status-danger')).toBe('#DE0000')
  })

  it('keeps confirmed history, supports rollback, and preserves it after invalid input', async () => {
    const first = await parseThemePackage(JSON.stringify(validTheme()))
    confirmThemePackage(first, 'dark', new Date('2026-08-02T12:00:00.000Z'))

    const secondSource = validTheme({
      id: 'org.example.midnight',
      name: 'Midnight',
      version: '2.0.0',
    })
    const second = await parseThemePackage(JSON.stringify(secondSource))
    confirmThemePackage(second, 'dark', new Date('2026-08-02T12:01:00.000Z'))
    const beforeInvalid = readThemeLibrary()

    await expect(parseThemePackage('{"$schema":"mesh.theme/99"}')).rejects.toBeInstanceOf(
      ThemePackageError,
    )
    expect(readThemeLibrary()).toEqual(beforeInvalid)

    const rolledBack = rollbackConfirmedTheme()
    expect(rolledBack?.packageId).toBe('org.example.campfire')
    expect(readThemeLibrary().activePackageId).toBe('org.example.campfire')

    resetConfirmedTheme('dark')
    expect(readThemeLibrary().activePackageId).toBeNull()
    expect(document.documentElement.dataset.importedTheme).toBeUndefined()
  })
})
