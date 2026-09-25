/**
 * The line above the editor that says the terminal is showing a subagent
 * session rather than the main one: the path of views from the main session
 * down to the one on screen, and the key that goes back one level. The
 * header names the view too, but it scrolls away with the transcript; this
 * line stays next to the editor for as long as the view is open, and draws
 * nothing while the main session is on screen.
 * @module @deepseek-ai/dsh-tui-app/view-banner
 */

import { truncateToWidth, type Component } from '@earendil-works/pi-tui'
import { bandRow, type Palette } from './style.ts'

/** What the trail calls the session the first subagent view was opened from. */
export const MAIN_SESSION_LABEL = 'main'

/** What the line calls a subagent view unless the app names the view otherwise. */
const SUBAGENT_VIEW_TITLE = 'subagent view'

/** Glyph the banner opens with; the header marks a subagent view with the same one. */
const VIEW_GLYPH = '◆'

/** Draws the subagent-view line while a subagent session is on screen. */
export class ViewBanner implements Component {
  /** Labels of the open views, outermost first; empty while the main session is on screen. */
  private views: readonly string[] = []

  /** @param palette - the palette the line is styled with. */
  constructor(private readonly palette: Palette) {}

  /** What the line calls the view on screen. */
  private title = SUBAGENT_VIEW_TITLE

  /**
   * Replace the views the line names.
   * @param views - the label of every open subagent view, outermost first;
   * empty draws nothing.
   * @param title - what the line calls the view on screen; `subagent view` when omitted.
   */
  setViews(views: readonly string[], title: string = SUBAGENT_VIEW_TITLE): void {
    this.views = [...views]
    this.title = title
  }

  invalidate(): void {}

  /**
   * Draw the line.
   * @param width - the columns the line fits.
   * @returns one banded row while a view is open, and no rows otherwise.
   */
  render(width: number): string[] {
    const current = this.views.at(-1)
    if (current === undefined) return []
    const palette = this.palette
    const back = this.views.at(-2) ?? MAIN_SESSION_LABEL
    const trail = [MAIN_SESSION_LABEL, ...this.views.slice(0, -1)].map(label => palette.dim(label))
    const row = [
      `${palette.warning(VIEW_GLYPH)} ${palette.bold(palette.warning(this.title))}`,
      [...trail, palette.bold(current)].join(palette.dim(' › ')),
      `${palette.accent('Ctrl+P')} ${palette.dim(`back to ${back}`)}`,
    ].join(palette.dim('  ·  '))
    return [bandRow(palette, truncateToWidth(` ${row}`, width, '…'), width)]
  }
}
