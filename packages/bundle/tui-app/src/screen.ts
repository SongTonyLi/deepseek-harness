/**
 * The main screen this application renders through, and the repaint rule the
 * renderer imposes on everything drawn above the terminal's viewport.
 *
 * pi-tui's `TuiMainScreen` draws into the terminal's own scrollback. It
 * repaints differentially only the lines whose index is at or after
 * `previousViewportTop`, the top of the last written frame's viewport, and
 * falls back to a full redraw that writes `ESC[2J ESC[H ESC[3J` - which
 * discards the terminal's scrollback - as soon as a line above it changed.
 * `previousViewportTop` is a high-water mark: every frame raises it towards
 * `frameLines - terminal.rows` and a shorter frame never lowers it again, so a
 * line that once left the window stays out of reach until the renderer redraws
 * in full and resets it.
 *
 * Anything that redraws lines a component already produced - the streaming
 * fade, a card fade, the focus gutter - therefore asks {@link repaintFloor} how
 * far into a block the renderer can still follow it, and
 * {@link GuardedMainScreen} gives the application the one moment where that
 * question can be answered: after a frame was built and before it is written.
 * @module @deepseek-ai/dsh-tui-app/screen
 */

import { TuiMainScreen, type Component, type Terminal } from '@earendil-works/pi-tui'

/**
 * How many times one frame is offered to the guard before it is written. Two
 * passes let the guard answer for the geometry its own first pass produced -
 * a gutter rewraps the block it marks - and end on a frame the application's
 * own record of what is marked describes.
 */
const SETTLE_PASSES = 2

/**
 * The first line of one block the renderer can still repaint.
 * @param start - index of the block's first line in the frame.
 * @param viewportTop - the frame's first repaintable line, as
 * {@link GuardedMainScreen} hands it to its guard.
 * @returns the block's own first repaintable line index, 0 while the whole
 * block lies inside the window.
 */
export function repaintFloor(start: number, viewportTop: number): number {
  return Math.max(0, viewportTop - start)
}

/**
 * Blank rows at the foot of the frame, which a surface mounts while it needs
 * the whole viewport.
 *
 * The renderer repaints a line only at or after {@link repaintFloor}'s own
 * `viewportTop`, a high-water mark a taller frame raises for good. A frame
 * that has since shrunk therefore leaves the top of the viewport out of
 * reach, and an overlay that may not draw there stops short of the screen.
 * These rows push the frame back up to that mark: the terminal scrolls by
 * exactly the shortfall, every line of the viewport becomes repaintable
 * again, and an overlay composited into the frame's last `terminal.rows`
 * lines covers all of them. They are never seen - the overlay is drawn over
 * them, and they are gone before it is.
 *
 * pi-tui's `Text` drops blank lines, so the rows are a component of their own.
 */
export class ViewportPad implements Component {
  /**
   * @param rows - how many blank lines to draw, read on every render.
   */
  constructor(private readonly rows: () => number) {}

  invalidate(): void {}

  /**
   * Draw the pad.
   * @returns that many empty lines, and none at all where the frame already
   * reaches the mark.
   */
  render(): string[] {
    return Array.from({ length: Math.max(0, this.rows()) }, () => '')
  }
}

/**
 * The main screen that settles each frame between building it and writing it.
 *
 * The guard is handed the frame's first repaintable line: the higher of the
 * renderer's own `previousViewportTop` and the boundary the frame just built
 * imposes once it is written. The first term is what the renderer judges this
 * write against. The second keeps every decision one frame ahead of that
 * judgement, so what the guard changes today it can still change back
 * tomorrow. Settling before the write also means a fade reaches the terminal
 * already settled instead of changing in the next frame, by which time its
 * lines may sit above the window.
 */
export class GuardedMainScreen extends TuiMainScreen {
  /**
   * @param terminal - the terminal the tree renders into.
   * @param showHardwareCursor - whether the terminal's own cursor is the caret.
   * @param guard - given the frame's first repaintable line, the width it was
   * built at, and how many lines it has, applies what that geometry decides
   * and reports whether it changed any line; run at most
   * {@link SETTLE_PASSES} times per frame, each `true` on a frame that is
   * built again. The frame's own length is what places an overlay, which
   * pi-tui composites into its last `terminal.rows` lines.
   */
  constructor(
    terminal: Terminal,
    showHardwareCursor: boolean,
    private readonly guard: (viewportTop: number, width: number, frameLines: number) => boolean,
  ) {
    super(terminal, showHardwareCursor)
  }

  /**
   * Build the frame, let the guard settle what its geometry decides, and build
   * it again for every pass that changed a line.
   * @param width - the total width the tree lays out in.
   * @returns the frame to write, settled against its own geometry.
   */
  override render(width: number): string[] {
    // The renderer moves `previousViewportTop` only while it writes a frame, so
    // one reading holds for every pass over this one.
    const previousTop = this.captureRenderState().previousViewportTop
    let lines = super.render(width)
    for (let pass = 0; pass < SETTLE_PASSES; pass += 1) {
      if (!this.guard(Math.max(previousTop, lines.length - this.terminal.rows), width, lines.length)) break
      lines = super.render(width)
    }
    return lines
  }
}
