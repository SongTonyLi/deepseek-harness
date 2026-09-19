/**
 * The reader: the whole conversation read full screen in two panels — every
 * turn listed on the left, the turn the list holds on the right, scrolled row
 * by row.
 *
 * The transcript above the editor is the terminal's own scrollback and is
 * never rewritten; this surface is the opposite — free geometry over the
 * viewport, so a turn can be read end to end and a query can narrow the list.
 * Rows are never folded here: the docked inspector shows a budget of each
 * section, and this is where the rest of it is.
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

/** Columns the reader needs before it draws the held turn beside the turn list. */
export const READER_MIN_COLUMNS = 60

/** Narrowest terminal the reader draws its frame in at all. */
export const READER_MIN_WIDTH = 24

/** Shortest terminal the reader draws its frame in at all. */
export const READER_MIN_ROWS = 8

/** Narrowest turn list. */
const LIST_MIN_WIDTH = 18

/** Widest turn list. */
const LIST_MAX_WIDTH = 30

/** Share of the terminal the turn list asks for between its two bounds. */
const LIST_SHARE = 0.28

/** Rows the frame itself takes: the top rule, the legend rule, and the bottom rule. */
const CHROME_ROWS = 3

/** Columns one body column spends on the border before it and the space after it. */
const COLUMN_MARGIN = 2

/** What the chip names this mode. */
const READER_CHIP = 'READER'

/** What ends a line the width cut short; one column, so the mark itself fits. */
const ELLIPSIS = '…'

/** The left border of a body row and the border between the two panels. */
const SIDE = '│'

/** Marks the listed turn the keyboard holds. */
const LIST_MARK = '▸ '

/** What a section header opens with before its label. */
const HEADER_LEAD = '──'

/** What a section header fills the rest of its panel with. */
const HEADER_FILL = '─'

/** What the reader says on a terminal it cannot draw its frame in. */
export const TOO_SMALL = `terminal too small for the reader (needs ${String(READER_MIN_WIDTH)}×${String(READER_MIN_ROWS)})`

/**
 * The legend of each keyboard owner inside the reader, in declared
 * degradation steps, widest first: the turn list, and the turn beside it. The
 * query line borrows the list's half of the legend rule, so it declares none
 * of its own. `/help` lists the widest step of each, so the reader's keys are
 * named in one place.
 */
export const READER_HINTS: Record<'list' | 'pane', readonly [string, ...string[]]> = {
  list: [
    '↑↓ sections · PgUp PgDn turns · → opens · / filters · Esc closes',
    '↑↓ sections · → opens · Esc closes',
    'Esc closes',
  ],
  pane: [
    '↑↓ scrolls · PgUp PgDn pages · ← turns · Esc closes',
    '↑↓ scrolls · ← turns · Esc closes',
    'Esc closes',
  ],
}

/**
 * Which part of the reader owns the keyboard: the turn list, the turn beside
 * it, or the query line the list is narrowed by.
 */
export type ReaderColumn = 'list' | 'pane' | 'filter'

/** Where the reader is: what it shows, what it reads, and what it is narrowed to. */
export interface ReaderState {
  /**
   * The section being read, which is also where the transcript resumes. The
   * list selects a turn by holding its first section, and scrolling the turn
   * moves the cursor to the section the top row belongs to.
   */
  cursor: TranscriptCursor
  /** Which part of the reader answers keys. */
  column: ReaderColumn
  /** First visible row of the turn panel. */
  offset: number
  /** The query the list is narrowed by; absent while the list names every turn. */
  query?: string
}

/** Where each section of the held turn begins in the turn panel, and how many rows it has in all. */
export interface PaneMeasure {
  /** The panel row each section's header is drawn on, in reading order. */
  headers: readonly number[]
  /** Rows the panel has in all, headers included. */
  total: number
}

/** A panel with nothing in it, for a reader with no turn to show. */
const EMPTY_MEASURE: PaneMeasure = { headers: [], total: 0 }

/** How the reader's body splits the terminal, and what it can draw there. */
export interface ReaderGeometry {
  /** Columns the turn list takes; 0 while it is not drawn. */
  list: number
  /** Columns the turn panel takes; 0 while it is not drawn. */
  pane: number
  /** Rows between the top rule and the legend rule. */
  body: number
  /** Whether the terminal is too small for the frame at all. */
  tiny: boolean
  /** The turn panel's rows, which the scroll keys move over. */
  measure: PaneMeasure
}

/** What one key press means inside the reader. */
export type ReaderIntent =
  /** Step the list's selection along the sections, crossing turns at their ends. */
  | { kind: 'section'; to: MoveTarget }
  /** Step the list's selection to the first section of the turn either side. */
  | { kind: 'turn'; step: 1 | -1 }
  /** Move the turn panel one row, or to either of its ends. */
  | { kind: 'scroll'; to: MoveTarget }
  /** A page of the panel's rows, with one row of overlap. */
  | { kind: 'page'; step: 1 | -1 }
  /** Give the keyboard to the list or to the turn beside it. */
  | { kind: 'column'; to: 'list' | 'pane' }
  /** Open the query line. */
  | { kind: 'filter' }
  /** Extend the query. */
  | { kind: 'query'; text: string }
  /** Drop the query's last character, or all of it. */
  | { kind: 'erase'; all: boolean }
  /** Keep the narrowed list and close the query line. */
  | { kind: 'commit' }
  /** Clear the query, then close the query line. */
  | { kind: 'escape' }
  /** Put the section being read back in view after the panel was rewrapped. */
  | { kind: 'anchor' }

/** How the reader is drawn. */
export interface ReaderRender {
  /** The palette the frame, the list, and the headers are styled with. */
  palette: Palette
  /** The blocks the cursors index into, for each section's own rows and label. */
  blocks: readonly SectionSource[]
  /** Columns the frame fits exactly. */
  width: number
  /** Rows the frame fills exactly. */
  rows: number
  /** Columns the reader needs before it draws the held turn beside the list. */
  minColumns: number
  /** Turn groups the transcript has before a query narrowed the list. */
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
 * @param groups - the turns the list names.
 * @returns the index into `groups`, and 0 when no listed turn holds the cursor.
 */
function groupIndex(state: ReaderState, groups: readonly TurnGroup[]): number {
  const index = turnIndexOf(state.cursor, groups)
  return index === -1 ? 0 : index
}

/**
 * Which section of its turn the reader is reading.
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
 * What one section is called in the turn panel, with the glyph that says what
 * kind of thing it is at a glance.
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
 * One section's rows as the panel wraps them; never folded, because folding is
 * a decision the transcript makes and this is where the rest of the text is.
 * @param cursor - the section.
 * @param blocks - the navigable blocks.
 * @param width - the panel's columns.
 * @returns the wrapped rows, unstyled.
 */
function sectionBody(cursor: TranscriptCursor, blocks: readonly SectionSource[], width: number): string[] {
  const held = sectionAt(cursor, blocks)
  if (held === undefined) return []
  return held.part.rows.flatMap(row => wrapTextWithAnsi(row, Math.max(1, width)))
}

/**
 * Measure the turn panel, which is what the scroll keys move over.
 * @param group - the turn the panel shows.
 * @param blocks - the navigable blocks.
 * @param width - the panel's columns.
 * @returns where each section's header lands and how many rows the panel has.
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
 * How the reader's body splits one terminal: the turn list and the held turn
 * beside it, or — on a terminal too narrow for two panels — whichever one the
 * keyboard is in.
 * @param width - the terminal's columns.
 * @param rows - the rows the reader draws.
 * @param state - where the reader is, which decides the single narrow panel.
 * @param minColumns - columns the reader needs before it draws both panels.
 * @returns the panel widths, the body rows, and whether the frame fits at all.
 */
export function readerGeometry(width: number, rows: number, state: ReaderState, minColumns: number): ReaderGeometry {
  const base = { body: Math.max(0, rows - CHROME_ROWS), tiny: false, measure: EMPTY_MEASURE }
  if (width < READER_MIN_WIDTH || rows < READER_MIN_ROWS) return { ...base, list: 0, pane: 0, tiny: true }
  if (width < minColumns) {
    // The query line narrows the list, so it is the list that stays drawn.
    return state.column === 'pane'
      ? { ...base, list: 0, pane: width - COLUMN_MARGIN }
      : { ...base, list: width - COLUMN_MARGIN, pane: 0 }
  }
  const list = clamp(Math.floor(width * LIST_SHARE), LIST_MIN_WIDTH, LIST_MAX_WIDTH)
  return { ...base, list, pane: width - list - 2 * COLUMN_MARGIN }
}

/**
 * The reader's geometry over the transcript it is showing, with the turn panel
 * measured at the width that geometry gives it.
 * @param state - where the reader is.
 * @param groups - the turns the list names.
 * @param blocks - the navigable blocks.
 * @param width - the terminal's columns.
 * @param rows - the rows the reader draws.
 * @param minColumns - columns the reader needs before it draws both panels.
 * @returns the geometry, with its panel measure filled in.
 */
export function readerGeometryFor(
  state: ReaderState,
  groups: readonly TurnGroup[],
  blocks: readonly SectionSource[],
  width: number,
  rows: number,
  minColumns: number,
): ReaderGeometry {
  const layout = readerGeometry(width, rows, state, minColumns)
  const group = groups[groupIndex(state, groups)]
  if (group === undefined || layout.pane === 0) return layout
  return { ...layout, measure: measurePane(group, blocks, layout.pane) }
}

/** One row of the turn list: a turn, or one section of the turn being read. */
export type OutlineRow =
  /** A turn, named by its number and its prompt. */
  | { kind: 'turn'; group: TurnGroup; open: boolean }
  /** A section of the turn being read, named the way the panel heads it. */
  | { kind: 'section'; cursor: TranscriptCursor; held: boolean }

/**
 * The rows the turn list draws: every turn, with the sections of the one being
 * read listed under it. Only that turn opens, so the list stays a timeline a
 * long session can still be walked through, and the sections of another turn
 * are one step away rather than behind a key of their own.
 * @param state - where the reader is.
 * @param groups - the turns the list names.
 * @returns the rows in drawing order, each marked when the cursor holds it.
 */
export function readerOutline(state: ReaderState, groups: readonly TurnGroup[]): OutlineRow[] {
  const held = groupIndex(state, groups)
  return groups.flatMap((group, index) => {
    const turn: OutlineRow = { kind: 'turn', group, open: index === held }
    if (index !== held) return [turn]
    return [turn, ...group.sections.map((cursor): OutlineRow => ({
      kind: 'section',
      cursor,
      held: sameCursor(cursor, state.cursor),
    }))]
  })
}

/**
 * Every section of every listed turn, in reading order, which is what the
 * list's own `Up` and `Down` step along.
 * @param groups - the turns the list names.
 * @returns one cursor per section.
 */
function allSections(groups: readonly TurnGroup[]): TranscriptCursor[] {
  return groups.flatMap(group => [...group.sections])
}

/**
 * The largest first visible panel row; 0 while the whole turn fits at once.
 * @param geometry - the reader's geometry.
 * @returns the row the scroll stops at.
 */
function maxOffset(geometry: ReaderGeometry): number {
  return Math.max(0, geometry.measure.total - geometry.body)
}

/**
 * Where the panel scrolls to put one section's header on its first row.
 * @param index - the section, by position in its turn.
 * @param geometry - the reader's geometry.
 * @returns the offset.
 */
function showSection(index: number, geometry: ReaderGeometry): number {
  return Math.min(geometry.measure.headers[index] ?? 0, maxOffset(geometry))
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
 * The panel measure of one turn, which is the geometry's own while the cursor
 * stays in the turn it was measured for and a fresh one once it crosses into
 * another.
 * @param group - the turn to measure.
 * @param held - the turn the geometry was measured for.
 * @param geometry - the reader's geometry.
 * @param blocks - the navigable blocks.
 * @returns where each of that turn's sections starts.
 */
function measureOf(
  group: TurnGroup,
  held: TurnGroup | undefined,
  geometry: ReaderGeometry,
  blocks: readonly SectionSource[],
): PaneMeasure {
  if (group === held) return geometry.measure
  return geometry.pane === 0 ? EMPTY_MEASURE : measurePane(group, blocks, geometry.pane)
}

/**
 * Put the reader on one section, with the panel scrolled to its header.
 * @param state - where the reader is.
 * @param cursor - the section to read.
 * @param groups - the turns the list names.
 * @param geometry - the reader's geometry.
 * @param blocks - the navigable blocks.
 * @returns the state on that section.
 */
function readSection(
  state: ReaderState,
  cursor: TranscriptCursor,
  groups: readonly TurnGroup[],
  geometry: ReaderGeometry,
  blocks: readonly SectionSource[],
): ReaderState {
  const held = groups[groupIndex(state, groups)]
  const next = groups[turnIndexOf(cursor, groups)]
  /* v8 ignore next -- every cursor the list steps to comes from a listed turn */
  if (next === undefined) return state
  const measure = measureOf(next, held, geometry, blocks)
  const index = next.sections.findIndex(section => sameCursor(section, cursor))
  /* v8 ignore next -- the cursor came from this turn's own sections, so the measure has its row */
  const header = measure.headers[index] ?? 0
  return { ...state, cursor, offset: Math.min(header, Math.max(0, measure.total - geometry.body)) }
}

/**
 * The state without its query.
 * @param state - where the reader is.
 * @returns the same state with the list naming every turn again.
 */
function withoutQuery(state: ReaderState): ReaderState {
  return { cursor: state.cursor, column: state.column, offset: state.offset }
}

/**
 * Scroll the turn panel, and read the cursor off the row it landed on: the
 * section the top row belongs to is the one the transcript resumes at.
 * @param state - where the reader is.
 * @param offset - the first visible panel row, already clamped.
 * @param groups - the turns the list names.
 * @param geometry - the reader's geometry.
 * @returns the state at that row.
 */
function readAt(state: ReaderState, offset: number, groups: readonly TurnGroup[], geometry: ReaderGeometry): ReaderState {
  const group = groups[groupIndex(state, groups)]
  // No header at or above the row leaves the index at -1, which names no
  // section the same way a turn the list does not carry names none.
  const index = geometry.measure.headers.findLastIndex(header => header <= offset)
  const cursor = group?.sections[index]
  return cursor === undefined ? { ...state, offset } : { ...state, cursor, offset }
}

/**
 * Put the reader on one turn, at its first section.
 * @param state - where the reader is.
 * @param index - the turn, by position in the listed turns.
 * @param groups - the turns the list names.
 * @returns the state on that turn, scrolled to its top.
 */
function selectTurn(state: ReaderState, index: number, groups: readonly TurnGroup[]): ReaderState {
  const cursor = cursorAt(groups, index, 0)
  /* v8 ignore next -- the caller refuses an empty list first */
  if (cursor === undefined) return state
  return { ...state, cursor, offset: 0 }
}

/**
 * Answer `Escape` on the query line: clear the query, then close the line and
 * list every turn again. From either panel the key closes the reader instead,
 * which {@link readerClosesOnEscape} reports.
 * @param state - where the reader is.
 * @returns the state after one step of the chain.
 */
function escapeStep(state: ReaderState): ReaderState {
  if (state.query !== undefined && state.query !== '') return { ...state, query: '' }
  return withoutQuery({ ...state, column: 'list' })
}

/**
 * Whether `Escape` closes the reader rather than stepping the query chain.
 * @param state - where the reader is.
 * @returns true from either panel; the key leaves the reader from both, and
 * `Left` is the way back to the turn list.
 */
export function readerClosesOnEscape(state: ReaderState): boolean {
  return state.column !== 'filter'
}

/**
 * Apply one key press to the reader.
 * @param state - where the reader is.
 * @param intent - what the key meant.
 * @param groups - the turns the list names, already narrowed by the query.
 * @param geometry - the reader's geometry, with the turn panel measured.
 * @param blocks - the navigable blocks, for the panel rows of a turn the
 * geometry was not measured for, which is what the list crossing a turn
 * boundary lands on.
 * @returns the state after the press; the state itself when nothing moves.
 */
export function reduceReader(
  state: ReaderState,
  intent: ReaderIntent,
  groups: readonly TurnGroup[],
  geometry: ReaderGeometry,
  blocks: readonly SectionSource[],
): ReaderState {
  switch (intent.kind) {
    case 'section': {
      const sections = allSections(groups)
      const at = sections.findIndex(section => sameCursor(section, state.cursor))
      const cursor = sections[targetIndex(intent.to, Math.max(0, at), sections.length)]
      return cursor === undefined ? state : readSection(state, cursor, groups, geometry, blocks)
    }
    case 'turn':
      return groups.length === 0
        ? state
        : selectTurn(state, clamp(groupIndex(state, groups) + intent.step, 0, groups.length - 1), groups)
    case 'scroll':
      return readAt(state, targetIndex(intent.to, state.offset, maxOffset(geometry) + 1), groups, geometry)
    case 'page':
      return readAt(state, clamp(state.offset + intent.step * Math.max(1, geometry.body - 1), 0, maxOffset(geometry)), groups, geometry)
    case 'column':
      return { ...state, column: intent.to }
    case 'filter':
      return { ...state, column: 'filter', query: state.query ?? '' }
    case 'query':
      return { ...state, query: `${state.query ?? ''}${intent.text}` }
    case 'erase':
      return { ...state, query: intent.all ? '' : (state.query ?? '').slice(0, -1) }
    case 'commit':
      return { ...state, column: 'list' }
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
 * Put the section being read back in view after a resize rewrapped the panel
 * under it: the reader re-anchors on the section itself, never on a row
 * number, so a narrower terminal does not lose the user's place.
 * @param state - where the reader is.
 * @param groups - the turns the list names.
 * @param geometry - the reader's geometry after the change.
 * @returns the state with its offset settled.
 */
function anchorOffset(state: ReaderState, groups: readonly TurnGroup[], geometry: ReaderGeometry): ReaderState {
  const group = groups[groupIndex(state, groups)]
  if (group === undefined) return state
  return { ...state, offset: showSection(sectionIndex(state, group), geometry) }
}

/**
 * Narrow the turns to the ones a query matches, keeping the conversation's
 * own order: the list is a timeline, so it is filtered rather than ranked.
 * @param groups - every turn of the transcript.
 * @param blocks - the navigable blocks, for the text inside each turn.
 * @param query - what the user typed; an empty query keeps every turn.
 * @returns the turns to name.
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
 * What one turn contributed, as the list reports it at a glance.
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
 * One row of the turn list: the mark, the turn number, its prompt, and what
 * the turn contributed.
 * @param group - the turn.
 * @param open - whether this is the turn being read, whose sections follow it.
 * @param focused - whether the list itself has the keyboard.
 * @param palette - the palette the row is styled with.
 * @param width - the list's columns.
 * @returns the row, exactly `width` columns.
 */
function listRow(group: TurnGroup, open: boolean, focused: boolean, palette: Palette, width: number): string {
  const marks = markerStrip(group.markers)
  const room = Math.max(1, width - visibleWidth(marks))
  // The turn being read heads its own sections, so its row carries no mark of
  // its own: the mark is on the section row the cursor holds.
  const lead = `  ${String(group.turn)}  `
  // The prompt is cut before it is bracketed, so the selected row keeps both
  // brackets however narrow the list is.
  const label = truncateToWidth(group.label, Math.max(1, room - visibleWidth(lead) - (open ? 2 : 0)), ELLIPSIS)
  const head = `${lead}${open ? `[${label}]` : label}`
  // The open turn stays legible while the panel beside it has the keyboard,
  // and only the focused list draws it bold.
  const paint = (text: string): string => {
    if (!open) return palette.dim(text)
    return focused ? palette.bold(palette.accent(text)) : palette.accent(text)
  }
  const text = truncateToWidth(paint(head), room, ELLIPSIS)
  return `${text}${' '.repeat(Math.max(0, room - visibleWidth(text)))}${palette.dim(marks)}`
}

/** Columns a section row is indented by, so the turn it belongs to reads as its heading. */
const SECTION_INDENT = '  '

/**
 * One section row of the turn list: the mark, the indent, and the label the
 * panel heads that section with.
 * @param cursor - the section.
 * @param blocks - the navigable blocks.
 * @param selected - whether the cursor holds it.
 * @param focused - whether the list itself has the keyboard.
 * @param palette - the palette the row is styled with.
 * @param width - the list's columns.
 * @returns the row, exactly `width` columns.
 */
function sectionRow(
  cursor: TranscriptCursor,
  blocks: readonly SectionSource[],
  selected: boolean,
  focused: boolean,
  palette: Palette,
  width: number,
): string {
  const found = sectionAt(cursor, blocks)
  const label = found === undefined ? '' : paneLabel(found.block, found.part)
  const head = `${selected ? LIST_MARK : '  '}${SECTION_INDENT}${label}`
  const paint = (text: string): string => {
    if (!selected) return palette.dim(text)
    return focused ? palette.bold(palette.accent(text)) : palette.accent(text)
  }
  return cell(paint(head), width)
}

/**
 * The turn list's rows, windowed so the row the cursor holds is always drawn.
 * @param rows - the outline the list draws.
 * @param blocks - the navigable blocks, for each section's own label.
 * @param focused - whether the list itself has the keyboard.
 * @param palette - the palette the rows are styled with.
 * @param width - the list's columns.
 * @param body - the rows the body has.
 * @returns the rows to draw, oldest first.
 */
function listColumn(
  rows: readonly OutlineRow[],
  blocks: readonly SectionSource[],
  focused: boolean,
  palette: Palette,
  width: number,
  body: number,
): string[] {
  const cursor = rows.findIndex(row => row.kind === 'section' && row.held)
  const start = clamp(Math.max(0, cursor) - Math.floor(Math.max(0, body - 1) / 2), 0, Math.max(0, rows.length - body))
  return rows.slice(start, start + body).map(row => row.kind === 'turn'
    ? listRow(row.group, row.open, focused, palette, width)
    : sectionRow(row.cursor, blocks, row.held, focused, palette, width))
}

/**
 * One section header inside the turn panel.
 * @param text - what the section is called, with its turn.
 * @param palette - the palette the header is styled with.
 * @param width - the panel's columns.
 * @param reading - whether this is the section the top row belongs to.
 * @returns the header row.
 */
function headerRow(text: string, palette: Palette, width: number, reading: boolean): string {
  const body = ` ${text} `
  const fill = HEADER_FILL.repeat(Math.max(0, width - visibleWidth(HEADER_LEAD) - visibleWidth(body)))
  const line = `${HEADER_LEAD}${body}${fill}`
  return reading ? palette.bold(palette.accent(line)) : palette.dim(line)
}

/**
 * The turn panel's rows: every section of the held turn, in reading order,
 * each under its own header.
 * @param group - the turn the panel shows.
 * @param blocks - the navigable blocks.
 * @param cursor - the section the top row belongs to.
 * @param palette - the palette the headers are styled with.
 * @param width - the panel's columns.
 * @returns the rows, before the scroll window is applied.
 */
function paneColumn(
  group: TurnGroup,
  blocks: readonly SectionSource[],
  cursor: TranscriptCursor,
  palette: Palette,
  width: number,
): string[] {
  return group.sections.flatMap((section) => {
    const found = sectionAt(section, blocks)
    if (found === undefined) return []
    const label = `${paneLabel(found.block, found.part)} · turn ${String(found.block.turn)}`
    return [
      headerRow(label, palette, width, sameCursor(section, cursor)),
      ...sectionBody(section, blocks, width),
    ]
  })
}

/** One column of the reader's body: the turn list, or the turn beside it. */
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
 * What the legend rule says on its left: the query line while one is open, or
 * the keys the panel holding the keyboard answers.
 * @param state - where the reader is.
 * @param palette - the palette the text is styled with.
 * @param room - the columns the rule leaves its legend.
 * @returns the styled text.
 */
function legendText(state: ReaderState, palette: Palette, room: number): string {
  if (state.column === 'filter') return palette.accent(truncateToWidth(`/ ${state.query ?? ''}`, Math.max(1, room), ELLIPSIS))
  return palette.dim(fitLegend(READER_HINTS[state.column], room))
}

/**
 * Where one entry sits in the list it belongs to, as both the top rule and
 * the legend readout state it: the 1-based position, and 0 for a list with no
 * entry to be at. A turn's own number is not its position — the blocks before
 * the first prompt are a turn of the list too — so the position is what every
 * count in the frame is built from.
 * @param index - the entry's index into the list.
 * @param count - how many entries the list has.
 * @returns the position.
 */
function place(index: number, count: number): number {
  return Math.min(index + 1, count)
}

/**
 * What the legend rule reports on its right: how far the read has come, or
 * how much of the transcript a query still holds.
 * @param state - where the reader is.
 * @param groups - the turns the list names.
 * @param geometry - the reader's geometry.
 * @param totalTurns - the turns the transcript has before the query.
 * @returns the readout.
 */
function readout(state: ReaderState, groups: readonly TurnGroup[], geometry: ReaderGeometry, totalTurns: number): string {
  if (state.query !== undefined && state.query !== '') {
    return `${String(groups.length)}/${String(totalTurns)} turns`
  }
  const index = groupIndex(state, groups)
  // A body drawing the list alone has no panel to report a row of, which is
  // what `0/0` says rather than claiming the first row of nothing.
  const rowsShown = Math.min(state.offset + 1, geometry.measure.total)
  return [
    `turn ${String(place(index, groups.length))}/${String(groups.length)}`,
    `row ${String(rowsShown)}/${String(geometry.measure.total)}`,
  ].join(' · ')
}

/**
 * Draw the reader.
 * @param state - where the reader is.
 * @param groups - the turns the list names, already narrowed by the query.
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
  if (geometry.list > 0) {
    columns.push({
      width: geometry.list,
      rows: groups.length === 0
        ? [palette.dim(`no turn matches "${state.query ?? ''}"`)]
        : listColumn(readerOutline(state, groups), blocks, state.column !== 'pane', palette, geometry.list, geometry.body),
    })
  }
  if (geometry.pane > 0) {
    columns.push({
      width: geometry.pane,
      rows: group === undefined ? [] : paneColumn(group, blocks, state.cursor, palette, geometry.pane).slice(state.offset),
    })
  }
  const body: string[] = []
  for (let row = 0; row < geometry.body; row += 1) body.push(bodyRow(columns, row, palette, width))
  // The readout is reserved before the legend is chosen: how far the read has
  // come must not be what a narrow terminal drops.
  const report = readout(state, groups, geometry, totalTurns)
  const legendRoom = ruleRoom(width) - visibleWidth(report) - 1
  return [
    topRule({
      chip: chip(palette, READER_CHIP),
      title: palette.bold(palette.accent(`turn ${String(place(selected, groups.length))} of ${String(groups.length)}`)),
      width,
      palette,
      tone: 'focus',
    }),
    ...body,
    legendRule({
      left: legendText(state, palette, legendRoom),
      right: palette.dim(report),
      width,
      palette,
      tone: 'focus',
    }),
    bottomRule({ width, palette, tone: 'focus' }),
  ]
}
