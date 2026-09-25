/** Palette roles, color detection, and the derived pi-tui themes. */

import { describe, expect, it } from 'vitest'
import { bandDiffRows, bandRow, colorEnabled, createPalette, editorTheme, markdownTheme, paintDiffRows, selectListTheme } from '../src/style.ts'

describe('palette', () => {
  it('wraps text in SGR pairs when enabled and returns it verbatim otherwise', () => {
    const on = createPalette(true)
    expect(on.accent('x')).toBe('\u001b[36mx\u001b[39m')
    expect(on.heading('x')).toBe('\u001b[38;5;215mx\u001b[39m')
    expect(on.link('x')).toBe('\u001b[38;5;141mx\u001b[39m')
    expect(on.bold('x')).toBe('\u001b[1mx\u001b[22m')
    expect(on.underline('x')).toBe('\u001b[4mx\u001b[24m')
    expect(on.strikethrough('x')).toBe('\u001b[9mx\u001b[29m')
    expect(on.enabled).toBe(true)
    const off = createPalette(false)
    expect(off.accent('x')).toBe('x')
    expect(off.heading('x')).toBe('x')
    expect(off.link('x')).toBe('x')
    expect(off.inverse('x')).toBe('x')
    expect(off.enabled).toBe(false)
  })

  it('lays a row on the background band across the full width, and leaves it bare without color', () => {
    const on = createPalette(true)
    expect(on.band('x')).toBe('\u001b[48;5;236mx\u001b[49m')
    expect(bandRow(on, on.bold('ab'), 5)).toBe('\u001b[48;5;236m\u001b[1mab\u001b[22m   \u001b[49m')
    const off = createPalette(false)
    expect(off.band('x')).toBe('x')
    expect(bandRow(off, 'ab', 5)).toBe('ab')
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

  it('fills each changed row edge to edge and leaves the rows around it bare', () => {
    const on = createPalette(true)
    const rows = ['  keep', '- old', '+ new', '  tail']
    const marks = [undefined, 'removed' as const, 'added' as const, undefined]
    expect(bandDiffRows(rows, rows, marks, 10, on)).toEqual([
      '  keep',
      on.removedBand(`${on.removedSign('-')} old     `),
      on.addedBand(`${on.addedSign('+')} new     `),
      '  tail',
    ])
  })

  it('paints the sign after the file line the diff numbers its rows with', () => {
    const on = createPalette(true)
    const row = ' 12 + const x = 1'
    expect(bandDiffRows([row], [row], ['added'], 20, on))
      .toEqual([on.addedBand(` 12 ${on.addedSign('+')} const x = 1   `)])
  })

  it('carries the fill onto a wrapped continuation, which draws no sign of its own', () => {
    const on = createPalette(true)
    expect(bandDiffRows(['+ abc defghi'], ['+ abc defghi'], ['added'], 8, on)).toEqual([
      on.addedBand(`${on.addedSign('+')} abc   `),
      on.addedBand('defghi  '),
    ])
  })

  it('pads nothing and fills nothing without color', () => {
    expect(bandDiffRows(['+ ab'], ['+ ab'], ['added'], 12, createPalette(false))).toEqual(['+ ab'])
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
    expect(markdown.heading('H')).toBe(palette.bold(palette.heading('H')))
    expect(markdown.link('L')).toBe(palette.underline(palette.link('L')))
    expect(markdown.listBullet('•')).toBe(palette.heading('•'))
    expect(markdown.quote('q')).toBe(palette.italic(palette.dim('q')))
    expect(markdown.quoteBorder('│')).toBe(palette.dim('│'))
    expect(markdown.code('c')).toBe(palette.link('c'))
    expect(markdown.heading('H')).not.toBe(palette.bold(palette.accent('H')))
    expect(markdown.link('L')).not.toBe(palette.accent('L'))
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
