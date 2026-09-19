/**
 * The prompt editor's caret and word navigation. pi-tui draws the caret cell
 * itself in reverse video; this module takes that block off the rendered lines,
 * names the DECSCUSR sequences for a blinking bar, and maps Shift+Left/Right to
 * pi-tui's word movement.
 * @module @deepseek-ai/dsh-tui-app/editor
 */

import { CURSOR_MARKER, Editor, matchesKey } from '@earendil-works/pi-tui'

/**
 * DECSCUSR `CSI 5 SP q` (`\x1b[5 q`): tell the terminal to draw its text
 * cursor as a blinking vertical bar.
 */
export const SET_BLINKING_BAR_CURSOR = '\u001b[5 q'

/**
 * DECSCUSR `CSI 0 SP q` (`\x1b[0 q`): tell the terminal to draw its text
 * cursor in the shape it is configured with, for the application to write
 * before it releases the terminal.
 */
export const SET_TERMINAL_DEFAULT_CURSOR = '\u001b[0 q'

/** Canonical Ctrl+Left sequence bound to pi-tui's word-backward action. */
const WORD_LEFT = '\u001b[1;5D'

/** Canonical Ctrl+Right sequence bound to pi-tui's word-forward action. */
const WORD_RIGHT = '\u001b[1;5C'

/** SGR reverse video on, which pi-tui opens its drawn block cursor with. */
const REVERSE_VIDEO_ON = '\u001b[7m'

/** SGR reset, which pi-tui closes its drawn block cursor with. */
const REVERSE_VIDEO_OFF = '\u001b[0m'

/**
 * Take pi-tui's drawn block cursor off one rendered editor line.
 *
 * The removal is anchored at `CURSOR_MARKER`, which pi-tui emits immediately
 * before the cell it draws: only the `\x1b[7m` / `\x1b[0m` pair that follows
 * the marker is deleted, so reverse video inside the text the user typed or
 * pasted is never touched. The cell's own character stays - or, past the last
 * character of the line, the space pi-tui drew instead - so the line keeps its
 * visible width and the marker keeps its column. A line with no marker, or a
 * marker the pair does not follow, comes back unchanged.
 * @param line - one line of `Editor.render` output.
 * @returns the line with the marker still in place and the block gone.
 */
export function stripBlockCursor(line: string): string {
  const marker = line.indexOf(CURSOR_MARKER)
  if (marker === -1) return line
  const block = marker + CURSOR_MARKER.length
  if (!line.startsWith(REVERSE_VIDEO_ON, block)) return line
  const cell = block + REVERSE_VIDEO_ON.length
  const close = line.indexOf(REVERSE_VIDEO_OFF, cell)
  if (close === -1) return line
  return line.slice(0, block) + line.slice(cell, close) + line.slice(close + REVERSE_VIDEO_OFF.length)
}

/**
 * The prompt editor drawn without pi-tui's block cursor.
 *
 * pi-tui's `Editor` always draws the caret cell in reverse video and
 * `EditorOptions` carries no switch for it, while the real terminal cursor is
 * placed from the `CURSOR_MARKER` the editor emits at the same position. This
 * subclass removes that block from the lines `render` returns so the
 * terminal's own cursor - which the application shapes with
 * `SET_BLINKING_BAR_CURSOR` - is the only caret on screen. It also gives
 * Shift+Left and Shift+Right the editor's existing word-backward and
 * word-forward actions. Text, autocomplete, padding, borders, scrolling,
 * submission, and history otherwise remain pi-tui's, and the component writes
 * to no terminal itself.
 *
 * pi-tui emits the marker only while the editor is focused, yet it draws the
 * block either way, so an unfocused editor would keep a caret while another
 * region holds the keyboard. `render` therefore turns the marker on for the
 * `super.render` call to anchor the removal, then drops the marker again when
 * the editor is not focused: the unfocused editor shows no caret, and the
 * terminal cursor stays with the region that owns the keyboard.
 */
export class BarCursorEditor extends Editor {
  /**
   * Handle Shift+Left and Shift+Right as pi-tui's word movements.
   * @param data - the bytes the terminal sent.
   */
  override handleInput(data: string): void {
    if (matchesKey(data, 'shift+left')) {
      super.handleInput(WORD_LEFT)
      return
    }
    if (matchesKey(data, 'shift+right')) {
      super.handleInput(WORD_RIGHT)
      return
    }
    super.handleInput(data)
  }

  /**
   * Render the editor without pi-tui's drawn block cursor.
   * @param width - the total width to lay the editor out in.
   * @returns the rendered lines, carrying `CURSOR_MARKER` only while focused.
   */
  override render(width: number): string[] {
    const focused = this.focused
    this.focused = true
    let lines: string[]
    try {
      lines = super.render(width)
    } finally {
      this.focused = focused
    }
    return lines.map((line) => {
      const stripped = stripBlockCursor(line)
      return focused ? stripped : stripped.replaceAll(CURSOR_MARKER, '')
    })
  }
}
