/**
 * The terminal's alternate screen, which a surface that owns the whole
 * terminal draws on.
 *
 * A terminal keeps two screens. The main one is the conversation's own
 * scrollback, which every line the application has ever printed belongs to;
 * the alternate one is a scratch screen exactly `terminal.rows` tall with no
 * scrollback at all, the screen a pager or an editor runs on. Switching to it
 * saves the main screen, and switching back restores it unchanged: the
 * surface drawn here cannot rewrite a line of the conversation, cannot scroll
 * one out of the viewport, and leaves nothing of itself behind when it goes -
 * none of which an overlay drawn over the conversation can promise, because
 * its rows are the main screen's rows and become its scrollback.
 *
 * The screen is addressed by absolute row: every line is drawn where it
 * belongs rather than by printing downward, so nothing here ever scrolls the
 * terminal. Each paint writes only the rows whose text changed since the last
 * one, wrapped in one synchronized-output pair so the terminal shows whole
 * frames.
 * @module @deepseek-ai/dsh-tui-app/alt-screen
 */

import { type Terminal } from '@earendil-works/pi-tui'

/** Switch to the alternate screen, saving the main one. */
const ENTER = '\u001b[?1049h'

/** Switch back to the main screen, restoring it as it was. */
const LEAVE = '\u001b[?1049l'

/** Clear the whole screen. */
const CLEAR = '\u001b[2J'

/** Clear the row the cursor is on. */
const CLEAR_ROW = '\u001b[2K'

/** Stop drawing the terminal's own caret. */
const HIDE_CARET = '\u001b[?25l'

/** Draw the terminal's own caret again. */
const SHOW_CARET = '\u001b[?25h'

/**
 * Stop wrapping at the right margin, so a line that fills the last row cannot
 * scroll the screen.
 */
const NO_AUTOWRAP = '\u001b[?7l'

/** Wrap at the right margin again, which is what the conversation needs. */
const AUTOWRAP = '\u001b[?7h'

/** Hold the frame back until every row of it has been written. */
const BEGIN_FRAME = '\u001b[?2026h'

/** Show the frame. */
const END_FRAME = '\u001b[?2026l'

/**
 * The alternate screen as one surface: enter it, paint frames on it, leave it.
 *
 * Entering and leaving are balanced and idempotent, so a caller that takes the
 * terminal twice, or gives it back twice, still leaves the terminal on the
 * screen it started on.
 */
export class AlternateScreen {
  /** The rows the last paint left on the screen, which the next one is drawn against. */
  private drawn: string[] = []
  /** The terminal width the drawn rows were written at, so a resize repaints them all. */
  private drawnWidth = 0
  private entered = false

  /**
   * @param terminal - the terminal whose two screens these are.
   */
  constructor(private readonly terminal: Terminal) {}

  /** Whether the alternate screen is the one the terminal is showing. */
  get active(): boolean {
    return this.entered
  }

  /**
   * Take the terminal, saving the main screen and clearing this one.
   *
   * The caret is the surface's to draw, and none of the surfaces here draw
   * one, so it is hidden for as long as this screen is up.
   */
  enter(): void {
    if (this.entered) return
    this.entered = true
    this.drawn = []
    this.drawnWidth = this.terminal.columns
    this.terminal.write(`${ENTER}${NO_AUTOWRAP}${HIDE_CARET}${CLEAR}`)
  }

  /**
   * Draw one frame.
   * @param lines - the frame, one entry per screen row from the top; rows the
   * frame no longer has are cleared. Nothing is written while the main screen
   * is the one the terminal shows.
   */
  paint(lines: readonly string[]): void {
    if (!this.entered) return
    // A terminal that resized cleared this screen itself, and every row it
    // still holds was wrapped for the old width.
    if (this.terminal.columns !== this.drawnWidth) {
      this.drawn = []
      this.drawnWidth = this.terminal.columns
    }
    let frame = BEGIN_FRAME
    for (const [row, line] of lines.entries()) {
      if (this.drawn[row] === line) continue
      frame += `${cursorTo(row)}${CLEAR_ROW}${line}`
    }
    for (let row = lines.length; row < this.drawn.length; row += 1) frame += `${cursorTo(row)}${CLEAR_ROW}`
    this.drawn = [...lines]
    frame += END_FRAME
    this.terminal.write(frame)
  }

  /**
   * Give the terminal back, which restores the main screen exactly as it was
   * when {@link AlternateScreen.enter} saved it.
   */
  leave(): void {
    if (!this.entered) return
    this.entered = false
    this.drawn = []
    this.terminal.write(`${BEGIN_FRAME}${LEAVE}${AUTOWRAP}${SHOW_CARET}${END_FRAME}`)
  }
}

/**
 * Move the cursor to the first column of one screen row.
 * @param row - the row, counted from 0 at the top of the screen.
 * @returns the escape sequence that puts the cursor there.
 */
function cursorTo(row: number): string {
  return `\u001b[${String(row + 1)};1H`
}
