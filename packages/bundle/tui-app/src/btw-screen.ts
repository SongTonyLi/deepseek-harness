/**
 * The side-question page: the pane drawn while `/btw` is open.
 *
 * The pane does not take the alternate screen and does not call the agent.
 * The application holds the conversation off the terminal and tells the pane
 * how many rows the screen has; the pane returns exactly that many lines.
 *
 * The question stays pinned under the top rule. Scrolling moves through the
 * wrapped answer only. The first answer that leaves `asking`, and a later
 * answer that is ready, failed, or cancelled, each start a reveal of the
 * answer lines when the application supplies effects. Question rows stay as
 * drawn. A terminal that runs no motion draws the settled lines, and a width
 * change only reclamps the scroll offset.
 * @module @deepseek-ai/dsh-tui-app/btw-screen
 */

import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { recolorLines, type FadeStyle } from './fade.ts'
import { BODY_MARGIN, bodyLine, bottomRule, chip, fitLegend, ruleRoom, topRule } from './frame.ts'
import { typedText } from './keys.ts'
import type { Palette } from './style.ts'

/** Rows below which the page draws one dim line instead of a frame. */
const MIN_ROWS = 4

/** What the chip names this page. */
const CHIP = 'BTW'

/** The dim label above the pinned question. */
const QUESTION_LABEL = 'question'

/** The dim label above the answer. */
const ANSWER_LABEL = 'answer'

/** What an asking page with no answer text yet draws. */
const ASKING = 'asking…'

/** What a terminal with fewer than {@link MIN_ROWS} rows is told. */
const TOO_SMALL = 'too small'

/** The printable key that closes the page, as `Escape` does. */
const QUIT_KEY = 'q'

/** What ends a line the width cut short; one column, so the mark itself fits. */
const ELLIPSIS = '…'

/**
 * The legend, widest first. A narrow rule keeps the shortest step that still
 * names the way out.
 */
const LEGEND: readonly string[] = [
  '↑↓ scroll · Space page · Esc closes',
  '↑↓ · Esc',
  'Esc',
]

/** Where the answer is. */
export type AsideStatus = 'asking' | 'answering' | 'ready' | 'failed' | 'cancelled'

/** The answer the page is showing. */
export interface AsideBody {
  /** Whether the question is still open, streaming, or finished. */
  readonly status: AsideStatus
  /** The answer text; empty while the page is still asking and nothing has arrived. */
  readonly text: string
}

/** The clock of one answer reveal, which the application runs on its fade tick. */
export interface AsideRevealClock {
  /**
   * How far through the reveal the clock is.
   * @returns the age in fade periods, or undefined once the reveal settled.
   */
  age(): number | undefined
}

/** What the page reads from the application. */
export interface AsidePaneOptions {
  /** The palette the frame and the labels are styled with. */
  readonly palette: Palette
  /** The question, pinned under the top rule for as long as the page is open. */
  readonly question: string
  /**
   * How many rows the screen has.
   * @returns the rows, re-read on every render so a resize needs no notification.
   */
  rows(): number
  /** The reveal; absent draws settled answer lines. */
  effects?: {
    /**
     * The fade drawing settings.
     * @returns the settings, re-read on every render so a late background answer applies.
     */
    style(): FadeStyle
    /**
     * Start one reveal of the answer lines on the application's fade tick.
     * @returns its clock, or undefined on a terminal that runs no motion.
     */
    startReveal(): AsideRevealClock | undefined
  }
  /**
   * Called once, when the page closes: on the key that closes it, and on
   * {@link AsidePane.withdraw}. A second close does not call it again.
   */
  onExit(): void
}

/** What one key does to the answer. */
type AsideIntent =
  /** Move one wrapped answer line. */
  | { kind: 'line'; step: -1 | 1 }
  /** Move a page of the answer window, with one line of overlap. */
  | { kind: 'page'; step: -1 | 1 }
  /** Jump to either end of the wrapped answer. */
  | { kind: 'end'; to: 'first' | 'last' }

/** Printable keys the page answers beside the named keys. */
const ALIASES: ReadonlyMap<string, AsideIntent> = new Map([
  ['k', { kind: 'line', step: -1 }],
  ['j', { kind: 'line', step: 1 }],
  ['g', { kind: 'end', to: 'first' }],
  ['G', { kind: 'end', to: 'last' }],
  [' ', { kind: 'page', step: 1 }],
  ['b', { kind: 'page', step: -1 }],
])

/** How the page splits the screen on one render. */
interface AsideLayout {
  /** Lines the page returns. */
  readonly rows: number
  /** Whether the terminal cannot hold the frame. */
  readonly tiny: boolean
  /** Wrapped question lines, pinned above the answer. */
  readonly question: readonly string[]
  /** Wrapped answer lines, the only lines the offset moves through. */
  readonly answer: readonly string[]
  /** How many answer lines fit under the pinned question. */
  readonly window: number
}

/**
 * The side-question page. It renders exactly the rows it was given, scrolls
 * the answer, and settles once when it closes.
 */
export class AsidePane implements Component {
  /** Whether the page is still open; a second close is ignored. */
  private open = true
  /** The answer status the page opened with. */
  private status: AsideStatus = 'asking'
  /** The answer text the page opened with. */
  private text = ''
  /** First visible wrapped answer line. */
  private offset = 0
  /** The width the last render laid out at; 0 before the first one. */
  private width = 0
  /** The reveal in flight, forgotten once its clock settles. */
  private reveal: AsideRevealClock | undefined

  /**
   * @param options - the palette, the question, the live row count, and the close callback.
   */
  constructor(private readonly options: AsidePaneOptions) {}

  /** Accept a frame request; the page keeps no cached drawing. */
  invalidate(): void {}

  /**
   * Draw the page at `width`.
   * @param width - the columns the screen has.
   * @returns as many lines as `rows()` reports, and at least one.
   */
  render(width: number): string[] {
    this.width = width
    const layout = this.layout(width)
    const palette = this.options.palette
    if (layout.tiny) {
      const lines = Array.from({ length: layout.rows }, () => '')
      lines[0] = truncateToWidth(palette.dim(TOO_SMALL), Math.max(1, width), ELLIPSIS)
      return lines
    }
    const columns = Math.max(1, width)
    const pinned = [palette.dim(QUESTION_LABEL), ...layout.question, palette.dim(ANSWER_LABEL)]
    const slots = layout.rows - 2
    const head = pinned.slice(0, slots)
    const window = slots - head.length
    const max = Math.max(0, layout.answer.length - window)
    this.offset = clamp(this.offset, max)
    const body = this.painted(layout.answer).slice(this.offset, this.offset + window)
    while (body.length < window) body.push('')
    const badge = chip(palette, CHIP)
    return [
      topRule({
        chip: badge,
        title: palette.bold(palette.accent(this.status)),
        width: columns,
        palette,
        tone: 'focus',
      }),
      ...head.map(line => bodyLine(line, columns, palette, 'focus')),
      ...body.map(line => bodyLine(line, columns, palette, 'focus')),
      bottomRule({
        left: palette.dim(fitLegend(LEGEND, ruleRoom(columns))),
        width: columns,
        palette,
        tone: 'focus',
      }),
    ]
  }

  /**
   * Answer one key press.
   * @param data - the raw key bytes.
   */
  handleInput(data: string): void {
    if (this.layout(this.width).tiny) {
      if (matchesKey(data, 'escape')) this.close()
      return
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+g') || typedText(data) === QUIT_KEY) {
      this.close()
      return
    }
    const intent = intentOf(data)
    if (intent === undefined) return
    this.move(intent)
  }

  /** Close the page from outside, which is what quitting and `Ctrl+C` do. */
  withdraw(): void {
    this.close()
  }

  /**
   * Replace the answer. The first status that leaves `asking` starts a reveal,
   * and so does a later ready, failed, or cancelled answer. A further show
   * that stays `answering` keeps the reveal already running.
   * @param body - the status and the text to draw.
   */
  show(body: AsideBody): void {
    const previous = this.status
    this.status = body.status
    this.text = body.text
    if (previous === 'asking' ? body.status !== 'asking' : terminal(body.status)) this.startReveal()
  }

  /**
   * The lines of this render, and how many of them the answer may use.
   * @param width - the columns the screen has.
   * @returns the layout. A terminal under {@link MIN_ROWS} rows is `tiny`.
   */
  private layout(width: number): AsideLayout {
    const rows = Math.max(1, this.options.rows())
    if (rows < MIN_ROWS) return { rows, tiny: true, question: [], answer: [], window: 0 }
    const room = Math.max(1, width - BODY_MARGIN)
    const question = wrapTextWithAnsi(this.options.question, room)
    const answer = answerLines(this.status, this.text, this.options.palette, room)
    const slots = rows - 2
    const pinned = question.length + 2
    return { rows, tiny: false, question, answer, window: Math.max(0, slots - pinned) }
  }

  /**
   * Move the answer offset.
   * @param intent - the key's meaning.
   */
  private move(intent: AsideIntent): void {
    const layout = this.layout(this.width)
    const max = Math.max(0, layout.answer.length - layout.window)
    switch (intent.kind) {
      case 'line':
        this.offset = clamp(this.offset + intent.step, max)
        return
      case 'page':
        this.offset = clamp(this.offset + intent.step * Math.max(1, layout.window - 1), max)
        return
      case 'end':
        this.offset = intent.to === 'first' ? 0 : max
        return
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        return assertNever(intent, 'tui aside intent')
    }
  }

  /**
   * The answer lines as this render draws them. A settled clock is forgotten,
   * and the question is never passed through here.
   * @param lines - the wrapped answer.
   * @returns the lines, recolored while the reveal clock has an age.
   */
  private painted(lines: readonly string[]): string[] {
    const reveal = this.reveal
    if (reveal === undefined) return [...lines]
    const age = reveal.age()
    const effects = this.options.effects
    if (age === undefined || effects === undefined) {
      this.reveal = undefined
      return [...lines]
    }
    return recolorLines(lines, age, effects.style())
  }

  /** Start a reveal, replacing the one in flight. A terminal with no motion starts none. */
  private startReveal(): void {
    const clock = this.options.effects?.startReveal()
    if (clock === undefined) return
    this.reveal = clock
  }

  /** Settle the page once. */
  private close(): void {
    if (!this.open) return
    this.open = false
    this.options.onExit()
  }
}

/**
 * The wrapped answer. An asking page with no text yet is one dim placeholder;
 * every other answer is the text wrapped to the body.
 * @param status - the answer status.
 * @param text - the answer text.
 * @param palette - the palette the placeholder is styled with.
 * @param room - the columns a body row leaves the text.
 * @returns the answer lines, before the reveal recolors them.
 */
function answerLines(status: AsideStatus, text: string, palette: Palette, room: number): string[] {
  switch (status) {
    case 'asking':
      return text === '' ? [palette.dim(ASKING)] : wrapTextWithAnsi(text, room)
    case 'answering':
    case 'ready':
    case 'failed':
    case 'cancelled':
      return wrapTextWithAnsi(text, room)
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(status, 'tui aside status')
  }
}

/**
 * Whether a status is a finished answer, which starts a reveal of its own.
 * @param status - the status just shown.
 * @returns true for ready, failed, and cancelled.
 */
function terminal(status: AsideStatus): boolean {
  switch (status) {
    case 'asking':
    case 'answering':
      return false
    case 'ready':
    case 'failed':
    case 'cancelled':
      return true
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(status, 'tui aside status')
  }
}

/**
 * What one key means while the page owns the keyboard. `Escape`, `q`, and
 * `Ctrl+G` are not among them: they close the page, which
 * {@link AsidePane.handleInput} answers first.
 * @param data - the raw key bytes.
 * @returns the intent, or undefined for a key the page ignores.
 */
function intentOf(data: string): AsideIntent | undefined {
  if (matchesKey(data, 'up')) return { kind: 'line', step: -1 }
  if (matchesKey(data, 'down')) return { kind: 'line', step: 1 }
  if (matchesKey(data, 'pageUp')) return { kind: 'page', step: -1 }
  if (matchesKey(data, 'pageDown')) return { kind: 'page', step: 1 }
  if (matchesKey(data, 'home')) return { kind: 'end', to: 'first' }
  if (matchesKey(data, 'end')) return { kind: 'end', to: 'last' }
  if (matchesKey(data, 'space')) return { kind: 'page', step: 1 }
  const text = typedText(data)
  return text === undefined ? undefined : ALIASES.get(text)
}

/**
 * Clamp a scroll offset into the answer.
 * @param value - the requested offset.
 * @param max - the last offset that still shows an answer line, or 0 when the answer fits.
 * @returns the offset, between 0 and `max`.
 */
function clamp(value: number, max: number): number {
  if (value < 0) return 0
  if (value > max) return max
  return value
}
