/** Palette roles, color detection, and the derived pi-tui themes. */

import { describe, expect, it } from 'vitest'
import { colorEnabled, createPalette, editorTheme, markdownTheme, selectListTheme } from '../src/style.ts'

describe('palette', () => {
  it('wraps text in SGR pairs when enabled and returns it verbatim otherwise', () => {
    const on = createPalette(true)
    expect(on.accent('x')).toBe('\u001b[36mx\u001b[39m')
    expect(on.bold('x')).toBe('\u001b[1mx\u001b[22m')
    expect(on.underline('x')).toBe('\u001b[4mx\u001b[24m')
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
