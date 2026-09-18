/**
 * The transient key-feedback line: a framed notice that floats over the
 * conversation for a moment and then fades out.
 *
 * It costs the frame no rows at all. pi-tui composites an overlay into the
 * last terminal-height lines of the frame after the tree rendered, so nothing
 * the conversation or the docked chrome drew moves, and the renderer's
 * repaint boundary is never raised. Guidance that is worth keeping stays a
 * transcript notice; this surface is for what the next key press makes
 * obsolete.
 * @module @deepseek-ai/dsh-tui-app/toast
 */

import { truncateToWidth, visibleWidth, type Component, type OverlayOptions } from '@earendil-works/pi-tui'
import { recolorLines, type FadeStyle, type RegisteredFade } from './fade.ts'
import type { Palette } from './style.ts'

/**
 * What the line says when a second `Ctrl+C` would quit. The transient lines
 * are catalogued here, one constant each, so the surface that shows them and
 * the tests that pin them read the same words.
 */
export const QUIT_TOAST = 'press Ctrl+C again to quit'

/** What the line says when the transcript holds nothing the reader could open. */
export const NOTHING_TO_READ_TOAST = 'nothing in the transcript to read yet'

/** What the line says when a fold key named a block the renderer can no longer rewrite. */
export const ABOVE_WINDOW_TOAST = 'above the repaint window · opened in the reader'

/**
 * What the line says while the stop is armed. It names the turn it would
 * stop, so a press after a turn boundary is read for what it is.
 * @param turn - the running turn's number.
 * @returns the line.
 */
export function stopTurnToast(turn: number): string {
  return `press Esc again to stop turn ${String(turn)}`
}

/**
 * How long one line holds at full strength before it fades out, which is also
 * how long the window it names lasts: the second `Esc` that stops a turn is
 * armed for exactly as long as any part of the line is on screen. The shipped
 * default of the `toastMs` setting.
 */
export const TOAST_MS = 2000

/** Columns the frame itself takes: the two rules and the space after the left one. */
const FRAME_COLUMNS = 3

/** Narrowest box that still holds a rule, a space, one column of text, and the closing rule. */
const MIN_WIDTH = 4

/** What ends a line the width cut short; one column, so the mark itself fits. */
const ELLIPSIS = '…'

/** How much of the terminal one line takes when its own text needs less. */
const TOAST_WIDTH = '40%'

/** Which line of the viewport the box starts on, as its top margin. */
const TOAST_ROW = 1

/**
 * Whether the renderer can still repaint the lines a transient line lands on.
 *
 * pi-tui composites an overlay into the last `terminal.rows` lines of the
 * frame, so a line that floats near the top of the viewport is the first to
 * fall out of the repaint window when a frame shrinks - and rewriting a line
 * above that window costs the terminal's whole scrollback.
 * @param viewportFloor - how many of the viewport's own first lines the
 * renderer can no longer repaint, as `repaintFloor` reports it for the
 * viewport's first line.
 * @returns true while the box lies inside the repaint window.
 */
export function toastDrawable(viewportFloor: number): boolean {
  return viewportFloor <= TOAST_ROW
}

/**
 * Where one transient line floats and how wide it is.
 *
 * It sits in the top-right corner of the viewport, over the conversation and
 * clear of the docked chrome, and it is at least as wide as its own text: a
 * line that says which key stops a turn is worth no ellipsis. A terminal too
 * narrow for that clamps the box and the text is cut instead. The percentage
 * is re-resolved per render, so a resize needs no notification, and
 * `nonCapturing` leaves the keyboard where the user put it.
 * @param text - what the line says.
 * @param drawable - read per render: whether the renderer can still repaint
 * the box where it lands, which a frame that shrank under it can deny.
 * @returns the overlay options this line is shown with.
 */
export function toastOverlay(text: string, drawable: () => boolean): OverlayOptions {
  return {
    width: TOAST_WIDTH,
    minWidth: visibleWidth(text) + FRAME_COLUMNS,
    anchor: 'top-right',
    margin: { top: TOAST_ROW, right: 2 },
    nonCapturing: true,
    visible: drawable,
  }
}

/** What a {@link ToastClock} is built with. */
export interface ToastClockOptions {
  /** Wall-clock time the line went up, in milliseconds. */
  shownAt: number
  /** How long the line holds at full strength before it starts to fade. */
  holdMs: number
  /** Brightness levels the fade-out crosses; ignored while {@link ToastClockOptions.fading} is false. */
  steps: number
  /** How long one brightness level lasts, in milliseconds. */
  stepMs: number
  /**
   * Whether this terminal draws a ramp at all. A terminal that draws none -
   * reduced motion, a disabled palette, no color - has no fade phase, so the
   * line simply disappears at the end of its hold.
   */
  fading: boolean
  /**
   * The wall clock the age is measured against.
   * @returns the current time in milliseconds.
   */
  now: () => number
}

/**
 * How long one toast stays on screen and how far through its fade-out it is.
 *
 * It is a {@link RegisteredFade} so the application's one fade tick keeps
 * running while a line is up and disarms itself the moment the line expires -
 * including under reduced motion, where nothing else is moving but the line
 * still has to come down.
 */
export class ToastClock implements RegisteredFade {
  /** Whether the line came down before its time, which settles the clock at once. */
  private taken = false

  /**
   * @param options - when the line went up, how long it holds at full
   * strength, the fade-out that follows that hold on a terminal which draws a
   * ramp, and the clock both phases are measured against.
   */
  constructor(private readonly options: ToastClockOptions) {}

  /**
   * Settle this clock now, for a line the next key press took down or
   * replaced: the registry drops it at the following tick and the one fade
   * tick disarms with it, so nothing keeps repainting for a line that is no
   * longer drawn.
   */
  settle(): void {
    this.taken = true
  }

  /**
   * How long this line is on screen in total.
   * @returns the hold plus the fade-out, in milliseconds; the hold alone when
   * the terminal draws no ramp.
   */
  lifetimeMs(): number {
    const { holdMs, steps, stepMs, fading } = this.options
    return holdMs + (fading ? steps * stepMs : 0)
  }

  /**
   * How far through the fade-out this line is.
   * @returns the age in units of `stepMs` that {@link recolorLines} draws at,
   * or undefined while the line still holds at full strength.
   */
  age(): number | undefined {
    const { shownAt, holdMs, stepMs, now } = this.options
    const elapsed = now() - shownAt
    return elapsed < holdMs ? undefined : (elapsed - holdMs) / stepMs
  }

  /**
   * Whether the line has come down.
   * @returns true once the hold and the fade-out have both elapsed, and at
   * once for a line {@link ToastClock.settle} took down early.
   */
  expired(): boolean {
    return this.taken || this.options.now() - this.options.shownAt >= this.lifetimeMs()
  }

  /**
   * Whether the line still needs another repaint.
   * @returns true until it expires.
   */
  needsRepaint(): boolean {
    return !this.expired()
  }
}

/** How one toast is drawn. */
export interface ToastRender {
  /** The palette the box is styled with. */
  palette: Palette
  /**
   * How far through the fade-out the line is.
   * @returns the age {@link recolorLines} draws at, or undefined at full strength.
   */
  age(): number | undefined
  /**
   * The drawing settings the fade-out is encoded under.
   * @returns the capability and the ramp.
   */
  style(): FadeStyle
}

/**
 * One transient line as a mounted overlay: a dim rounded box around the text,
 * every line exactly the width it was laid out at, so it reads solid over
 * whatever the conversation drew underneath.
 *
 * The fade is read once per render rather than pushed in, so the clock alone
 * decides what a frame draws.
 */
export class ToastPane implements Component {
  /**
   * @param text - what the line says; it is cut to the width with an ellipsis.
   * @param settings - the palette and the fade; the width arrives per render.
   */
  constructor(private readonly text: string, private readonly settings: ToastRender) {}

  invalidate(): void {}

  /**
   * Draw the box at `width`.
   * @param width - the total width the overlay was laid out at.
   * @returns exactly three lines, each of that width.
   */
  render(width: number): string[] {
    const { palette } = this.settings
    const columns = Math.max(MIN_WIDTH, width)
    const rule = '─'.repeat(columns - 2)
    const field = columns - FRAME_COLUMNS
    // The cut text carries the sequences `truncateToWidth` closes its mark
    // with, so the padding is measured in columns rather than in characters.
    const body = truncateToWidth(this.text, field, ELLIPSIS)
    const padding = ' '.repeat(Math.max(0, field - visibleWidth(body)))
    const lines = [`╭${rule}╮`, `│ ${body}${padding}│`, `╰${rule}╯`].map(palette.dim)
    const age = this.settings.age()
    return age === undefined ? lines : recolorLines(lines, age, this.settings.style())
  }
}
