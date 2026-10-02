/**
 * The pinned prompt: one tinted row that names the prompt a turn answers
 * while that prompt's own rows are out of view.
 *
 * The reader draws it in place of its top rule once the turn panel scrolls
 * past its first row. The main screen floats it over the first row the
 * terminal shows once every row of the newest prompt has scrolled above that
 * row, so a long answer still shows which request it answers.
 *
 * On the main screen the bar is a pi-tui overlay, composited into the frame
 * after the tree rendered: it moves no line of the conversation, costs the
 * frame no row, and covers the conversation row under it. pi-tui never
 * scrolls the terminal back when a frame shrinks, so the terminal's first row
 * keeps showing the line it showed, the top of the renderer's repaint window,
 * and the bar stays on that line. When the frame grows past the terminal, the
 * line the bar leaves changes back to its own text at the top of the repaint
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
  /**
   * The frame's first line inside the viewport pi-tui composites overlays
   * into: the frame's length less the terminal's rows, and 0 for a frame no
   * taller than the terminal.
   */
  readonly viewportStart: number
  /**
   * How many of the viewport's own first lines the renderer can no longer
   * repaint, as `repaintFloor` reports it for the viewport's first line. A
   * frame that shrank leaves them above the terminal's first row, which keeps
   * showing the line after them.
   */
  readonly viewportFloor: number
}

/**
 * The viewport row the main screen floats the bar on: the first row the
 * terminal shows, `viewportFloor` rows into the viewport, whose line is the
 * renderer's first repaintable one. The bar is drawn there while every line
 * of the prompt's block lies above that line and the line belongs to the
 * conversation rather than the header or the docked chrome. A frame that
 * shrank by the terminal's height or more leaves that line past the frame's
 * end, which belongs to neither.
 * @param geometry - where the prompt, the conversation, and the viewport sit.
 * @returns the row, counted from the viewport's top, or undefined while no
 * bar is drawn.
 */
export function pinnedPromptPlacement(geometry: PinnedPromptGeometry): number | undefined {
  const { promptEnd, transcriptEnd, viewportStart, viewportFloor } = geometry
  const shown = viewportStart + viewportFloor
  return promptEnd <= shown && shown < transcriptEnd ? viewportFloor : undefined
}

/**
 * Where the main screen's bar floats: on one viewport row, across the
 * terminal's whole width, and without taking the keyboard. The pane lays the
 * bar out inside the page margins itself, as the main screen lays out its
 * frame, so the bar lines up with the conversation at every width.
 * @param row - the viewport row, as {@link pinnedPromptPlacement} places it.
 * @returns the overlay options the bar is shown with.
 */
export function pinnedPromptOverlay(row: number): OverlayOptions {
  return { anchor: 'top-left', width: '100%', margin: { top: row }, nonCapturing: true }
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
