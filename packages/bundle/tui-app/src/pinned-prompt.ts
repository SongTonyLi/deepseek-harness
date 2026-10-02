/**
 * The pinned prompt: one tinted row that names the prompt a turn answers
 * while that prompt's own rows are out of view.
 *
 * The reader draws it in place of its top rule once the turn panel scrolls
 * past its first row. The main screen floats it over the first row of the
 * viewport once every row of the newest prompt has scrolled above the
 * viewport, so a long answer still shows which request it answers.
 *
 * On the main screen the bar is a pi-tui overlay, composited into the frame
 * after the tree rendered: it moves no line of the conversation, costs the
 * frame no row, and covers the conversation row under it. When the frame
 * grows, that row changes back to its own text at a line inside the repaint
 * window, so the renderer writes it before the terminal scrolls it into the
 * scrollback, and the bar itself never reaches the scrollback.
 * @module @deepseek-ai/dsh-tui-app/pinned-prompt
 */

import { truncateToWidth, type Component, type OverlayOptions } from '@earendil-works/pi-tui'
import { pageContentWidth, pageMargin } from './screen.ts'
import { bandRow, type Palette } from './style.ts'

/**
 * Opens a prompt wherever one is named outside the conversation's own band:
 * the pinned bar, and the reader's prompt band and its list row for the
 * turn being read, as it opens a prompt in the conversation.
 */
export const PROMPT_GLYPH = '❯'

/** What ends a bar the width cut short; one column, so the mark itself fits. */
const ELLIPSIS = '…'

/** Which row of the viewport the main screen's bar floats on. */
const PINNED_ROW = 0

/**
 * One prompt as a single row: the prompt glyph, then the prompt's rows joined
 * with every run of whitespace collapsed to one space, cut to `width` with an
 * ellipsis, on the prompt band.
 * @param palette - the palette the band is drawn with.
 * @param rows - the prompt's source rows.
 * @param width - the columns the bar spans.
 * @returns the row: exactly `width` columns under the band on an enabled
 * palette, and the unpadded text, no wider than `width`, on a disabled one.
 */
export function pinnedPromptRow(palette: Palette, rows: readonly string[], width: number): string {
  const text = rows.join(' ').replaceAll(/\s+/gu, ' ').trim()
  return bandRow(palette, truncateToWidth(` ${PROMPT_GLYPH} ${text} `, width, ELLIPSIS), width)
}

/** Where the newest prompt, the conversation, and the viewport sit in one frame, by frame line. */
export interface PinnedPromptGeometry {
  /** The line after the last line of the prompt's block. */
  readonly promptEnd: number
  /** The line after the conversation's last line, where the docked chrome begins. */
  readonly transcriptEnd: number
  /** The line the viewport's first row shows; 0 for a frame no taller than the terminal. */
  readonly viewportStart: number
  /**
   * How many of the viewport's own first lines the renderer can no longer
   * repaint, as `repaintFloor` reports it for the viewport's first line.
   */
  readonly viewportFloor: number
}

/**
 * Whether the main screen floats the bar over the viewport's first row: while
 * every line of the prompt's block lies above the viewport, the row the bar
 * lands on belongs to the conversation rather than the header or the docked
 * chrome, and the renderer can still repaint that row. Rewriting a line above
 * the repaint window costs the terminal's whole scrollback, so once the frame
 * shrinks and leaves its viewport's first row above the window, no bar is
 * drawn until the frame grows past the window's top again.
 * @param geometry - where the prompt, the conversation, and the viewport sit.
 * @returns true while the bar is drawn.
 */
export function pinnedPromptDrawable(geometry: PinnedPromptGeometry): boolean {
  const { promptEnd, transcriptEnd, viewportStart, viewportFloor } = geometry
  return promptEnd <= viewportStart && viewportStart < transcriptEnd && viewportFloor <= PINNED_ROW
}

/**
 * Where the main screen's bar floats: on the viewport's first row, across the
 * terminal's whole width, and without taking the keyboard. The pane lays the
 * bar out inside the page margins itself, as the main screen lays out its
 * frame, so the bar lines up with the conversation at every width.
 * @returns the overlay options the bar is shown with.
 */
export function pinnedPromptOverlay(): OverlayOptions {
  return { anchor: 'top-left', width: '100%', margin: { top: PINNED_ROW }, nonCapturing: true }
}

/** The bar as the main screen floats it: the left page margin, then the bar across the columns between the margins. */
export class PinnedPromptPane implements Component {
  /**
   * @param palette - the palette the bar is drawn with.
   * @param rows - the prompt's source rows.
   */
  constructor(private readonly palette: Palette, private readonly rows: readonly string[]) {}

  invalidate(): void {}

  /**
   * Draw the bar at `width`.
   * @param width - the width the overlay was laid out at, which is the terminal's own.
   * @returns exactly one line.
   */
  render(width: number): string[] {
    return [`${pageMargin(width)}${pinnedPromptRow(this.palette, this.rows, pageContentWidth(width))}`]
  }
}
