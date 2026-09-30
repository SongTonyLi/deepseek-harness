/**
 * Pointer input for the terminal surface: a {@link Terminal} that turns the
 * terminal's mouse reports on while the application runs, answers them
 * before pi-tui sees any input, and presses a key by handing its bytes to the
 * same input callback a key press reaches.
 *
 * Mouse reports are what `mouse: true` trades for: while they are on, the
 * terminal sends the wheel and plain click-drag to the application instead of
 * scrolling its own scrollback or selecting text, which most terminals still
 * do with `Shift` (`Option` in iTerm2) held.
 *
 * The main screen draws into the terminal's scrollback from wherever the
 * shell left the cursor, so a click's screen row names no frame line by
 * itself. {@link PointerTerminal.locateCursor} asks the terminal where its
 * cursor is; the renderer knows which frame line it left the cursor on, and
 * the difference places every row.
 * @module @deepseek-ai/dsh-tui-app/pointer
 */

import type { Terminal } from '@earendil-works/pi-tui'

/** Report button presses and releases, encoded as SGR sequences. */
export const ENABLE_MOUSE = '\u001b[?1000h\u001b[?1006h'

/** Stop reporting the mouse, which gives the wheel and selection back to the terminal. */
export const DISABLE_MOUSE = '\u001b[?1006l\u001b[?1000l'

/** Device status report 6: the terminal answers with its cursor position. */
export const CURSOR_QUERY = '\u001b[6n'

/** One SGR mouse report: button code, 1-based column and row, `M` for a press and `m` for a release. */
const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/u

/** A legacy X10 mouse report, which a terminal ignoring SGR mode could still send. */
const X10_MOUSE = /^\u001b\[M[\s\S]{3}$/u

/** The answer to {@link CURSOR_QUERY}: 1-based row and column. */
const CURSOR_REPORT = /^\u001b\[(\d+);(\d+)R$/u

/** Button code bits that mark a motion or wheel report rather than a press or release. */
const NOT_A_BUTTON = 0b1110_0000

/** Button code of the left button, once the modifier bits are masked off. */
const LEFT_BUTTON = 0

/** The button bits of a button code, without the `Shift`, `Alt`, and `Ctrl` bits. */
const BUTTON_BITS = 0b11

/** One cell of the terminal, counted from 0 at the top-left corner. */
export interface Cell {
  /** The column. */
  readonly column: number
  /** The screen row. */
  readonly row: number
}

/** One parsed SGR mouse report. */
export interface PointerReport extends Cell {
  /** The raw button code, modifier and motion bits included. */
  readonly button: number
  /** True for a release, false for a press or motion. */
  readonly release: boolean
}

/**
 * Parse one SGR mouse report.
 * @param data - one input sequence.
 * @returns the report, or undefined when `data` is not an SGR mouse report.
 */
export function parsePointer(data: string): PointerReport | undefined {
  const match = SGR_MOUSE.exec(data)
  if (match === null) return undefined
  return {
    button: Number(match[1]),
    column: Number(match[2]) - 1,
    row: Number(match[3]) - 1,
    release: match[4] === 'm',
  }
}

/**
 * Whether a report is the left button itself going down or up, rather than
 * motion, the wheel, or another button.
 * @param report - the parsed report.
 * @returns true for a left press or release.
 */
function isLeftButton(report: PointerReport): boolean {
  return (report.button & NOT_A_BUTTON) === 0 && (report.button & BUTTON_BITS) === LEFT_BUTTON
}

/**
 * The terminal the tree renders into, with clicks reported on top of it.
 *
 * A click is a left press and a left release on the same cell; wheel ticks
 * reach the optional scroll callback. Other reports are consumed, so no mouse
 * report ever reaches the editor as typed text. Every other method is the
 * wrapped terminal's own.
 */
export class PointerTerminal implements Terminal {
  /** The callback pi-tui gave {@link PointerTerminal.start}, which a pressed key reaches. */
  private deliver: ((data: string) => void) | undefined
  /** Where the left button went down, until it comes up again. */
  private pressed: Cell | undefined
  /** What the next cursor report answers; set while one {@link CURSOR_QUERY} is unanswered. */
  private located: ((row: number) => void) | undefined

  /**
   * @param terminal - the terminal to report clicks on.
   * @param onClick - called with the cell of each click.
   * @param onScroll - called with -1 for wheel up and 1 for wheel down; omitted ignores scrolling.
   */
  constructor(
    private readonly terminal: Terminal,
    private readonly onClick: (cell: Cell) => void,
    private readonly onScroll?: (step: -1 | 1) => void,
  ) {}

  get columns(): number {
    return this.terminal.columns
  }

  get rows(): number {
    return this.terminal.rows
  }

  get kittyProtocolActive(): boolean {
    return this.terminal.kittyProtocolActive
  }

  /**
   * Start the wrapped terminal and turn mouse reports on.
   * @param onInput - pi-tui's input callback; every sequence that is neither a
   * mouse report nor an awaited cursor report reaches it unchanged.
   * @param onResize - pi-tui's resize callback.
   */
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.deliver = onInput
    this.terminal.start((data) => { this.receive(data) }, onResize)
    this.terminal.write(ENABLE_MOUSE)
  }

  /** Turn mouse reports off and stop the wrapped terminal; a pending cursor query is dropped. */
  stop(): void {
    this.located = undefined
    this.pressed = undefined
    this.terminal.write(DISABLE_MOUSE)
    this.terminal.stop()
  }

  /**
   * Press a key: its bytes reach pi-tui exactly as the terminal's own report
   * of that press would.
   * @param bytes - the key's bytes.
   */
  press(bytes: string): void {
    this.deliver?.(bytes)
  }

  /**
   * Ask the terminal which screen row its cursor is on.
   *
   * One query is in flight at a time: a second call while the first is
   * unanswered replaces the callback, so the newest click is the one the
   * answer places. A terminal that never answers leaves the callback unrun.
   * @param onRow - called with the cursor's screen row, counted from 0.
   */
  locateCursor(onRow: (row: number) => void): void {
    const pending = this.located !== undefined
    this.located = onRow
    if (!pending) this.terminal.write(CURSOR_QUERY)
  }

  /**
   * Answer one input sequence: a mouse report or an awaited cursor report is
   * this terminal's own; anything else is pi-tui's.
   * @param data - one input sequence.
   */
  private receive(data: string): void {
    const report = parsePointer(data)
    if (report !== undefined) {
      this.onReport(report)
      return
    }
    if (X10_MOUSE.test(data)) return
    const located = this.located
    const cursor = located === undefined ? null : CURSOR_REPORT.exec(data)
    if (located !== undefined && cursor !== null) {
      this.located = undefined
      located(Number(cursor[1]) - 1)
      return
    }
    this.deliver?.(data)
  }

  /**
   * Track the left button and report a click when it comes up where it went down.
   * @param report - one parsed mouse report.
   */
  private onReport(report: PointerReport): void {
    const button = report.button & ~0b1_1100
    if (!report.release && (button === 64 || button === 65)) {
      this.pressed = undefined
      this.onScroll?.(button === 64 ? -1 : 1)
      return
    }
    if (!isLeftButton(report)) return
    if (!report.release) {
      this.pressed = { column: report.column, row: report.row }
      return
    }
    const pressed = this.pressed
    this.pressed = undefined
    if (pressed?.column === report.column && pressed.row === report.row) this.onClick(pressed)
  }

  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.terminal.drainInput(maxMs, idleMs)
  }

  write(data: string): void {
    this.terminal.write(data)
  }

  moveBy(lines: number): void {
    this.terminal.moveBy(lines)
  }

  hideCursor(): void {
    this.terminal.hideCursor()
  }

  showCursor(): void {
    this.terminal.showCursor()
  }

  clearLine(): void {
    this.terminal.clearLine()
  }

  clearFromCursor(): void {
    this.terminal.clearFromCursor()
  }

  clearScreen(): void {
    this.terminal.clearScreen()
  }

  setTitle(title: string): void {
    this.terminal.setTitle(title)
  }

  setProgress(active: boolean): void {
    this.terminal.setProgress(active)
  }
}
