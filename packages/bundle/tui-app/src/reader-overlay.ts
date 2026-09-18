/**
 * The reader as a mounted overlay: the component pi-tui composites over the
 * viewport, and the key map that drives it.
 *
 * It costs the frame no rows. pi-tui composites an overlay into the last
 * terminal-height lines of the frame after the tree rendered, so the
 * conversation underneath keeps every line it had and the renderer's repaint
 * boundary is never raised. The application places it against the bottom of
 * the viewport and tells it how many rows it may draw, which is one fewer for
 * every viewport line the renderer can no longer repaint; the pane fills
 * exactly that many.
 *
 * Opening and closing are the two moments it moves: the application hands the
 * pane a reveal it reads per render, and the pane draws that share of its
 * frame from the bottom rule up, so the reader rises into place and sinks
 * away without the frame underneath it gaining or losing a line.
 *
 * The pane holds no copy of the transcript: it re-reads the blocks and their
 * turns on every render, so a reply that is still streaming grows inside it,
 * a tool result that lands appears, and a new turn joins the rail, all with
 * no push and no second clock.
 * @module @deepseek-ai/dsh-tui-app/reader-overlay
 */

import { matchesKey, type Component } from '@earendil-works/pi-tui'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { typedText } from './keys.ts'
import { clampCursor, lastSection, turnGroups, type SectionSource, type TranscriptCursor, type TurnGroup } from './navigation.ts'
import {
  filterTurns,
  readerClosesOnEscape,
  readerGeometryFor,
  readerRows,
  reduceReader,
  type ReaderGeometry,
  type ReaderIntent,
  type ReaderState,
} from './reader.ts'
import type { Palette } from './style.ts'

/** Which digits select a section of the held turn directly. */
const SECTION_DIGIT = /^[1-9]$/u

/** The key that opens the query line. */
const FILTER_KEY = '/'

/** Where the reader left the keyboard and the walk when it closed. */
export interface ReaderExit {
  /** The section last read, which the transcript resumes on. */
  cursor: TranscriptCursor
  /** Which region takes the keyboard back. */
  target: 'transcript' | 'editor'
}

/** What the reader pane reads from the application. */
export interface ReaderPaneOptions {
  /** The palette the frame, the rail, and the headers are styled with. */
  palette: Palette
  /**
   * The navigable blocks right now.
   * @returns the blocks, re-read on every render so the reader follows the session.
   */
  blocks(): readonly SectionSource[]
  /**
   * How many rows the overlay may draw.
   * @returns the rows, re-read on every render so a resize needs no notification.
   */
  rows(): number
  /** Columns compare needs before the body splits in two. */
  minColumns: number
  /** The section the reader opens on. */
  cursor: TranscriptCursor
  /**
   * How much of its height the pane draws right now, read per render.
   * @returns a fraction of {@link ReaderPaneOptions.rows}: 1 for the settled
   * reader, less while it grows into place or shrinks away. Absent draws the
   * whole height, which is what a terminal running no motion gets.
   */
  reveal?(): number
}

/**
 * The reader pane: it renders exactly the rows it was given, maps every key
 * to one {@link ReaderIntent}, and settles once when the reader closes.
 */
export class ReaderPane implements Component {
  /** Where the reader left the keyboard and the walk. */
  readonly settled: Promise<ReaderExit>
  private resolve!: (exit: ReaderExit) => void
  /** Whether the reader is still open; a second close is ignored. */
  private open = true
  private state: ReaderState
  /** The width the last render laid out at; 0 before the first one. */
  private width = 0
  /** The body the last render anchored on, so one rewrap re-anchors exactly once. */
  private layout = ''

  /**
   * @param options - the palette, the live transcript reads, and the section to open on.
   */
  constructor(private readonly options: ReaderPaneOptions) {
    this.settled = new Promise<ReaderExit>((resolve) => { this.resolve = resolve })
    this.state = { cursor: options.cursor, column: 'pane', offset: 0 }
  }

  invalidate(): void {}

  /**
   * Draw the reader at `width`.
   * @param width - the columns the overlay was laid out at.
   * @returns as many lines as `rows()` reports, so the overlay covers the
   * viewport it was placed in - fewer while a reveal is still growing or
   * shrinking it - and blank lines once the transcript it was reading is
   * gone.
   */
  render(width: number): string[] {
    this.width = width
    const rows = Math.max(1, this.options.rows())
    const blocks = this.options.blocks()
    const settled = clampCursor(this.state.cursor, blocks) ?? lastSection(blocks)
    if (settled === undefined) {
      // Nothing left to read: the pane settles rather than drawing a frame
      // over a conversation that is gone.
      this.close('editor')
      return Array.from({ length: rows }, () => '')
    }
    this.state = { ...this.state, cursor: settled }
    const groups = turnGroups(blocks)
    const visible = filterTurns(groups, blocks, this.state.query)
    const geometry = this.geometryFor(visible, blocks, rows)
    // The walking pane's own columns and rows, which pinning and unpinning
    // change without the terminal changing size at all.
    const layout = `${geometry.panes.join(',')}x${String(geometry.body)}`
    if (this.layout !== layout) {
      this.layout = layout
      // A rewrap moves every row number, so the reader re-anchors on the
      // section itself rather than on the row the walk had reached.
      this.state = reduceReader(this.state, { kind: 'anchor' }, visible, geometry)
    }
    const full = readerRows(this.state, visible, {
      palette: this.options.palette,
      blocks,
      width,
      rows,
      minColumns: this.options.minColumns,
      totalTurns: groups.length,
    })
    return full.slice(rows - this.drawnRows(rows))
  }

  /**
   * How many of the frame's lines the reveal draws right now.
   *
   * The overlay is anchored at the bottom of the viewport, so a pane that
   * draws fewer lines keeps every line it does draw on the terminal row it
   * will settle on: the reader rises into place rather than sliding, and the
   * conversation above it keeps its own lines throughout.
   * @param rows - the height the frame was laid out at.
   * @returns the lines to keep, counted from the bottom rule up; at least one
   * and never more than the frame has.
   */
  private drawnRows(rows: number): number {
    const reveal = this.options.reveal?.() ?? 1
    if (reveal >= 1) return rows
    return Math.max(1, Math.min(rows, Math.ceil(reveal * rows)))
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
    if (matchesKey(data, 'escape') && readerClosesOnEscape(this.state, geometry)) {
      this.close('transcript')
      return
    }
    const intent = this.intentOf(data)
    if (intent === undefined) return
    this.state = reduceReader(this.state, intent, visible, geometry)
  }

  /** Close the reader from outside, which is what quitting and `Ctrl+C` do. */
  withdraw(): void {
    this.close('editor')
  }

  /**
   * The geometry of the frame as it stands.
   * @param visible - the turns the rail lists.
   * @param blocks - the navigable blocks.
   * @param rows - the rows the overlay draws.
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
    this.resolve({ cursor: this.state.cursor, target })
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
      case 'rail':
        return railIntent(data)
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
 * What one key means while the turn rail owns the keyboard.
 * @param data - the raw key bytes.
 * @returns the intent, or undefined for a key the rail ignores.
 */
function railIntent(data: string): ReaderIntent | undefined {
  if (matchesKey(data, 'up')) return { kind: 'turn', to: 'previous' }
  if (matchesKey(data, 'down')) return { kind: 'turn', to: 'next' }
  if (matchesKey(data, 'home')) return { kind: 'turn', to: 'first' }
  if (matchesKey(data, 'end')) return { kind: 'turn', to: 'last' }
  if (matchesKey(data, 'pageUp')) return { kind: 'page', step: -1 }
  if (matchesKey(data, 'pageDown')) return { kind: 'page', step: 1 }
  if (matchesKey(data, 'right') || matchesKey(data, 'tab') || matchesKey(data, 'enter')) return { kind: 'column', to: 'pane' }
  if (matchesKey(data, 'escape')) return { kind: 'escape' }
  return typedText(data) === FILTER_KEY ? { kind: 'filter' } : undefined
}

/**
 * What one key means while the sections own the keyboard.
 * @param data - the raw key bytes.
 * @returns the intent, or undefined for a key the pane ignores.
 */
function paneIntent(data: string): ReaderIntent | undefined {
  if (matchesKey(data, 'shift+up')) return { kind: 'scroll', step: -1 }
  if (matchesKey(data, 'shift+down')) return { kind: 'scroll', step: 1 }
  if (matchesKey(data, 'up')) return { kind: 'section', to: 'previous' }
  if (matchesKey(data, 'down') || matchesKey(data, 'right')) return { kind: 'section', to: 'next' }
  if (matchesKey(data, 'pageUp')) return { kind: 'page', step: -1 }
  if (matchesKey(data, 'pageDown')) return { kind: 'page', step: 1 }
  if (matchesKey(data, 'home')) return { kind: 'section', to: 'first' }
  if (matchesKey(data, 'end')) return { kind: 'section', to: 'last' }
  if (matchesKey(data, 'left') || matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) return { kind: 'column', to: 'rail' }
  if (matchesKey(data, 'enter')) return { kind: 'pin' }
  if (matchesKey(data, 'escape')) return { kind: 'escape' }
  const digit = typedText(data)
  return digit !== undefined && SECTION_DIGIT.test(digit) ? { kind: 'section-at', index: Number(digit) - 1 } : undefined
}
