import { describe, expect, it } from 'vitest'
import { expandSlashCommand } from './composer'

describe('expandSlashCommand', () => {
  it('expands shrug with and without a message', () => {
    expect(expandSlashCommand('/shrug')).toBe('¯\\_(ツ)_/¯')
    expect(expandSlashCommand('/shrug hello everyone')).toBe('hello everyone ¯\\_(ツ)_/¯')
  })

  it('formats /me as markdown italic text', () => {
    expect(expandSlashCommand('/me waves')).toBe('*waves*')
    expect(expandSlashCommand('/ME waves')).toBe('*waves*')
    expect(expandSlashCommand('/me')).toBe('/me')
  })

  it('leaves ordinary text and unsupported commands untouched', () => {
    expect(expandSlashCommand('hello /shrug')).toBe('hello /shrug')
    expect(expandSlashCommand('/nick Mesh')).toBe('/nick Mesh')
    expect(expandSlashCommand('  hello  ')).toBe('  hello  ')
  })
})
