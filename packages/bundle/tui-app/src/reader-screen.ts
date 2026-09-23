/**
 * The reader as the surface that owns the terminal: the pane drawn on the
 * alternate screen, and the key map that drives it.
 *
 * It costs the conversation nothing at all. The application switches the
 * terminal to its alternate screen (`./alt-screen.ts`) and holds the
 * main screen off it for as long as the reader is up, so the conversation
 * keeps every line it had, the renderer's repaint boundary never moves, and
 * no row the reader draws can reach the terminal's scrollback. The pane fills
 * the screen: it is told how many rows the terminal has and returns exactly
 * that many.
 *
 * The pane holds no copy of the transcript: it re-reads the blocks and their
 * turns on every render, so a reply that is still streaming grows inside it,
 * a tool result that lands appears, and a new turn joins the list, all with
 * no push and no second clock.
 *
 * Opening the reader, showing another turn, and stepping the list to another
 * section of the same turn each start a reveal: the rows newly in view float
 * out from a lifted color to the colors they settle at, on a clock the
 * application runs on its fade tick. Scrolling, live growth, and a rewrap
 * reveal nothing. A reveal changes colors only, and a terminal that runs no
 * motion draws the settled reader from the first frame.
 * @module @deepseek-ai/dsh-tui-app/reader-screen
 */

import { matchesKey, type Component, type RgbColor } from '@earendil-works/pi-tui'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { FadeStyle } from './fade.ts'
import { typedText } from './keys.ts'
import { clampCursor, lastSection, turnGroups, type SectionSource, type TranscriptCursor, type TurnGroup } from './navigation.ts'
import {
  filterTurns,
  readerClosesOnEscape,
  readerGeometryFor,
  readerRows,
  readerTints,
  readerTurn,
  reduceReader,
  sameSection,
  type ReaderGeometry,
  type ReaderIntent,
  type ReaderReveal,
  type ReaderState,
} from './reader.ts'
import type { CodeHighlighter, Palette } from './style.ts'

/** The key that opens the query line. */
const FILTER_KEY = '/'

/** Printable keys either panel answers the way a pager does, beside the named keys. */
const ALIASES: ReadonlyArray<readonly [string, ReaderIntent]> = [
  ['[', { kind: 'turn', step: -1 }],
  [']', { kind: 'turn', step: 1 }],
]

/** Printable keys the turn list answers beside the named keys. */
const LIST_ALIASES: ReadonlyMap<string, ReaderIntent> = new Map([
  ...ALIASES,
  ['k', { kind: 'section', to: 'previous' }],
  ['j', { kind: 'section', to: 'next' }],
  ['g', { kind: 'section', to: 'first' }],
  ['G', { kind: 'section', to: 'last' }],
  [FILTER_KEY, { kind: 'filter' }],
])

/** Printable keys the turn panel answers beside the named keys. */
const PANE_ALIASES: ReadonlyMap<string, ReaderIntent> = new Map([
  ...ALIASES,
  ['k', { kind: 'scroll', to: 'previous' }],
  ['j', { kind: 'scroll', to: 'next' }],
  ['g', { kind: 'scroll', to: 'first' }],
  ['G', { kind: 'scroll', to: 'last' }],
  [' ', { kind: 'page', step: 1 }],
  ['b', { kind: 'page', step: -1 }],
])

/** The printable key that closes the reader from either panel, as `Escape` does. */
const QUIT_KEY = 'q'

/** Where the reader left the keyboard and the reading when it closed. */
export interface ReaderExit {
  /** The section last read, which the transcript resumes on. */
  cursor: TranscriptCursor
  /** Which region takes the keyboard back. */
  target: 'transcript' | 'editor'
}

/** The clock of one reveal, which the application runs on its fade tick. */
export interface RevealClock {
  /**
   * How far through the reveal the clock is.
   * @returns the age in fade periods, or undefined once the reveal settled.
   */
  age(): number | undefined
}

/** What the reader draws its bands and its reveals with, read from the application's terminal. */
export interface ReaderEffects {
  /**
   * The fade drawing settings: how far the terminal encodes a color, and the
   * ramp that ends on the assumed foreground.
   * @returns the settings, re-read on every render so a late background answer applies.
   */
  style(): FadeStyle
  /**
   * The terminal's background color, which the bands are mixed from.
   * @returns the color, or undefined while the terminal reported none.
   */
  background(): RgbColor | undefined
  /**
   * Start one reveal on the application's fade tick, which repaints the
   * reader until the reveal settles.
   * @returns its clock, or undefined on a terminal that runs no motion.
   */
  startReveal(): RevealClock | undefined
}

/** What the reader pane reads from the application. */
export interface ReaderPaneOptions {
  /** The palette the frame, the list, and the headers are styled with. */
  palette: Palette
  /**
   * The navigable blocks right now.
   * @returns the blocks, re-read on every render so the reader follows the session.
   */
  blocks(): readonly SectionSource[]
  /**
   * How many rows the screen has.
   * @returns the rows, re-read on every render so a resize needs no notification.
   */
  rows(): number
  /** Columns the reader needs before it draws the held turn beside the list. */
  minColumns: number
  /** The section the reader opens on. */
  cursor: TranscriptCursor
  /** The bands and the reveals; absent draws the settled reader with no band. */
  effects?: ReaderEffects
  /** Colours fenced code in replies and the code rows of tool cards; absent draws them plain. */
  highlight?: CodeHighlighter
  /**
   * Called once, where the reader closes: on the key that closes it, and on
   * the render that finds the conversation gone. It runs inside that step
   * rather than after it, so the key stream reaches the conversation from the
   * very next key.
   * @param exit - the section last read and the region that takes the keyboard.
   */
  onExit(exit: ReaderExit): void
}

/**
 * The reader pane: it renders exactly the rows it was given, maps every key
 * to one {@link ReaderIntent}, and settles once when the reader closes.
 */
export class ReaderPane implements Component {
  /** Whether the reader is still open; a second close is ignored. */
  private open = true
  private state: ReaderState
  /** The width the last render laid out at; 0 before the first one. */
  private width = 0
  /** The body the last render anchored on, so one rewrap re-anchors exactly once. */
  private layout = ''
  /** The turn the last render showed, by index into every turn; -1 for none, undefined before the first render. */
  private shownTurn: number | undefined
  /** The reveal in flight, and the one section it covers when it covers no whole turn. */
  private reveal: { clock: RevealClock; section?: TranscriptCursor } | undefined

  /**
   * @param options - the palette, the live transcript reads, and the section to open on.
   */
  constructor(private readonly options: ReaderPaneOptions) {
    this.state = { cursor: options.cursor, column: 'pane', offset: 0 }
  }

  invalidate(): void {}

  /**
   * Draw the reader at `width`.
   * @param width - the columns the screen has.
   * @returns as many lines as `rows()` reports, so the reader covers the
   * screen, and blank lines once the transcript it was reading is gone.
   */
  render(width: number): string[] {
    this.width = width
    const rows = Math.max(1, this.options.rows())
    const blocks = this.options.blocks()
    const settled = clampCursor(this.state.cursor, blocks) ?? lastSection(blocks)
    if (settled === undefined) {
      // Nothing left to read: the pane settles rather than drawing a frame
      // for a conversation that is gone.
      this.close('editor')
      return Array.from({ length: rows }, () => '')
    }
    this.state = { ...this.state, cursor: settled }
    const groups = turnGroups(blocks)
    const visible = filterTurns(groups, blocks, this.state.query)
    const geometry = this.geometryFor(visible, blocks, rows)
    // The turn panel's own columns and rows, which a terminal the list stops
    // fitting beside changes without the reader moving at all.
    const layout = `${String(geometry.pane)}x${String(geometry.body)}`
    if (this.layout !== layout) {
      this.layout = layout
      // A rewrap moves every row number, so the reader re-anchors on the
      // section it was reading rather than on the row it had reached.
      this.state = reduceReader(this.state, { kind: 'anchor' }, visible, geometry, blocks)
    }
    // Another turn in the panel is new content wherever it came from: a key,
    // a query that narrowed the list, or the reader opening.
    const held = readerTurn(this.state, visible)
    const turn = held === undefined ? -1 : groups.indexOf(held)
    if (this.shownTurn !== turn) {
      this.shownTurn = turn
      this.startReveal(undefined)
    }
    const effects = this.options.effects
    return readerRows(this.state, visible, {
      palette: this.options.palette,
      blocks,
      width,
      rows,
      minColumns: this.options.minColumns,
      totalTurns: groups.length,
      tints: effects === undefined ? undefined : readerTints(effects.style(), effects.background()),
      reveal: this.revealNow(),
      highlight: this.options.highlight,
    })
  }

  /**
   * Answer one key press.
   * @param data - the raw key bytes.
   */
  handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+g')) {
      this.close('editor')
      return
    }
    const blocks = this.options.blocks()
    const visible = filterTurns(turnGroups(blocks), blocks, this.state.query)
    const geometry = this.geometryFor(visible, blocks, Math.max(1, this.options.rows()))
    if (geometry.tiny) {
      // A terminal the frame does not fit answers only the keys that leave.
      if (matchesKey(data, 'escape')) this.close('transcript')
      return
    }
    // Both panels close on `Escape` and on `q`; the query line types `q`.
    if (readerClosesOnEscape(this.state) && (matchesKey(data, 'escape') || typedText(data) === QUIT_KEY)) {
      this.close('transcript')
      return
    }
    const intent = this.intentOf(data)
    if (intent === undefined) return
    const before = this.state.cursor
    this.state = reduceReader(this.state, intent, visible, geometry, blocks)
    // The list stepping to another section reveals that section; a step into
    // another turn is answered by the render, which reveals the whole turn.
    if (intent.kind === 'section' && !sameSection(before, this.state.cursor)) this.startReveal(this.state.cursor)
  }

  /** Close the reader from outside, which is what quitting and `Ctrl+C` do. */
  withdraw(): void {
    this.close('editor')
  }

  /**
   * Start a reveal, replacing the one in flight.
   * @param section - the one section it covers; undefined covers the whole turn.
   */
  private startReveal(section: TranscriptCursor | undefined): void {
    const clock = this.options.effects?.startReveal()
    if (clock === undefined) return
    this.reveal = section === undefined ? { clock } : { clock, section }
  }

  /**
   * The reveal as this render draws it.
   * @returns the age, the drawing settings, and the section it covers, or
   * undefined once it settled, which also forgets it.
   */
  private revealNow(): ReaderReveal | undefined {
    const reveal = this.reveal
    const effects = this.options.effects
    const age = reveal?.clock.age()
    if (reveal === undefined || effects === undefined || age === undefined) {
      this.reveal = undefined
      return undefined
    }
    const style = effects.style()
    return reveal.section === undefined ? { age, style } : { age, style, section: reveal.section }
  }

  /**
   * The geometry of the frame as it stands.
   * @param visible - the turns the rail lists.
   * @param blocks - the navigable blocks.
   * @param rows - the rows the screen has.
   * @returns the geometry, with the walking pane measured.
   */
  private geometryFor(visible: readonly TurnGroup[], blocks: readonly SectionSource[], rows: number): ReaderGeometry {
    return readerGeometryFor(this.state, visible, blocks, Math.max(1, this.width), rows, this.options.minColumns)
  }

  /**
   * Settle the reader once.
   * @param target - which region takes the keyboard back.
   */
  private close(target: 'transcript' | 'editor'): void {
    if (!this.open) return
    this.open = false
    this.options.onExit({ cursor: this.state.cursor, target })
  }

  /**
   * What one key means where the reader's keyboard is.
   * @param data - the raw key bytes.
   * @returns the intent, or undefined for a key this column claims nothing for.
   */
  private intentOf(data: string): ReaderIntent | undefined {
    switch (this.state.column) {
      case 'filter':
        return filterIntent(data)
      case 'list':
        return listIntent(data)
      case 'pane':
        return paneIntent(data)
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        return assertNever(this.state.column, 'tui reader column')
    }
  }
}

/**
 * What one key means while the query line owns the keyboard.
 * @param data - the raw key bytes.
 * @returns the intent, or undefined for a key the query line ignores.
 */
function filterIntent(data: string): ReaderIntent | undefined {
  if (matchesKey(data, 'backspace')) return { kind: 'erase', all: false }
  if (matchesKey(data, 'ctrl+u')) return { kind: 'erase', all: true }
  if (matchesKey(data, 'enter')) return { kind: 'commit' }
  if (matchesKey(data, 'escape')) return { kind: 'escape' }
  const text = typedText(data)
  return text === undefined ? undefined : { kind: 'query', text }
}

/**
 * What one key means while the turn list owns the keyboard. `Escape` is not
 * among them: it leaves the reader, which {@link ReaderPane.handleInput}
 * answers before a key reaches this map.
 * @param data - the raw key bytes.
 * @returns the intent, or undefined for a key the list ignores.
 */
function listIntent(data: string): ReaderIntent | undefined {
  if (matchesKey(data, 'up')) return { kind: 'section', to: 'previous' }
  if (matchesKey(data, 'down')) return { kind: 'section', to: 'next' }
  if (matchesKey(data, 'home')) return { kind: 'section', to: 'first' }
  if (matchesKey(data, 'end')) return { kind: 'section', to: 'last' }
  if (matchesKey(data, 'pageUp')) return { kind: 'turn', step: -1 }
  if (matchesKey(data, 'pageDown')) return { kind: 'turn', step: 1 }
  if (matchesKey(data, 'right') || matchesKey(data, 'tab') || matchesKey(data, 'enter')) return { kind: 'column', to: 'pane' }
  return aliasOf(data, LIST_ALIASES)
}

/**
 * What one key means while the turn panel owns the keyboard.
 * @param data - the raw key bytes.
 * @returns the intent, or undefined for a key the panel ignores.
 */
function paneIntent(data: string): ReaderIntent | undefined {
  if (matchesKey(data, 'up')) return { kind: 'scroll', to: 'previous' }
  if (matchesKey(data, 'down')) return { kind: 'scroll', to: 'next' }
  if (matchesKey(data, 'home')) return { kind: 'scroll', to: 'first' }
  if (matchesKey(data, 'end')) return { kind: 'scroll', to: 'last' }
  if (matchesKey(data, 'pageUp')) return { kind: 'page', step: -1 }
  if (matchesKey(data, 'pageDown')) return { kind: 'page', step: 1 }
  if (matchesKey(data, 'left') || matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) return { kind: 'column', to: 'list' }
  return aliasOf(data, PANE_ALIASES)
}

/**
 * What one printable key means in a panel's alias table.
 * @param data - the raw key bytes.
 * @param aliases - the panel's printable keys.
 * @returns the intent, or undefined for a key the table names nothing for.
 */
function aliasOf(data: string, aliases: ReadonlyMap<string, ReaderIntent>): ReaderIntent | undefined {
  const text = typedText(data)
  return text === undefined ? undefined : aliases.get(text)
}
