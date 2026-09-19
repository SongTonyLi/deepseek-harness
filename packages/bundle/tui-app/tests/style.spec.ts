/** Palette roles, color detection, and the derived pi-tui themes. */

import { describe, expect, it } from 'vitest'
import { colorEnabled, createPalette, editorTheme, markdownTheme, paintDiffRows, selectListTheme } from '../src/style.ts'

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

  it('paints additions green and removals red without changing context rows', () => {
    const source = ['+ add', '- remove', '  keep', '@@ hunk']
    expect(paintDiffRows(source, source, createPalette(true))).toEqual([
      '\u001b[32m+ add\u001b[39m',
      '\u001b[31m- remove\u001b[39m',
      '  keep',
      '@@ hunk',
    ])
    expect(paintDiffRows(source, source, createPalette(false))).toEqual(source)
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
    const { highlightCode, ...styles } = markdown
    for (const style of Object.values(styles)) {
      expect(typeof style).toBe('function')
      expect((style as (text: string) => string)('t')).toContain('t')
    }
    expect(markdown.codeBlock('code')).toBe('code')
    // With no highlighter the fence draws exactly the source lines, which is
    // what the renderer would have drawn without the hook at all.
    expect(highlightCode?.('one\ntwo', 'ts')).toEqual(['one', 'two'])
    expect(markdownTheme(palette, { lines: () => ['lit'] }).highlightCode?.('one', 'ts')).toEqual(['lit'])
    const select = selectListTheme(palette)
    expect(select.selectedText('s')).toContain('s')
    expect(editorTheme(palette).borderColor('b')).toContain('b')
  })
})
