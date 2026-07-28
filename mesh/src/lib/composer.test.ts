import { describe, expect, it } from 'vitest'
import {
  expandSlashCommand,
  getSlashCommandContext,
  getSlashCommandSuggestions,
  toggleMarkdownFormat,
} from './composer'

describe('slash command suggestions', () => {
  it('offers local commands only while the initial command token is being typed', () => {
    expect(getSlashCommandContext('/', 1)).toEqual({ start: 0, end: 1, query: '' })
    expect(getSlashCommandSuggestions('s').map(({ command }) => command)).toEqual(['/shrug'])
    expect(getSlashCommandSuggestions('M').map(({ command }) => command)).toEqual(['/me'])
    expect(getSlashCommandContext('hello /', 7)).toBeNull()
    expect(getSlashCommandContext('/shrug hello', 12)).toBeNull()
  })
})

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

  it('wraps a selection and keeps the inner text selected', () => {
    expect(toggleMarkdownFormat('hello world', 6, 11, 'bold')).toEqual({
      value: 'hello **world**',
      selectionStart: 8,
      selectionEnd: 13,
    })
  })

  it('toggles an existing wrapper off and places an empty cursor between markers', () => {
    expect(toggleMarkdownFormat('**hello**', 0, 9, 'bold')).toEqual({
      value: 'hello',
      selectionStart: 0,
      selectionEnd: 5,
    })
    expect(toggleMarkdownFormat('hello', 5, 5, 'code')).toEqual({
      value: 'hello``',
      selectionStart: 6,
      selectionEnd: 6,
    })
  })
})
