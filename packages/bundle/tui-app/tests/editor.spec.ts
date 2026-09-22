/** The prompt editor leaves the caret to the terminal's own bar cursor. */

import { describe, expect, it } from 'vitest'
import { CURSOR_MARKER, Editor, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import {
  BarCursorEditor,
  SET_BLINKING_BAR_CURSOR,
  SET_TERMINAL_DEFAULT_CURSOR,
  paintShellEditorLines,
  stripBlockCursor,
  type ShellEditorPaint,
} from '../src/editor.ts'
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
  it('moves across space-separated words with Shift+Left and Shift+Right', () => {
    const editor = new BarCursorEditor(
      new TuiMainScreen(new FakeTerminal()),
      editorTheme(createPalette(false)),
      { paddingX: 1 },
    )
    editor.setText('I want to do')
    editor.handleInput(KEY.shiftLeft)
    editor.handleInput('|')
    expect(editor.getText()).toBe('I want to |do')
    editor.handleInput(KEY.backspace)
    editor.handleInput(KEY.shiftRight)
    editor.handleInput('|')
    expect(editor.getText()).toBe('I want to do|')
  })

  it('recognizes Kitty Shift+Arrow reports for word movement', () => {
    const editor = new BarCursorEditor(
      new TuiMainScreen(new FakeTerminal()),
      editorTheme(createPalette(false)),
    )
    editor.setText('I want to do')
    editor.handleInput('\u001b[57417;2u')
    expect(editor.getCursor()).toEqual({ line: 0, col: 10 })
    editor.handleInput('\u001b[57418;2u')
    expect(editor.getCursor()).toEqual({ line: 0, col: 12 })
  })

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

/** A zero-width colour wrap so painted text keeps the plain visible width. */
function colorWrap(code: string): string[] {
  return code.split('\n').map(line => `\u001b[38;2;1;2;3m${line}\u001b[39m`)
}

/** Warning wrap used for the bang in paint tests. */
function warning(text: string): string {
  return `\u001b[33m${text}\u001b[39m`
}

/** A shell paint that colours every command line without changing its width. */
function shellPaint(overrides: Partial<ShellEditorPaint> = {}): ShellEditorPaint {
  return {
    highlight: { lines: code => colorWrap(code) },
    warning,
    paddingX: 1,
    ...overrides,
  }
}

/**
 * Render a draft through the bar-cursor editor with shell paint attached.
 * @param text - the editor text.
 * @param paint - the shell paint, or undefined to leave the editor unpainted.
 * @param presses - keys typed after the text.
 * @param focused - whether the editor holds the keyboard.
 * @returns the rendered lines.
 */
function renderShell(
  text: string,
  paint: ShellEditorPaint | undefined = shellPaint(),
  presses: readonly string[] = [],
  focused = true,
): string[] {
  const editor = new BarCursorEditor(
    new TuiMainScreen(new FakeTerminal()),
    editorTheme(createPalette(false)),
    { paddingX: 1 },
  )
  editor.shellPaint = paint
  editor.setText(text)
  for (const press of presses) editor.handleInput(press)
  editor.focused = focused
  return editor.render(WIDTH)
}

describe('shell draft colour', () => {
  it('paints the bang in warning and the command in syntax colour', () => {
    const lines = renderShell('!echo hi')
    const content = lines[1] ?? ''
    expect(content).toContain(warning('!'))
    expect(content).toContain('\u001b[38;2;1;2;3mecho hi\u001b[39m')
    expect(content).toContain(CURSOR_MARKER)
    expect(visibleWidth(content)).toBe(WIDTH)
    expect(lines[0]).toMatch(/─/u)
    expect(lines.at(-1)).toMatch(/─/u)
  })

  it('paints !! as the bang and leaves a non-shell draft unchanged', () => {
    const bang = renderShell('!!true')[1] ?? ''
    expect(bang).toContain(warning('!!'))
    expect(bang).toContain('\u001b[38;2;1;2;3mtrue\u001b[39m')
    const plain = renderShell('hello')
    const unpainted = renderShell('hello', undefined)
    expect(plain[1]?.replace(CURSOR_MARKER, '')).toBe(unpainted[1]?.replace(CURSOR_MARKER, ''))
    expect(plain[1]).not.toContain('\u001b[38;2;1;2;3m')
  })

  it('paints the bang while the grammar is still loading', () => {
    const lines = renderShell('!echo hi', shellPaint({ highlight: { lines: () => undefined } }))
    const content = lines[1] ?? ''
    expect(content).toContain(warning('!'))
    expect(content).toContain('echo hi')
    expect(content).not.toContain('\u001b[38;2;1;2;3m')
  })

  it('keeps the caret marker at its column on a coloured command', () => {
    const lines = renderShell('!echo hi', shellPaint(), [KEY.left, KEY.left])
    const content = lines[1] ?? ''
    expect(content).toContain(CURSOR_MARKER)
    expect(content.indexOf(CURSOR_MARKER)).toBeLessThan(content.indexOf('hi') === -1 ? content.length : content.indexOf('hi') + 2)
    expect(visibleWidth(content)).toBe(WIDTH)
  })

  it('leaves a chunk plain when the highlighter changes its visible width', () => {
    const lines = renderShell('!echo', shellPaint({
      highlight: { lines: code => code.split('\n').map(line => `«${line}»`) },
    }))
    const content = lines[1] ?? ''
    expect(content).toContain(warning('!'))
    expect(content).toContain('echo')
    expect(content).not.toContain('«echo»')
    expect(visibleWidth(content)).toBe(WIDTH)
  })

  it('paints wrapped and multi-line drafts without touching the rules', () => {
    const long = `!echo ${'x'.repeat(30)}`
    const wrapped = renderShell(long)
    expect(wrapped[1]).toContain(warning('!'))
    expect(wrapped[1]).toContain('\u001b[38;2;1;2;3mecho ')
    expect(wrapped.some((line, index) => index > 1 && line.includes('\u001b[38;2;1;2;3mx'))).toBe(true)
    expect(wrapped[0]).toMatch(/─/u)
    const broken = renderShell(`!${'x'.repeat(40)}`)
    expect(broken.filter(line => line.includes('\u001b[38;2;1;2;3m')).length).toBeGreaterThan(1)
    const scrolled = paintShellEditorLines(
      ['─'.repeat(WIDTH), ` ${'x'.repeat(18)} `],
      `!echo ${'x'.repeat(30)}`,
      WIDTH,
      shellPaint(),
    )
    expect(scrolled[1]).toContain('\u001b[38;2;1;2;3mx')
    const multi = renderShell('!echo hi\n\nls -la')
    expect(multi.some(line => line.includes('\u001b[38;2;1;2;3mls -la\u001b[39m'))).toBe(true)
    expect(multi.some(line => line.includes(warning('!')))).toBe(true)
  })

  it('paints while unfocused and falls back when the highlighter row count misses', () => {
    const unfocused = renderShell('!echo hi', shellPaint(), [], false)
    expect(unfocused[1]).not.toContain(CURSOR_MARKER)
    expect(unfocused[1]).toContain(warning('!'))
    expect(unfocused[1]).toContain('\u001b[38;2;1;2;3mecho hi\u001b[39m')
    const missed = renderShell('!echo', shellPaint({ highlight: { lines: () => ['a', 'b'] } }))
    expect(missed[1]).toContain(warning('!'))
    expect(missed[1]).toContain('echo')
    expect(missed[1]).not.toContain('\u001b[38;2;1;2;3mecho')
    const open = paintShellEditorLines(
      ['─'.repeat(WIDTH), ` !echo hi${' '.repeat(WIDTH - 10)}`],
      '!echo hi',
      WIDTH,
      shellPaint(),
    )
    expect(open[1]).toContain('\u001b[38;2;1;2;3mecho hi\u001b[39m')
  })

  it('paints an indented lone bang and skips lines that are not content', () => {
    const bang = renderShell('  !')[1] ?? ''
    expect(bang).toContain(warning('!'))
    const lead = renderShell('\n!echo hi')
    expect(lead.some(line => line.includes(warning('!')))).toBe(true)
    expect(lead.some(line => line.includes('\u001b[38;2;1;2;3mecho hi\u001b[39m'))).toBe(true)
    const painted = paintShellEditorLines(
      ['─'.repeat(WIDTH), ' not-a-pad', '─'.repeat(WIDTH), ' extra'],
      '!echo hi',
      WIDTH,
      shellPaint(),
    )
    expect(painted[1]).toBe(' not-a-pad')
    expect(painted[3]).toBe(' extra')
    expect(paintShellEditorLines([], 'hello', WIDTH, shellPaint())).toEqual([])
    expect(paintShellEditorLines(['─'.repeat(WIDTH)], '!echo', WIDTH, shellPaint({ paddingX: 0 }))[0])
      .toMatch(/─/u)
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
