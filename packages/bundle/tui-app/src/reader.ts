/**
 * The reader: the whole conversation read full screen, one turn at a time,
 * with a second section pinned beside the one the keyboard walks.
 *
 * The transcript above the editor is the terminal's own scrollback and is
 * never rewritten; this surface is the opposite — free geometry over the
 * viewport, so a turn can be read end to end, two turns can be compared, and
 * a query can narrow the list. Rows are never folded here: the docked
 * inspector shows a budget of each section, and this is where the rest of it
 * is.
 *
 * Everything in this module is plain data: it reads the transcript's own
 * blocks and one {@link ReaderState} and returns lines. No pi-tui tree, no
 * clock, and no terminal — the overlay component owns those.
 * @module @deepseek-ai/dsh-tui-app/reader
 */

import { fuzzyFilter, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { bottomRule, chip, fitLegend, legendRule, ruleRoom, topRule } from './frame.ts'
import {
  cursorAt,
  sectionLabel,
  turnIndexOf,
  type MoveTarget,
  type SectionPart,
  type SectionSource,
  type TranscriptCursor,
  type TurnGroup,
  type TurnMarkers,
} from './navigation.ts'
import type { Palette } from './style.ts'

/** Columns the reader needs before it draws two sections side by side. */
export const READER_MIN_COLUMNS = 80

/** Narrowest terminal the reader draws its frame in at all. */
export const READER_MIN_WIDTH = 24

/** Shortest terminal the reader draws its frame in at all. */
export const READER_MIN_ROWS = 8

/** Below this width the body draws one column at a time: the rail, or the sections it opens. */
const TWO_COLUMN_MIN_WIDTH = 60

/** Columns a pane needs before it is worth drawing beside another one. */
const READER_MIN_PANE = 24

/** Narrowest turn rail. */
const RAIL_MIN_WIDTH = 18

/** Widest turn rail. */
const RAIL_MAX_WIDTH = 30

/** Share of the terminal the turn rail asks for between its two bounds. */
const RAIL_SHARE = 0.28

/** Rows the frame itself takes: the top rule, the legend rule, and the bottom rule. */
const CHROME_ROWS = 3

/** Columns one body column spends on the border before it and the space after it. */
const COLUMN_MARGIN = 2

/** Columns a pane row spends on its left edge, which the held section accents. */
const EDGE_WIDTH = 1

/** What the chip names this mode. */
const READER_CHIP = 'READER'

/** What ends a line the width cut short; one column, so the mark itself fits. */
const ELLIPSIS = '…'

/** The left border of a body row and the border between two body columns. */
const SIDE = '│'

/** Marks the rail row the keyboard holds. */
const RAIL_MARK = '▸ '

/** The left edge every row of the held section carries. */
const HELD_EDGE = '▌'

/** What a section header opens with before its label. */
const HEADER_LEAD = '──'

/** What a section header fills the rest of its pane with. */
const HEADER_FILL = '─'

/** What the reader says on a terminal it cannot draw its frame in. */
export const TOO_SMALL = `terminal too small for the reader (needs ${String(READER_MIN_WIDTH)}×${String(READER_MIN_ROWS)})`

/**
 * The legend of each keyboard owner inside the reader, in declared
 * degradation steps, widest first: the turn rail, and the sections of the
 * held turn. The query line borrows the rail's half of the legend rule, so it
 * declares none of its own. `/help` lists the widest step of each, so the
 * reader's keys are named in one place.
 */
export const READER_HINTS: Record<'rail' | 'pane', readonly [string, ...string[]]> = {
  rail: [
    '↑↓ turns · → sections · Enter opens · / filters · Esc closes',
    '↑↓ turns · → sections · Esc closes',
    'Esc closes',
  ],
  pane: [
    '↑↓ sections · ⇧↑↓ scroll · PgUp PgDn page · Enter pins · Esc back',
    '↑↓ sections · Enter pins · Esc back',
    'Esc back',
  ],
}

/**
 * Which part of the reader owns the keyboard: the turn rail, the sections of
 * the held turn, or the query line the rail is narrowed by.
 */
export type ReaderColumn = 'rail' | 'pane' | 'filter'

/** Where the reader is: what it shows, what it holds, and what it is narrowed to. */
export interface ReaderState {
  /** The section the keyboard holds, which is also where the transcript resumes. */
  cursor: TranscriptCursor
  /** Which part of the reader answers keys. */
  column: ReaderColumn
  /** First visible row of the walking pane. */
  offset: number
  /** The section held beside the walking one; absent while nothing is pinned. */
  pinned?: TranscriptCursor
  /** The query the rail is narrowed by; absent while the rail lists every turn. */
  query?: string
}

/** Where each section of the held turn begins in the walking pane, and how many rows it has in all. */
export interface PaneMeasure {
  /** The pane row each section's header is drawn on, in reading order. */
  headers: readonly number[]
  /** Rows the pane has in all, headers included. */
  total: number
}

/** A pane with nothing in it, for a reader with no turn to show. */
const EMPTY_MEASURE: PaneMeasure = { headers: [], total: 0 }

/** How the reader's body splits the terminal, and what it cannot draw there. */
export interface ReaderGeometry {
  /** Columns the turn rail takes; 0 while it is not drawn. */
  rail: number
  /** Columns of each pane in drawing order: the walking one alone, or the pinned one before it. */
  panes: readonly number[]
  /** Rows between the top rule and the legend rule. */
  body: number
  /** Why compare is not drawn, for the legend; empty while nothing refuses it. */
  refusal: string
  /** Whether the terminal is too small for the frame at all. */
  tiny: boolean
  /** The walking pane's rows, which the scroll keys move over. */
  pane: PaneMeasure
}

/** What one key press means inside the reader. */
export type ReaderIntent =
  /** Step the rail's selection along the turns. */
  | { kind: 'turn'; to: MoveTarget }
  /** Step the pane's selection along the held turn's sections. */
  | { kind: 'section'; to: MoveTarget }
  /** Select one section of the held turn by position. */
  | { kind: 'section-at'; index: number }
  /** Scroll the walking pane one row. */
  | { kind: 'scroll'; step: 1 | -1 }
  /** A page: of the pane's rows with one row of overlap, or of the rail's turns. */
  | { kind: 'page'; step: 1 | -1 }
  /** Give the keyboard to the rail or to the sections. */
  | { kind: 'column'; to: 'rail' | 'pane' }
  /** Pin the held section beside the walk, or unpin it. */
  | { kind: 'pin' }
  /** Open the query line. */
  | { kind: 'filter' }
  /** Extend the query. */
  | { kind: 'query'; text: string }
  /** Drop the query's last character, or all of it. */
  | { kind: 'erase'; all: boolean }
  /** Keep the narrowed rail and close the query line. */
  | { kind: 'commit' }
  /** Clear the query, close the query line, or unpin — the chain before the reader closes. */
  | { kind: 'escape' }
  /** Put the held section back in view after the geometry changed under it. */
  | { kind: 'anchor' }

/** How the reader is drawn. */
export interface ReaderRender {
  /** The palette the frame, the rail, and the headers are styled with. */
  palette: Palette
  /** The blocks the cursors index into, for each section's own rows and label. */
  blocks: readonly SectionSource[]
  /** Columns the frame fits exactly. */
  width: number
  /** Rows the frame fills exactly. */
  rows: number
  /** Columns compare needs before the body splits in two. */
  minColumns: number
  /** Turn groups the transcript has before a query narrowed the rail. */
  totalTurns: number
}

/**
 * Hold one index inside a list.
 * @param value - the wanted index.
 * @param min - the lowest allowed value.
 * @param max - the highest allowed value.
 * @returns the value, moved to the nearest bound when it falls outside.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/**
 * Whether two cursors name the same section.
 * @param left - one cursor.
 * @param right - the other.
 * @returns true when both name the same block and part.
 */
function sameCursor(left: TranscriptCursor, right: TranscriptCursor): boolean {
  return left.block === right.block && left.part === right.part
}

/**
 * Which turn the reader holds.
 * @param state - where the reader is.
 * @param groups - the turns the rail lists.
 * @returns the index into `groups`, and 0 when no listed turn holds the cursor.
 */
function groupIndex(state: ReaderState, groups: readonly TurnGroup[]): number {
  const index = turnIndexOf(state.cursor, groups)
  return index === -1 ? 0 : index
}

/**
 * Which section of its turn the reader holds.
 * @param state - where the reader is.
 * @param group - the turn that holds the cursor.
 * @returns the index into the turn's sections, and 0 when the turn no longer carries it.
 */
function sectionIndex(state: ReaderState, group: TurnGroup): number {
  const index = group.sections.findIndex(section => sameCursor(section, state.cursor))
  return index === -1 ? 0 : index
}

/**
 * The block and part one cursor names.
 * @param cursor - the section.
 * @param blocks - the navigable blocks.
 * @returns both, or undefined when the cursor points past the transcript.
 */
function sectionAt(cursor: TranscriptCursor, blocks: readonly SectionSource[]): { block: SectionSource; part: SectionPart } | undefined {
  const block = blocks[cursor.block]
  const part = block?.parts()[cursor.part]
  if (block === undefined || part === undefined) return undefined
  return { block, part }
}

/**
 * What one section is called in the pane, with the glyph that says what kind
 * of thing it is at a glance.
 * @param block - the block the section belongs to.
 * @param part - the section.
 * @returns the label, e.g. `✻ reasoning` or `⚒ bash git status · result`.
 */
function paneLabel(block: SectionSource, part: SectionPart): string {
  const label = sectionLabel(block, part)
  switch (block.blockKind) {
    case 'context':
      return `⬡ ${label}`
    case 'tool':
      return `⚒ ${label}`
    case 'user':
      return label
    case 'assistant':
      return part.kind === 'reasoning' ? `✻ ${label}` : `¶ ${label}`
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(block, 'tui reader block kind')
  }
}

/**
 * One section's rows as the pane wraps them; never folded, because folding is
 * a decision the transcript makes and this is where the rest of the text is.
 * @param cursor - the section.
 * @param blocks - the navigable blocks.
 * @param width - the pane's columns.
 * @returns the wrapped rows, unstyled.
 */
function sectionBody(cursor: TranscriptCursor, blocks: readonly SectionSource[], width: number): string[] {
  const held = sectionAt(cursor, blocks)
  if (held === undefined) return []
  const room = Math.max(1, width - EDGE_WIDTH)
  return held.part.rows.flatMap(row => wrapTextWithAnsi(row, room))
}

/**
 * Measure the walking pane, which is what the scroll keys move over.
 * @param group - the turn the pane shows.
 * @param blocks - the navigable blocks.
 * @param width - the pane's columns.
 * @returns where each section's header lands and how many rows the pane has.
 */
export function measurePane(group: TurnGroup, blocks: readonly SectionSource[], width: number): PaneMeasure {
  const headers: number[] = []
  let total = 0
  for (const cursor of group.sections) {
    headers.push(total)
    total += 1 + sectionBody(cursor, blocks, width).length
  }
  return { headers, total }
}

/**
 * What the legend says about a pin the terminal cannot draw beside the walk.
 *
 * Compare needs a body that splits in two at all as well as the configured
 * width, so the line names whichever of the two is larger.
 * @param minColumns - columns compare needs before the body splits in two.
 * @returns the refusal.
 */
function compareRefusal(minColumns: number): string {
  return `compare needs ${String(Math.max(minColumns, TWO_COLUMN_MIN_WIDTH))} columns`
}

/**
 * How the reader's body splits one terminal.
 *
 * The rail is what gives way: compare keeps its two panes wherever both still
 * hold a readable section, and a terminal too narrow for two columns draws
 * whichever one the keyboard is in.
 * @param width - the terminal's columns.
 * @param rows - the rows the reader draws.
 * @param state - where the reader is, which decides the single narrow column and whether compare is on.
 * @param minColumns - columns compare needs before the body splits in two.
 * @param pane - the walking pane's measured rows, which the geometry carries for the key model.
 * @returns the rail width, the pane widths in drawing order, the body rows,
 * and the refusal the legend reports.
 */
export function readerGeometry(
  width: number,
  rows: number,
  state: ReaderState,
  minColumns: number,
  pane: PaneMeasure,
): ReaderGeometry {
  const body = Math.max(0, rows - CHROME_ROWS)
  const base = { body, refusal: '', tiny: false, pane }
  if (width < READER_MIN_WIDTH || rows < READER_MIN_ROWS) return { ...base, rail: 0, panes: [], tiny: true }
  // Wherever compare is refused the legend says so, narrow terminals
  // included: the pin is still recorded, and an unreported one costs the
  // Escape chain a press that changes nothing on screen.
  const refusal = state.pinned === undefined ? '' : compareRefusal(minColumns)
  if (width < TWO_COLUMN_MIN_WIDTH) {
    return state.column === 'pane'
      ? { ...base, refusal, rail: 0, panes: [width - COLUMN_MARGIN] }
      : { ...base, refusal, rail: width - COLUMN_MARGIN, panes: [] }
  }
  const rail = clamp(Math.floor(width * RAIL_SHARE), RAIL_MIN_WIDTH, RAIL_MAX_WIDTH)
  const single = width - rail - 2 * COLUMN_MARGIN
  if (state.pinned === undefined) return { ...base, rail, panes: [single] }
  if (width < minColumns) return { ...base, rail, panes: [single], refusal }
  const shared = Math.floor((width - rail - 3 * COLUMN_MARGIN) / 2)
  if (shared >= READER_MIN_PANE) return { ...base, rail, panes: [shared, shared] }
  // Two sections side by side is what the user asked for; the rail is the
  // column that can be reached again with one key.
  const wide = Math.floor((width - 2 * COLUMN_MARGIN) / 2)
  return { ...base, rail: 0, panes: [wide, wide] }
}

/**
 * The reader's geometry over the transcript it is showing, with the walking
 * pane measured at the width that geometry gives it.
 * @param state - where the reader is.
 * @param groups - the turns the rail lists.
 * @param blocks - the navigable blocks.
 * @param width - the terminal's columns.
 * @param rows - the rows the reader draws.
 * @param minColumns - columns compare needs before the body splits in two.
 * @returns the geometry, with its pane measure filled in.
 */
export function readerGeometryFor(
  state: ReaderState,
  groups: readonly TurnGroup[],
  blocks: readonly SectionSource[],
  width: number,
  rows: number,
  minColumns: number,
): ReaderGeometry {
  const layout = readerGeometry(width, rows, state, minColumns, EMPTY_MEASURE)
  const group = groups[groupIndex(state, groups)]
  const paneWidth = layout.panes.at(-1)
  if (group === undefined || paneWidth === undefined) return layout
  return { ...layout, pane: measurePane(group, blocks, paneWidth) }
}

/**
 * The largest first visible pane row; 0 while the pane fits at once.
 * @param geometry - the reader's geometry.
 * @returns the row the scroll stops at.
 */
function maxOffset(geometry: ReaderGeometry): number {
  return Math.max(0, geometry.pane.total - geometry.body)
}

/**
 * Where the pane scrolls to put one section's header on its first row.
 * @param index - the section, by position in its turn.
 * @param geometry - the reader's geometry.
 * @returns the offset.
 */
function showSection(index: number, geometry: ReaderGeometry): number {
  return Math.min(geometry.pane.headers[index] ?? 0, maxOffset(geometry))
}

/**
 * Where one movement target lands along a list.
 * @param to - which way the key steps.
 * @param index - where the selection sits now.
 * @param count - how many entries the list has; at least 1.
 * @returns the index to select.
 */
function targetIndex(to: MoveTarget, index: number, count: number): number {
  switch (to) {
    case 'previous':
      return clamp(index - 1, 0, count - 1)
    case 'next':
      return clamp(index + 1, 0, count - 1)
    case 'first':
      return 0
    case 'last':
      return count - 1
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(to, 'tui reader move target')
  }
}

/**
 * The state without its pinned section.
 * @param state - where the reader is.
 * @returns the same state with compare off.
 */
function withoutPin(state: ReaderState): ReaderState {
  return {
    cursor: state.cursor,
    column: state.column,
    offset: state.offset,
    ...state.query === undefined ? {} : { query: state.query },
  }
}

/**
 * The state without its query.
 * @param state - where the reader is.
 * @returns the same state with the rail listing every turn again.
 */
function withoutQuery(state: ReaderState): ReaderState {
  return {
    cursor: state.cursor,
    column: state.column,
    offset: state.offset,
    ...state.pinned === undefined ? {} : { pinned: state.pinned },
  }
}

/**
 * Put the reader on one section of the turn it holds.
 * @param state - where the reader is.
 * @param index - the section, by position in its turn.
 * @param groups - the turns the rail lists.
 * @param geometry - the reader's geometry.
 * @returns the state on that section, scrolled to it.
 */
function selectSection(state: ReaderState, index: number, groups: readonly TurnGroup[], geometry: ReaderGeometry): ReaderState {
  const group = groups[groupIndex(state, groups)]
  if (group === undefined) return state
  const at = clamp(index, 0, group.sections.length - 1)
  const cursor = group.sections[at]
  /* v8 ignore next -- a listed turn carries at least one section */
  if (cursor === undefined) return state
  return { ...state, column: 'pane', cursor, offset: showSection(at, geometry) }
}

/**
 * Put the reader on one turn, at its first section.
 * @param state - where the reader is.
 * @param index - the turn, by position in the listed turns.
 * @param groups - the turns the rail lists.
 * @returns the state on that turn, scrolled to its top.
 */
function selectTurn(state: ReaderState, index: number, groups: readonly TurnGroup[]): ReaderState {
  const cursor = cursorAt(groups, index, 0)
  /* v8 ignore next -- both callers refuse an empty rail first */
  if (cursor === undefined) return state
  return { ...state, cursor, offset: 0 }
}

/**
 * Answer one page key: a page of the pane's rows with one row of overlap, or
 * a rail's worth of turns.
 * @param state - where the reader is.
 * @param step - 1 for the next page, -1 for the previous one.
 * @param groups - the turns the rail lists.
 * @param geometry - the reader's geometry.
 * @returns the state after the page.
 */
function pageBy(state: ReaderState, step: 1 | -1, groups: readonly TurnGroup[], geometry: ReaderGeometry): ReaderState {
  if (state.column === 'pane') {
    const by = Math.max(1, geometry.body - 1)
    return { ...state, offset: clamp(state.offset + step * by, 0, maxOffset(geometry)) }
  }
  if (groups.length === 0) return state
  return selectTurn(state, clamp(groupIndex(state, groups) + step * Math.max(1, geometry.body), 0, groups.length - 1), groups)
}

/**
 * Whether the body draws one of its columns at a time, which is what a
 * terminal too narrow to hold the rail beside a pane does.
 * @param geometry - the reader's geometry.
 * @returns true while the rail and the sections take turns at the body.
 */
function singleColumn(geometry: ReaderGeometry): boolean {
  return geometry.rail === 0 && geometry.panes.length === 1
}

/**
 * Answer `Escape` inside the reader: clear the query, close the query line,
 * unpin, then - on a terminal that draws one column at a time - step back to
 * the rail. {@link readerClosesOnEscape} reports when the chain is spent and
 * the press closes the reader instead.
 * @param state - where the reader is.
 * @returns the state after one step of the chain.
 */
function escapeStep(state: ReaderState): ReaderState {
  if (state.column === 'filter') {
    if (state.query !== undefined && state.query !== '') return { ...state, query: '' }
    return withoutQuery({ ...state, column: 'rail' })
  }
  if (state.pinned !== undefined) return withoutPin(state)
  return { ...state, column: 'rail' }
}

/**
 * Whether `Escape` closes the reader rather than stepping its own chain.
 * @param state - where the reader is.
 * @param geometry - the reader's geometry, which decides whether the sections
 * still have a rail of their own to step back to.
 * @returns true once no query line is open, nothing is pinned, and the
 * keyboard is not in a narrow terminal's sections.
 */
export function readerClosesOnEscape(state: ReaderState, geometry: ReaderGeometry): boolean {
  if (state.column === 'filter' || state.pinned !== undefined) return false
  return !(state.column === 'pane' && singleColumn(geometry))
}

/**
 * Apply one key press to the reader.
 * @param state - where the reader is.
 * @param intent - what the key meant.
 * @param groups - the turns the rail lists, already narrowed by the query.
 * @param geometry - the reader's geometry, with the walking pane measured.
 * @returns the state after the press; the state itself when nothing moves.
 */
export function reduceReader(
  state: ReaderState,
  intent: ReaderIntent,
  groups: readonly TurnGroup[],
  geometry: ReaderGeometry,
): ReaderState {
  switch (intent.kind) {
    case 'turn':
      return groups.length === 0 ? state : selectTurn(state, targetIndex(intent.to, groupIndex(state, groups), groups.length), groups)
    case 'section': {
      const group = groups[groupIndex(state, groups)]
      if (group === undefined) return state
      return selectSection(state, targetIndex(intent.to, sectionIndex(state, group), group.sections.length), groups, geometry)
    }
    case 'section-at':
      return selectSection(state, intent.index, groups, geometry)
    case 'scroll':
      return { ...state, offset: clamp(state.offset + intent.step, 0, maxOffset(geometry)) }
    case 'page':
      return pageBy(state, intent.step, groups, geometry)
    case 'column':
      return intent.to === 'rail' ? { ...state, column: 'rail' } : selectSection(state, 0, groups, geometry)
    case 'pin':
      return state.pinned !== undefined && sameCursor(state.pinned, state.cursor) ? withoutPin(state) : { ...state, pinned: state.cursor }
    case 'filter':
      return { ...state, column: 'filter', query: state.query ?? '' }
    case 'query':
      return { ...state, query: `${state.query ?? ''}${intent.text}` }
    case 'erase':
      return { ...state, query: intent.all ? '' : (state.query ?? '').slice(0, -1) }
    case 'commit':
      return { ...state, column: 'rail' }
    case 'escape':
      return escapeStep(state)
    case 'anchor':
      return anchorOffset(state, groups, geometry)
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(intent, 'tui reader intent')
  }
}

/**
 * Put the held section back in view after a resize rewrapped the pane under
 * it: the reader re-anchors on the section itself, never on a row number, so
 * a narrower terminal does not lose the user's place.
 * @param state - where the reader is.
 * @param groups - the turns the rail lists.
 * @param geometry - the reader's geometry after the change.
 * @returns the state with its offset settled.
 */
function anchorOffset(state: ReaderState, groups: readonly TurnGroup[], geometry: ReaderGeometry): ReaderState {
  const group = groups[groupIndex(state, groups)]
  if (group === undefined) return state
  const index = sectionIndex(state, group)
  const header = geometry.pane.headers[index] ?? 0
  const top = clamp(state.offset, 0, maxOffset(geometry))
  const visible = header >= top && header < top + geometry.body
  return { ...state, offset: visible ? top : showSection(index, geometry) }
}

/**
 * Narrow the turns to the ones a query matches, keeping the conversation's
 * own order: the rail is a timeline, so it is filtered rather than ranked.
 * @param groups - every turn of the transcript.
 * @param blocks - the navigable blocks, for the text inside each turn.
 * @param query - what the user typed; an empty query keeps every turn.
 * @returns the turns to list.
 */
export function filterTurns(
  groups: readonly TurnGroup[],
  blocks: readonly SectionSource[],
  query: string | undefined,
): readonly TurnGroup[] {
  if (query === undefined || query === '') return groups
  const text = (group: TurnGroup): string => [
    group.label,
    ...group.sections.map(cursor => sectionAt(cursor, blocks)?.part.rows.join(' ') ?? ''),
  ].join(' ')
  const matched = new Set(fuzzyFilter([...groups], query, text))
  return groups.filter(group => matched.has(group))
}

/**
 * What one turn contributed, as the rail reports it at a glance.
 * @param markers - the turn's counts and flags.
 * @returns the marker strip, empty for a turn that contributed none of them.
 */
function markerStrip(markers: TurnMarkers): string {
  const marks: string[] = []
  if (markers.context > 0) marks.push(`⬡${String(markers.context)}`)
  if (markers.reasoning) marks.push('✻')
  if (markers.reply) marks.push('¶')
  if (markers.tools > 0) marks.push(`⚒${String(markers.tools)}`)
  return marks.join('')
}

/**
 * Fit one styled text to an exact number of columns.
 * @param text - the text, already styled.
 * @param width - the columns the cell takes.
 * @returns the text cut and padded to exactly `width`.
 */
function cell(text: string, width: number): string {
  const cut = truncateToWidth(text, Math.max(1, width), ELLIPSIS)
  return `${cut}${' '.repeat(Math.max(0, width - visibleWidth(cut)))}`
}

/**
 * One row of the turn rail: the mark, the turn number, its prompt, and what
 * the turn contributed.
 * @param group - the turn.
 * @param selected - whether the keyboard holds it.
 * @param palette - the palette the row is styled with.
 * @param width - the rail's columns.
 * @returns the row, exactly `width` columns.
 */
function railRow(group: TurnGroup, selected: boolean, palette: Palette, width: number): string {
  const marks = markerStrip(group.markers)
  const room = Math.max(1, width - visibleWidth(marks))
  const lead = `${selected ? RAIL_MARK : '  '}${String(group.turn)}  `
  // The prompt is cut before it is bracketed, so the held row keeps both
  // brackets however narrow the rail is.
  const label = truncateToWidth(group.label, Math.max(1, room - visibleWidth(lead) - (selected ? 2 : 0)), ELLIPSIS)
  const head = `${lead}${selected ? `[${label}]` : label}`
  const text = truncateToWidth(selected ? palette.bold(palette.accent(head)) : palette.dim(head), room, ELLIPSIS)
  return `${text}${' '.repeat(Math.max(0, room - visibleWidth(text)))}${palette.dim(marks)}`
}

/**
 * The turn rail's rows, windowed so the held turn is always drawn.
 * @param groups - the turns the rail lists.
 * @param selected - the held turn's index.
 * @param palette - the palette the rows are styled with.
 * @param width - the rail's columns.
 * @param body - the rows the body has.
 * @returns the rows to draw, oldest first.
 */
function railColumn(groups: readonly TurnGroup[], selected: number, palette: Palette, width: number, body: number): string[] {
  const start = clamp(selected - Math.floor(Math.max(0, body - 1) / 2), 0, Math.max(0, groups.length - body))
  return groups
    .slice(start, start + body)
    .map((group, index) => railRow(group, start + index === selected, palette, width))
}

/**
 * One section header inside a pane.
 * @param text - what the section is called, with its turn.
 * @param palette - the palette the header is styled with.
 * @param width - the pane's columns.
 * @param held - whether the keyboard holds this section.
 * @returns the header row.
 */
function headerRow(text: string, palette: Palette, width: number, held: boolean): string {
  const body = ` ${text} `
  const fill = HEADER_FILL.repeat(Math.max(0, width - visibleWidth(HEADER_LEAD) - visibleWidth(body)))
  const line = `${HEADER_LEAD}${body}${fill}`
  return held ? palette.bold(palette.accent(line)) : palette.dim(line)
}

/**
 * One section as a pane draws it: its header and every one of its rows.
 * @param cursor - the section.
 * @param blocks - the navigable blocks.
 * @param palette - the palette the header and the edge are styled with.
 * @param width - the pane's columns.
 * @param held - whether the keyboard holds this section.
 * @returns the rows, header first.
 */
function sectionRows(
  cursor: TranscriptCursor,
  blocks: readonly SectionSource[],
  palette: Palette,
  width: number,
  held: boolean,
): string[] {
  const found = sectionAt(cursor, blocks)
  if (found === undefined) return []
  const edge = held ? palette.accent(HELD_EDGE) : ' '
  return [
    headerRow(`${paneLabel(found.block, found.part)} · turn ${String(found.block.turn)}`, palette, width, held),
    ...sectionBody(cursor, blocks, width).map(row => `${edge}${row}`),
  ]
}

/**
 * The walking pane's rows: every section of the held turn, in reading order.
 * @param group - the turn the pane shows.
 * @param blocks - the navigable blocks.
 * @param cursor - the section the keyboard holds.
 * @param palette - the palette the headers and edges are styled with.
 * @param width - the pane's columns.
 * @returns the rows, before the scroll window is applied.
 */
function paneColumn(
  group: TurnGroup,
  blocks: readonly SectionSource[],
  cursor: TranscriptCursor,
  palette: Palette,
  width: number,
): string[] {
  return group.sections.flatMap(section => sectionRows(section, blocks, palette, width, sameCursor(section, cursor)))
}

/** One column of the reader's body: the rail, the pinned section, or the walk. */
interface BodyColumn {
  /** The column's rows, before the body height clips them. */
  rows: readonly string[]
  /** The columns it takes. */
  width: number
}

/**
 * Assemble one body row from the columns that are drawn.
 * @param columns - the columns in drawing order.
 * @param row - which of their rows to draw.
 * @param palette - the palette the borders are styled with.
 * @param width - the frame's columns.
 * @returns the row, no wider than `width`.
 */
function bodyRow(columns: readonly BodyColumn[], row: number, palette: Palette, width: number): string {
  const border = palette.accent(SIDE)
  let line = `${border} `
  for (const [index, column] of columns.entries()) {
    const text = column.rows[row] ?? ''
    // The last column has no border after it, so it is not padded either.
    line += index === columns.length - 1
      ? truncateToWidth(text, Math.max(1, column.width), ELLIPSIS)
      : `${cell(text, column.width)}${border} `
  }
  return truncateToWidth(line, Math.max(1, width), ELLIPSIS)
}

/**
 * What the legend rule says on its left: the query line while one is open,
 * the reason compare is not drawn, or the keys this column answers.
 * @param state - where the reader is.
 * @param geometry - the reader's geometry.
 * @param palette - the palette the text is styled with.
 * @param room - the columns the rule leaves its legend.
 * @returns the styled text.
 */
function legendText(state: ReaderState, geometry: ReaderGeometry, palette: Palette, room: number): string {
  if (state.column === 'filter') return palette.accent(truncateToWidth(`/ ${state.query ?? ''}`, Math.max(1, room), ELLIPSIS))
  if (geometry.refusal !== '') return palette.dim(truncateToWidth(geometry.refusal, Math.max(1, room), ELLIPSIS))
  return palette.dim(fitLegend(READER_HINTS[state.column === 'rail' ? 'rail' : 'pane'], room))
}

/**
 * Where one entry sits in the list it belongs to, as both the top rule and
 * the legend readout state it: the 1-based position, and 0 for a list with no
 * entry to be at. A turn's own number is not its position — the blocks before
 * the first prompt are a turn of the rail too — so the position is what every
 * count in the frame is built from.
 * @param index - the entry's index into the list.
 * @param count - how many entries the list has.
 * @returns the position.
 */
function place(index: number, count: number): number {
  return Math.min(index + 1, count)
}

/**
 * What the legend rule reports on its right: how far the walk has come, or
 * how much of the transcript a query still holds.
 * @param state - where the reader is.
 * @param groups - the turns the rail lists.
 * @param geometry - the reader's geometry.
 * @param totalTurns - the turns the transcript has before the query.
 * @returns the readout.
 */
function readout(state: ReaderState, groups: readonly TurnGroup[], geometry: ReaderGeometry, totalTurns: number): string {
  if (state.query !== undefined && state.query !== '') {
    return `${String(groups.length)}/${String(totalTurns)} turns`
  }
  const index = groupIndex(state, groups)
  const group = groups[index]
  const section = group === undefined ? 0 : sectionIndex(state, group)
  const sections = group?.sections.length ?? 0
  // A body drawing the rail alone has no pane to report a row of, which is
  // what `0/0` says rather than claiming the first row of nothing.
  const rowsShown = Math.min(state.offset + 1, geometry.pane.total)
  return [
    `turn ${String(place(index, groups.length))}/${String(groups.length)}`,
    `section ${String(place(section, sections))}/${String(sections)}`,
    `row ${String(rowsShown)}/${String(geometry.pane.total)}`,
  ].join(' · ')
}

/**
 * Draw the reader.
 * @param state - where the reader is.
 * @param groups - the turns the rail lists, already narrowed by the query.
 * @param render - the palette, the blocks, the geometry inputs, and the turn total.
 * @returns exactly `render.rows` lines, none wider than `render.width`.
 */
export function readerRows(state: ReaderState, groups: readonly TurnGroup[], render: ReaderRender): string[] {
  const { palette, blocks, width, totalTurns } = render
  const rows = Math.max(1, render.rows)
  const geometry = readerGeometryFor(state, groups, blocks, width, rows, render.minColumns)
  if (geometry.tiny) {
    const lines = Array.from({ length: rows }, () => '')
    lines[0] = truncateToWidth(palette.dim(TOO_SMALL), Math.max(1, width), ELLIPSIS)
    return lines
  }
  const selected = groupIndex(state, groups)
  const group = groups[selected]
  const columns: BodyColumn[] = []
  if (geometry.rail > 0) {
    columns.push({
      width: geometry.rail,
      rows: groups.length === 0
        ? [palette.dim(`no turn matches "${state.query ?? ''}"`)]
        : railColumn(groups, selected, palette, geometry.rail, geometry.body),
    })
  }
  const [pinnedWidth, comparedWidth] = geometry.panes
  const pinned = state.pinned
  if (pinned !== undefined && comparedWidth !== undefined && pinnedWidth !== undefined) {
    columns.push({ width: pinnedWidth, rows: sectionRows(pinned, blocks, palette, pinnedWidth, false) })
  }
  const paneWidth = geometry.panes.at(-1)
  if (paneWidth !== undefined) {
    columns.push({
      width: paneWidth,
      rows: group === undefined ? [] : paneColumn(group, blocks, state.cursor, palette, paneWidth).slice(state.offset),
    })
  }
  const body: string[] = []
  for (let row = 0; row < geometry.body; row += 1) body.push(bodyRow(columns, row, palette, width))
  const badge = chip(palette, READER_CHIP)
  const position = `${String(state.cursor.block + 1)}/${String(blocks.length)}`
  // The readout is reserved before the legend is chosen: how far the walk has
  // come must not be what a narrow terminal drops.
  const report = readout(state, groups, geometry, totalTurns)
  const legendRoom = ruleRoom(width) - visibleWidth(report) - 1
  return [
    topRule({
      chip: badge,
      title: palette.bold(palette.accent(`turn ${String(place(selected, groups.length))} of ${String(groups.length)}`)),
      right: palette.dim(position),
      width,
      palette,
      tone: 'focus',
    }),
    ...body,
    legendRule({
      left: legendText(state, geometry, palette, legendRoom),
      right: palette.dim(report),
      width,
      palette,
      tone: 'focus',
    }),
    bottomRule({ width, palette, tone: 'focus' }),
  ]
}
