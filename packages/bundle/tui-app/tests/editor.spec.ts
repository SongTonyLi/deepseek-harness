/** The prompt editor leaves the caret to the terminal's own bar cursor. */

import { describe, expect, it } from 'vitest'
import { CURSOR_MARKER, Editor, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import { BarCursorEditor, SET_BLINKING_BAR_CURSOR, SET_TERMINAL_DEFAULT_CURSOR, stripBlockCursor } from '../src/editor.ts'
import { createPalette, editorTheme } from '../src/style.ts'
import { FakeTerminal, KEY } from './bench.ts'

/** Reverse video, which pi-tui draws the block cursor with. */
const REVERSE_VIDEO = '\u001b[7m'

/** SGR reset, which closes the block cursor and any typed reverse video. */
const RESET = '\u001b[0m'

const WIDTH = 20

/**
 * Drive the stock pi-tui editor and the subclass through the same text, keys,
 * and focus, so every assertion can name what the subclass changed.
 * @param text - the text to put in both editors.
 * @param presses - keys typed after the text, e.g. arrows that move the caret.
 * @param focused - whether the editors hold the keyboard.
 * @returns both renders, line for line.
 */
function renderBoth(text: string, presses: readonly string[] = [], focused = true): { stock: string[]; bar: string[] } {
  const theme = editorTheme(createPalette(false))
  const build = (editor: Editor): string[] => {
    editor.setText(text)
    for (const press of presses) editor.handleInput(press)
    editor.focused = focused
    return editor.render(WIDTH)
  }
  return {
    stock: build(new Editor(new TuiMainScreen(new FakeTerminal()), theme, { paddingX: 1 })),
    bar: build(new BarCursorEditor(new TuiMainScreen(new FakeTerminal()), theme, { paddingX: 1 })),
  }
}

/** The column the terminal cursor is placed at, or -1 when no marker is drawn. */
function markerColumn(line: string): number {
  const marker = line.indexOf(CURSOR_MARKER)
  return marker === -1 ? -1 : visibleWidth(line.slice(0, marker))
}

describe('BarCursorEditor', () => {
  it('removes the block a caret inside the text sits on and keeps the character', () => {
    const { stock, bar } = renderBoth('hello', [KEY.left, KEY.left])
    expect(stock[1]).toContain(`${REVERSE_VIDEO}l${RESET}`)
    const line = bar[1] ?? ''
    expect(line).not.toContain(REVERSE_VIDEO)
    expect(line.replace(CURSOR_MARKER, '')).toBe(` hello${' '.repeat(14)}`)
    expect(visibleWidth(line)).toBe(visibleWidth(stock[1] ?? ''))
    expect(visibleWidth(line)).toBe(WIDTH)
    // The marker survives at its column, so pi-tui still puts the terminal
    // cursor on the character the caret is on.
    expect(markerColumn(line)).toBe(markerColumn(stock[1] ?? ''))
    expect(markerColumn(line)).toBe(4)
  })

  it('removes the block a caret past the last character sits on and keeps the width', () => {
    const { stock, bar } = renderBoth('hello')
    expect(stock[1]).toContain(`${REVERSE_VIDEO} ${RESET}`)
    const line = bar[1] ?? ''
    expect(line).not.toContain(REVERSE_VIDEO)
    expect(line.replace(CURSOR_MARKER, '')).toBe(` hello${' '.repeat(14)}`)
    expect(visibleWidth(line)).toBe(visibleWidth(stock[1] ?? ''))
    expect(visibleWidth(line)).toBe(WIDTH)
    expect(markerColumn(line)).toBe(markerColumn(stock[1] ?? ''))
    expect(markerColumn(line)).toBe(6)
  })

  it('removes the marker with the block while unfocused, so the terminal cursor stays with the keyboard', () => {
    // pi-tui draws the block whether or not the editor is focused and emits
    // the marker only while it is focused, so an unfocused editor would
    // otherwise keep a caret no keystroke answers to.
    const { stock, bar } = renderBoth('hello', [KEY.left], false)
    expect(stock[1]).toContain(`${REVERSE_VIDEO}o${RESET}`)
    expect(stock[1]).not.toContain(CURSOR_MARKER)
    const line = bar[1] ?? ''
    expect(line).not.toContain(REVERSE_VIDEO)
    expect(line).not.toContain(CURSOR_MARKER)
    expect(line).toBe(` hello${' '.repeat(14)}`)
    expect(visibleWidth(line)).toBe(visibleWidth(stock[1] ?? ''))
  })

  it('keeps reverse video the user typed, because the removal is anchored at the caret marker', () => {
    const typed = `a${REVERSE_VIDEO}X${RESET}b`
    const { stock, bar } = renderBoth(typed)
    const line = bar[1] ?? ''
    expect(line).toContain(typed)
    // Only the pair pi-tui drew after the marker is gone.
    expect(line.split(REVERSE_VIDEO)).toHaveLength(2)
    expect((stock[1] ?? '').split(REVERSE_VIDEO)).toHaveLength(3)
    expect(visibleWidth(line)).toBe(visibleWidth(stock[1] ?? ''))
  })

  it('changes nothing else: borders, padding, and line count stay as pi-tui rendered them', () => {
    const { stock, bar } = renderBoth('one\ntwo', [KEY.up])
    expect(bar).toHaveLength(stock.length)
    expect(bar).toEqual(stock.map(stripBlockCursor))
  })
})

describe('stripBlockCursor', () => {
  it('removes only the reverse-video pair that follows the marker', () => {
    expect(stripBlockCursor(`ab${CURSOR_MARKER}${REVERSE_VIDEO}c${RESET}d`)).toBe(`ab${CURSOR_MARKER}cd`)
  })

  it('returns a line with no marker unchanged', () => {
    const line = `plain ${REVERSE_VIDEO}text${RESET}`
    expect(stripBlockCursor(line)).toBe(line)
  })

  it('returns a marker the reverse-video pair does not follow unchanged', () => {
    const line = `ab${CURSOR_MARKER}cd`
    expect(stripBlockCursor(line)).toBe(line)
  })

  it('returns a reverse-video run with no reset after it unchanged, because its end is unknown', () => {
    const line = `ab${CURSOR_MARKER}${REVERSE_VIDEO}cd`
    expect(stripBlockCursor(line)).toBe(line)
  })
})

describe('cursor shape sequences', () => {
  it('are the exact DECSCUSR sequences for a blinking bar and the terminal default', () => {
    expect(SET_BLINKING_BAR_CURSOR).toBe('\u001b[5 q')
    expect(SET_TERMINAL_DEFAULT_CURSOR).toBe('\u001b[0 q')
    const terminal = new FakeTerminal()
    terminal.write(SET_BLINKING_BAR_CURSOR)
    terminal.write(SET_TERMINAL_DEFAULT_CURSOR)
    expect(terminal.output).toBe('\u001b[5 q\u001b[0 q')
    // Both are well-formed CSI sequences, so screen assertions never see them.
    expect(terminal.text()).toBe('')
  })
})
