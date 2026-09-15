/** Palette roles, color detection, and the derived pi-tui themes. */

import { describe, expect, it } from 'vitest'
import { slashCommandCompletion } from '../src/completion.ts'
import { colorEnabled, createPalette, editorTheme, markdownTheme, selectListTheme } from '../src/style.ts'

describe('palette', () => {
  it('wraps text in SGR pairs when enabled and returns it verbatim otherwise', () => {
    const on = createPalette(true)
    expect(on.accent('x')).toBe('[36mx[39m')
    expect(on.bold('x')).toBe('[1mx[22m')
    expect(on.underline('x')).toBe('[4mx[24m')
    expect(on.enabled).toBe(true)
    const off = createPalette(false)
    expect(off.accent('x')).toBe('x')
    expect(off.inverse('x')).toBe('x')
    expect(off.enabled).toBe(false)
  })

  it('decides color from NO_COLOR, FORCE_COLOR, then the TTY', () => {
    expect(colorEnabled({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false)
    expect(colorEnabled({ NO_COLOR: '' }, true)).toBe(true)
    expect(colorEnabled({ FORCE_COLOR: '1' }, false)).toBe(true)
    expect(colorEnabled({ FORCE_COLOR: '0' }, false)).toBe(false)
    expect(colorEnabled({ FORCE_COLOR: '' }, false)).toBe(false)
    expect(colorEnabled({}, true)).toBe(true)
    expect(colorEnabled({}, false)).toBe(false)
  })

  it('derives complete themes', () => {
    const palette = createPalette(true)
    const markdown = markdownTheme(palette)
    for (const style of Object.values(markdown)) {
      expect(typeof style).toBe('function')
      expect((style as (text: string) => string)('t')).toContain('t')
    }
    expect(markdown.codeBlock('code')).toBe('code')
    const select = selectListTheme(palette)
    expect(select.selectedText('s')).toContain('s')
    expect(editorTheme(palette).borderColor('b')).toContain('b')
  })
})

describe('slash-command completion', () => {
  const provider = slashCommandCompletion(() => [
    { name: 'help', description: 'Show help' },
    { name: 'model', description: 'Pick a model' },
  ])
  const options = { signal: new AbortController().signal }

  it('suggests commands for the first token of the first line only', async () => {
    await expect(provider.getSuggestions(['/'], 0, 1, options)).resolves.toEqual({
      prefix: '/',
      items: [
        { value: '/help', label: '/help', description: 'Show help' },
        { value: '/model', label: '/model', description: 'Pick a model' },
      ],
    })
    await expect(provider.getSuggestions(['/mo'], 0, 3, options)).resolves.toEqual({
      prefix: '/mo',
      items: [{ value: '/model', label: '/model', description: 'Pick a model' }],
    })
    await expect(provider.getSuggestions(['/zzz'], 0, 4, options)).resolves.toBeNull()
    await expect(provider.getSuggestions(['/help now'], 0, 9, options)).resolves.toBeNull()
    await expect(provider.getSuggestions(['text', '/he'], 1, 3, options)).resolves.toBeNull()
    await expect(provider.getSuggestions(['hello'], 0, 5, options)).resolves.toBeNull()
    await expect(provider.getSuggestions([], 0, 0, options)).resolves.toBeNull()
  })

  it('replaces the typed prefix with the command and a trailing space', () => {
    expect(provider.applyCompletion(['/mo tail'], 0, 3, { value: '/model', label: '/model' }, '/mo'))
      .toEqual({ lines: ['/model  tail'], cursorLine: 0, cursorCol: 7 })
    expect(provider.applyCompletion([], 0, 0, { value: '/help', label: '/help' }, ''))
      .toEqual({ lines: ['/help '], cursorLine: 0, cursorCol: 6 })
  })
})
