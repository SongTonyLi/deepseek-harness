/** The reader as plain data: how it splits a terminal, what one key moves, and the lines it draws. */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { turnGroups, type SectionSource, type TranscriptCursor } from '../src/navigation.ts'
import type { FadeStyle } from '../src/fade.ts'
import {
  READER_MIN_COLUMNS,
  TOO_SMALL,
  filterTurns,
  measurePane,
  readerClosesOnEscape,
  readerGeometry,
  readerGeometryFor,
  readerOutline,
  readerRows,
  readerTints,
  reduceReader,
  type ReaderRender,
  type ReaderState,
} from '../src/reader.ts'
import { GONE, source, transcript } from './section-source.ts'
import { createPalette, type CodeHighlighter } from '../src/style.ts'

/** A palette that returns its text unchanged, so a spec reads the drawn columns. */
const PLAIN = createPalette(false)

/**
 * The turn panel's part of one plain body row, without the frame's right border.
 * @param line - the row, with no styling.
 * @returns the panel's text, its padding trimmed.
 */
function panel(line: string): string {
  return line.slice(27).replace(/ │$/, '').trimEnd()
}

/**
 * The reader over a scripted transcript.
 * @param cursor - the section the reader is reading.
 * @param overrides - the rest of the state.
 * @returns the blocks, their turns, the state, and the geometry at 95×40.
 */
function reader(cursor: TranscriptCursor, overrides: Partial<ReaderState> = {}): {
  blocks: SectionSource[]
  groups: ReturnType<typeof turnGroups>
  state: ReaderState
  geometry: ReturnType<typeof readerGeometryFor>
} {
  const blocks = transcript()
  const groups = turnGroups(blocks)
  const state: ReaderState = { cursor, column: 'pane', offset: 0, ...overrides }
  return { blocks, groups, state, geometry: readerGeometryFor(state, groups, blocks, 95, 40, READER_MIN_COLUMNS) }
}

describe('readerGeometry', () => {
  const state: ReaderState = { cursor: { block: 0, part: 0 }, column: 'pane', offset: 0 }

  it('gives the turn list a share of the terminal between its two bounds', () => {
    expect(readerGeometry(95, 40, state, 60)).toMatchObject({ list: 23, pane: 66, body: 37, tiny: false })
    // The share is clamped at both ends: 18 columns at 60, 28 at 200.
    expect(readerGeometry(60, 40, state, 60)).toMatchObject({ list: 18, pane: 36 })
    expect(readerGeometry(200, 40, state, 60)).toMatchObject({ list: 28, pane: 166 })
  })

  it('draws one panel at a time below the configured width', () => {
    expect(readerGeometry(59, 20, state, 60)).toMatchObject({ list: 0, pane: 55 })
    expect(readerGeometry(59, 20, { ...state, column: 'list' }, 60)).toMatchObject({ list: 55, pane: 0 })
    // The query line narrows the list, so it is the list that stays drawn.
    expect(readerGeometry(59, 20, { ...state, column: 'filter' }, 60)).toMatchObject({ list: 55, pane: 0 })
    // A wider setting keeps one panel on a terminal two would cramp.
    expect(readerGeometry(95, 40, state, 120)).toMatchObject({ list: 0, pane: 91 })
  })

  it('refuses a terminal the frame does not fit in', () => {
    expect(readerGeometry(20, 40, state, 60).tiny).toBe(true)
    expect(readerGeometry(95, 6, state, 60).tiny).toBe(true)
  })
})

describe('measurePane', () => {
  it('reports where each section starts and how many rows the panel has', () => {
    const blocks = transcript()
    const groups = turnGroups(blocks)
    const group = groups[1]
    expect(group).toBeDefined()
    // The prompt's one band row, then the reasoning, the reply, and the tool's
    // two sections, each under one header row, with a blank row between each
    // two sections.
    expect(measurePane(group!, blocks, 60)).toEqual({ headers: [0, 2, 5, 47, 50], total: 52 })
  })

  it('measures the same after its memo of measured replies starts over', () => {
    const blocks = transcript()
    const group = turnGroups(blocks)[1]!
    const first = measurePane(group, blocks, 60)
    // Every width is a reply the memo has not measured, which overflows it.
    for (let width = 40; width < 340; width += 1) measurePane(group, blocks, width)
    expect(measurePane(group, blocks, 60)).toEqual(first)
  })

  it('reports nothing for a section the transcript no longer carries', () => {
    expect(measurePane(GONE, transcript(), 60)).toEqual({ headers: [0], total: 0 })
  })
})

describe('reduceReader over the turn list', () => {
  it('steps one section either way and crosses into the turn either side', () => {
    const { blocks, groups, state, geometry } = reader({ block: 2, part: 1 }, { column: 'list' })
    const step = (from: ReaderState, to: 'previous' | 'next'): ReaderState =>
      reduceReader(from, { kind: 'section', to }, groups, geometry, blocks)
    expect(step(state, 'previous').cursor).toEqual({ block: 2, part: 0 })
    expect(step(state, 'next').cursor).toEqual({ block: 3, part: 0 })
    // The prompt of a turn is one step from the last section of the turn
    // before it, so the list walks the conversation rather than one turn.
    const opening = { ...state, cursor: { block: 1, part: 0 } }
    expect(step(opening, 'previous').cursor).toEqual({ block: 0, part: 0 })
    expect(step({ ...state, cursor: { block: 0, part: 0 } }, 'previous').cursor).toEqual({ block: 0, part: 0 })
    expect(step({ ...state, cursor: { block: 5, part: 0 } }, 'next').cursor).toEqual({ block: 5, part: 0 })
  })

  it('reaches either end of the conversation in one press', () => {
    const { blocks, groups, state, geometry } = reader({ block: 2, part: 1 }, { column: 'list' })
    expect(reduceReader(state, { kind: 'section', to: 'first' }, groups, geometry, blocks).cursor).toEqual({ block: 0, part: 0 })
    expect(reduceReader(state, { kind: 'section', to: 'last' }, groups, geometry, blocks).cursor).toEqual({ block: 5, part: 0 })
  })

  it('scrolls the panel to the section the list lands on', () => {
    const { blocks, groups, state, geometry } = reader({ block: 1, part: 0 }, { column: 'list' })
    // The reasoning is the turn's second section, two rows into the panel.
    expect(reduceReader(state, { kind: 'section', to: 'next' }, groups, geometry, blocks)).toMatchObject({
      cursor: { block: 2, part: 0 },
      offset: 2,
    })
    // A section in another turn is measured in that turn's own panel, which
    // is shorter than one body and so starts at its top.
    expect(reduceReader(state, { kind: 'section', to: 'last' }, groups, geometry, blocks)).toMatchObject({
      cursor: { block: 5, part: 0 },
      offset: 0,
    })
  })

  it('steps a whole turn with the page keys and stops at both ends', () => {
    const { blocks, groups, state, geometry } = reader({ block: 2, part: 1 }, { column: 'list', offset: 12 })
    expect(reduceReader(state, { kind: 'turn', step: -1 }, groups, geometry, blocks)).toMatchObject({
      cursor: { block: 0, part: 0 },
      offset: 0,
    })
    const last = reduceReader(state, { kind: 'turn', step: 1 }, groups, geometry, blocks)
    expect(last.cursor).toEqual({ block: 4, part: 0 })
    expect(reduceReader(last, { kind: 'turn', step: 1 }, groups, geometry, blocks).cursor).toEqual({ block: 4, part: 0 })
  })

  it('crosses turns on a terminal with no panel drawn beside the list', () => {
    const blocks = transcript()
    const groups = turnGroups(blocks)
    const state: ReaderState = { cursor: { block: 2, part: 1 }, column: 'list', offset: 0 }
    // The list has the whole body here, so there is no panel to scroll and
    // no rows to measure in the turn the step lands on.
    const narrow = readerGeometryFor(state, groups, blocks, 50, 20, READER_MIN_COLUMNS)
    expect(narrow.pane).toBe(0)
    expect(reduceReader(state, { kind: 'section', to: 'last' }, groups, narrow, blocks)).toMatchObject({
      cursor: { block: 5, part: 0 },
      offset: 0,
    })
  })

  it('hands the keyboard to the turn beside it and takes it back', () => {
    const { blocks, groups, state, geometry } = reader({ block: 1, part: 0 }, { column: 'list' })
    const opened = reduceReader(state, { kind: 'column', to: 'pane' }, groups, geometry, blocks)
    // The section the list holds is what the panel was already showing, so
    // the keyboard moves and nothing else does.
    expect(opened).toMatchObject({ column: 'pane', cursor: { block: 1, part: 0 }, offset: 0 })
    expect(reduceReader(opened, { kind: 'column', to: 'list' }, groups, geometry, blocks).column).toBe('list')
  })

  it('leaves the reading where it is on a transcript with no listed turn', () => {
    const { blocks, state, geometry } = reader({ block: 2, part: 1 }, { column: 'list' })
    for (const intent of [
      { kind: 'section', to: 'next' },
      { kind: 'turn', step: 1 },
      { kind: 'anchor' },
    ] as const) {
      expect(reduceReader(state, intent, [], geometry, blocks)).toBe(state)
    }
    expect(reduceReader(state, { kind: 'scroll', to: 'next' }, [], geometry, blocks).cursor).toEqual({ block: 2, part: 1 })
  })
})

describe('readerOutline', () => {
  it('lists every turn and opens the one being read', () => {
    const { groups, state } = reader({ block: 2, part: 1 }, { column: 'list' })
    const rows = readerOutline(state, groups)
    expect(rows.map(row => row.kind)).toEqual(['turn', 'turn', 'section', 'section', 'section', 'section', 'section', 'turn'])
    // One turn is open, and one of its section rows carries the cursor.
    expect(rows.filter(row => row.kind === 'turn' && row.open)).toHaveLength(1)
    const held = rows.filter(row => row.kind === 'section' && row.held)
    expect(held).toEqual([{ kind: 'section', cursor: { block: 2, part: 1 }, held: true }])
  })
})

describe('reduceReader over the turn panel', () => {
  it('scrolls one row and stops at both ends', () => {
    const { blocks, groups, state, geometry } = reader({ block: 2, part: 1 })
    expect(reduceReader(state, { kind: 'scroll', to: 'previous' }, groups, geometry, blocks).offset).toBe(0)
    expect(reduceReader(state, { kind: 'scroll', to: 'next' }, groups, geometry, blocks).offset).toBe(1)
    const end = reduceReader(state, { kind: 'scroll', to: 'last' }, groups, geometry, blocks)
    expect(end.offset).toBe(geometry.measure.total - geometry.body)
    expect(reduceReader(end, { kind: 'scroll', to: 'next' }, groups, geometry, blocks).offset).toBe(end.offset)
    expect(reduceReader(end, { kind: 'scroll', to: 'first' }, groups, geometry, blocks).offset).toBe(0)
  })

  it('reads the cursor off the row the scroll landed on', () => {
    const { blocks, groups, state, geometry } = reader({ block: 1, part: 0 })
    // The turn opens on its prompt, with the reasoning two rows down and the
    // reply five: the section under the top row is where the transcript
    // resumes, so the reading itself moves it.
    expect(reduceReader(state, { kind: 'scroll', to: 'next' }, groups, geometry, blocks).cursor).toEqual({ block: 1, part: 0 })
    expect(reduceReader({ ...state, offset: 1 }, { kind: 'scroll', to: 'next' }, groups, geometry, blocks).cursor).toEqual({ block: 2, part: 0 })
    const reply = reduceReader({ ...state, offset: 4 }, { kind: 'scroll', to: 'next' }, groups, geometry, blocks)
    expect(reply.cursor).toEqual({ block: 2, part: 1 })
    expect(reduceReader(reply, { kind: 'scroll', to: 'first' }, groups, geometry, blocks).cursor).toEqual({ block: 1, part: 0 })
    // The reply is the turn's longest section, so its last page starts in it.
    expect(reduceReader(reply, { kind: 'scroll', to: 'last' }, groups, geometry, blocks).cursor).toEqual({ block: 2, part: 1 })
  })

  it('pages the turn with one row of overlap', () => {
    const blocks = transcript()
    const groups = turnGroups(blocks)
    const state: ReaderState = { cursor: { block: 2, part: 1 }, column: 'pane', offset: 0 }
    const geometry = readerGeometryFor(state, groups, blocks, 95, 12, READER_MIN_COLUMNS)
    const page = reduceReader(state, { kind: 'page', step: 1 }, groups, geometry, blocks)
    expect(page.offset).toBe(geometry.body - 1)
    expect(reduceReader(page, { kind: 'page', step: -1 }, groups, geometry, blocks).offset).toBe(0)
    // The last page stops at the panel's own end rather than past it.
    const far = reduceReader({ ...state, offset: geometry.measure.total }, { kind: 'page', step: 1 }, groups, geometry, blocks)
    expect(far.offset).toBe(geometry.measure.total - geometry.body)
  })

  it('re-anchors on the turn\'s first section when the one it read is gone', () => {
    const { blocks, groups, geometry } = reader({ block: 2, part: 1 })
    // The block is still listed, so its turn is found and the reading comes
    // back to the top of it.
    const state: ReaderState = { cursor: { block: 2, part: 9 }, column: 'pane', offset: 30 }
    expect(reduceReader(state, { kind: 'anchor' }, groups, geometry, blocks).offset).toBe(0)
  })

  it('re-anchors on the section being read after the panel was rewrapped', () => {
    const blocks = transcript()
    const groups = turnGroups(blocks)
    const state: ReaderState = { cursor: { block: 2, part: 1 }, column: 'pane', offset: 0 }
    const wide = readerGeometryFor(state, groups, blocks, 95, 40, READER_MIN_COLUMNS)
    // The reply is the turn's third section, which starts five rows down.
    expect(reduceReader(state, { kind: 'anchor' }, groups, wide, blocks).offset).toBe(5)
    // A terminal with no panel at all has no row to anchor on.
    const narrow = readerGeometryFor({ ...state, column: 'list' }, groups, blocks, 50, 20, READER_MIN_COLUMNS)
    expect(reduceReader(state, { kind: 'anchor' }, groups, narrow, blocks).offset).toBe(0)
  })
})

describe('reduceReader over the query line', () => {
  it('opens, extends, erases, and commits the query', () => {
    const { blocks, groups, state, geometry } = reader({ block: 2, part: 1 })
    const open = reduceReader(state, { kind: 'filter' }, groups, geometry, blocks)
    expect(open).toMatchObject({ column: 'filter', query: '' })
    const typed = reduceReader(reduceReader(open, { kind: 'query', text: 'te' }, groups, geometry, blocks), { kind: 'query', text: 'sts' }, groups, geometry, blocks)
    expect(typed.query).toBe('tests')
    expect(reduceReader(typed, { kind: 'erase', all: false }, groups, geometry, blocks).query).toBe('test')
    expect(reduceReader(typed, { kind: 'erase', all: true }, groups, geometry, blocks).query).toBe('')
    expect(reduceReader(typed, { kind: 'commit' }, groups, geometry, blocks)).toMatchObject({ column: 'list', query: 'tests' })
  })

  it('erases and extends a query line that was never typed into', () => {
    const { blocks, groups, state, geometry } = reader({ block: 2, part: 1 })
    expect(reduceReader(state, { kind: 'erase', all: false }, groups, geometry, blocks).query).toBe('')
    expect(reduceReader(state, { kind: 'query', text: 'a' }, groups, geometry, blocks).query).toBe('a')
  })

  it('walks the Escape chain: the query, then the query line, then the reader itself', () => {
    const { blocks, groups, state, geometry } = reader({ block: 2, part: 1 })
    const typed = reduceReader(reduceReader(state, { kind: 'filter' }, groups, geometry, blocks), { kind: 'query', text: 'tests' }, groups, geometry, blocks)
    expect(readerClosesOnEscape(typed)).toBe(false)
    const cleared = reduceReader(typed, { kind: 'escape' }, groups, geometry, blocks)
    expect(cleared).toMatchObject({ column: 'filter', query: '' })
    const closed = reduceReader(cleared, { kind: 'escape' }, groups, geometry, blocks)
    expect(closed).toMatchObject({ column: 'list' })
    expect(closed.query).toBeUndefined()
    // Both panels answer the key the same way: it leaves the reader.
    expect(readerClosesOnEscape(closed)).toBe(true)
    expect(readerClosesOnEscape(state)).toBe(true)
  })

  it('keeps the query while the query line closes and reopens', () => {
    const { blocks, groups, state, geometry } = reader({ block: 2, part: 1 }, { query: 'tests' })
    expect(reduceReader(state, { kind: 'filter' }, groups, geometry, blocks).query).toBe('tests')
  })
})

describe('filterTurns', () => {
  it('keeps the conversation\'s own order rather than the match ranking', () => {
    const blocks = transcript()
    const groups = turnGroups(blocks)
    expect(filterTurns(groups, blocks, undefined)).toBe(groups)
    expect(filterTurns(groups, blocks, '')).toBe(groups)
    // The query reaches the text inside a turn, not only its prompt, and the
    // kept turns stay in the order the conversation put them in.
    expect(filterTurns(groups, blocks, 'clean tree').map(group => group.label)).toEqual(['fix the fade at the top'])
    expect(filterTurns(groups, blocks, 'all green').map(group => group.label)).toEqual(['run the tests'])
    expect(filterTurns(groups, blocks, 'reply row').map(group => group.label)).toEqual(['fix the fade at the top'])
    expect(filterTurns(groups, blocks, 'zzzz')).toEqual([])
  })

  it('matches a turn whose section the transcript no longer carries', () => {
    expect(filterTurns([GONE], transcript(), 'gone')).toHaveLength(1)
  })
})

describe('readerRows', () => {
  /**
   * Draw the reader over the scripted transcript.
   * @param state - where the reader is.
   * @param width - the terminal's columns.
   * @param rows - the terminal's rows.
   * @param query - a query narrowing the list.
   * @returns the lines.
   */
  function draw(state: ReaderState, width: number, rows: number, query?: string): string[] {
    const blocks = transcript()
    const groups = turnGroups(blocks)
    const visible = filterTurns(groups, blocks, query)
    // A cut line carries the sequences `truncateToWidth` closes its mark with,
    // so a spec reads the columns rather than the bytes.
    return readerRows(state, visible, {
      palette: PLAIN,
      blocks,
      width,
      rows,
      minColumns: READER_MIN_COLUMNS,
      totalTurns: groups.length,
    }).map(stripTerminalSequences)
  }

  const held: ReaderState = { cursor: { block: 2, part: 1 }, column: 'pane', offset: 5 }

  it('fills exactly the rows it was given at every size', () => {
    for (const [width, rows] of [[95, 40], [80, 24], [59, 20], [40, 12], [20, 6]] as const) {
      const lines = draw(held, width, rows)
      expect(lines).toHaveLength(rows)
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  it('names the mode, the turn, the listed prompts, and the keys', () => {
    const lines = draw(held, 95, 40).join('\n')
    expect(lines).toContain(' ● READER ')
    // The rule states where the reading is in the list, which is what the
    // readout under it states too: the blocks before the first prompt are a
    // row of the list too, so a turn's own number sits one behind its position.
    expect(lines).toContain('turn 2 of 3')
    // The turn being read leads with `❯`, its prompt is cut before the
    // markers, and the section the reader holds is marked under it.
    expect(lines).toContain('│ ❯ 1  fix the fade… ✻¶◆1│')
    expect(lines).toContain('│     ✻ Thinking         │')
    expect(lines).toContain('│   ▸ ¶ Reply            │')
    expect(lines).toContain('│   0  session start   ⬡1│')
    // The held section carries the conversation walk's own gutter.
    expect(lines).toContain('│ ┃ ¶ Reply')
    expect(lines).toContain('│ ┃   reply row 0')
    expect(lines).toContain('↑↓ scrolls · PgUp PgDn pages · ← turns · Esc closes')
    expect(lines).toContain('turn 2/3 · row 6/52')
  })

  it('opens the turn on its prompt and heads every other section with its kind', () => {
    const turn = draw({ ...held, cursor: { block: 2, part: 0 }, offset: 0 }, 95, 40)
    // Every body row closes the frame on the right.
    for (const line of turn.slice(1, -2)) expect(line.endsWith(' │')).toBe(true)
    const pane = turn.map(panel)
    // The prompt, then each section under its header with a blank row between
    // them, the held one behind the gutter.
    expect(pane.slice(1, 7)).toEqual([
      '  ❯ fix the fade at the top',
      '',
      '┃ ✻ Thinking',
      '┃   the tail is matched backwards',
      '',
      '  ¶ Reply',
    ])
    const context = draw({ ...held, cursor: { block: 0, part: 0 }, offset: 0 }, 95, 40).join('\n')
    expect(context).toContain('│ ┃ ⬡ system prompt')
    expect(context).toContain('│ ┃   you are the agent')
    // The tool's own sections sit past the reply, which the reading scrolls
    // to: the call under the tool and its headline, the result indented under it.
    const tool = draw({ ...held, cursor: { block: 3, part: 1 }, offset: 47 }, 95, 40)
    expect(tool.map(panel).slice(1, 6)).toEqual([
      '  ◆ bash git status',
      '    {"command":"git status"}',
      '',
      '┃   ⎿ Result',
      '┃     clean tree',
    ])
  })

  it('names the list\'s own keys while the list holds the keyboard', () => {
    expect(draw({ ...held, column: 'list' }, 95, 40).join('\n'))
      .toContain('↑↓ sections · PgUp PgDn turns · → opens · / filters · Esc closes')
    // The readout is reserved first, so a narrower rule drops legend words
    // rather than the position.
    const narrow = draw({ ...held, column: 'list' }, 60, 20).join('\n')
    expect(narrow).toContain('↑↓ sections · → opens · Esc closes')
    expect(narrow).toContain('turn 2/3 · row 6/52')
  })

  it('shows the query line and how much of the transcript it kept', () => {
    const lines = draw({ ...held, column: 'filter', query: 'green' }, 95, 40, 'green').join('\n')
    expect(lines).toContain('/ green')
    expect(lines).toContain('1/3 turns')
    expect(lines).toContain('❯ 2  run the tests')
  })

  it('says so when no turn matches', () => {
    const lines = draw({ ...held, column: 'list', query: 'zzzz' }, 95, 40, 'zzzz').join('\n')
    expect(lines).toContain('no turn matches "zzzz"')
    // A list naming no turn holds the reading at no position in it.
    expect(lines).toContain('turn 0 of 0')
    expect(lines).toContain('0/3 turns')
  })

  it('draws an empty query line, and a transcript with no turn at all', () => {
    expect(draw({ ...held, column: 'filter' }, 95, 40).join('\n')).toContain('/ ')
    const empty = readerRows(held, [], {
      palette: PLAIN,
      blocks: transcript(),
      width: 95,
      rows: 40,
      minColumns: READER_MIN_COLUMNS,
      totalTurns: 0,
    }).join('\n')
    expect(empty).toContain('no turn matches ""')
    expect(empty).toContain('turn 0/0 · row 0/0')
  })

  it('draws a turn whose sections the transcript no longer carries', () => {
    const lines = readerRows({ cursor: { block: 99, part: 0 }, column: 'pane', offset: 0 }, [GONE], {
      palette: PLAIN,
      blocks: transcript(),
      width: 95,
      rows: 40,
      minColumns: READER_MIN_COLUMNS,
      totalTurns: 1,
    }).map(stripTerminalSequences)
    expect(lines).toHaveLength(40)
    // The turn row stands, and the section row under it names nothing.
    expect(lines.join('\n')).toContain('❯ 9  gone')
    expect(lines[2]).toBe(`│   ▸${' '.repeat(20)}│ ${' '.repeat(66)} │`)
  })

  it('refuses a terminal the frame does not fit in', () => {
    const lines = draw(held, 20, 6)
    expect(lines).toHaveLength(6)
    expect(lines[0]).toContain('terminal too small')
    expect(TOO_SMALL).toBe('terminal too small for the reader (needs 24×8)')
  })

  it('draws the turn alone on a narrow terminal, and the list alone the other way', () => {
    expect(draw(held, 59, 20).join('\n')).toContain('reply row 0')
    const list = draw({ ...held, column: 'list' }, 59, 20).join('\n')
    expect(list).toContain('  0  session start')
    expect(list).toContain('❯ 1  fix the fade at the top')
    expect(list).not.toContain('reply row 0')
  })

  it('cuts a listed prompt the width cannot hold, keeping its markers', () => {
    const lines = draw({ ...held, column: 'list' }, 60, 20).join('\n')
    expect(lines).toContain('│ ❯ 1  fix the… ✻¶◆1│')
    expect(lines).toContain('Esc closes')
  })

  it('aligns every turn number in the column the widest one needs', () => {
    const blocks = transcript()
    const groups = turnGroups(blocks).map((group, index) => index === 2 ? { ...group, turn: 12 } : group)
    const lines = readerRows({ ...held, column: 'list' }, groups, {
      palette: PLAIN,
      blocks,
      width: 95,
      rows: 40,
      minColumns: READER_MIN_COLUMNS,
      totalTurns: groups.length,
    }).map(stripTerminalSequences).join('\n')
    expect(lines).toContain('│    0  session start  ⬡1│')
    expect(lines).toContain('│ ❯  1  fix the fad… ✻¶◆1│')
    expect(lines).toContain('│   12  run the tests   ¶│')
  })
})

/**
 * A transcript whose second turn shows what the panel restyles: a two-row prompt, a
 * reply with Markdown bullets, a running tool, and a tool that answered with a diff.
 * @returns the navigable blocks, oldest first.
 */
function styled(): SectionSource[] {
  return [
    source('user', [{ kind: 'user', rows: ['patch checkout', 'and keep the tests'] }], { turn: 0 }),
    source('assistant', [{ kind: 'reply', rows: ['- first', '  * nested', '', 'plain - dash'] }], { turn: 1 }),
    source('tool', [{ kind: 'call', rows: ['src/api/checkout.ts', '{"path":"src/api/checkout.ts"}'] }, {
      kind: 'result',
      rows: ['@@ -1 +1 @@', '- old line', '+ new line', '  same'],
    }], { turn: 1, name: 'edit', title: 'src/api/checkout.ts' }),
    source('tool', [{ kind: 'call', rows: ['{"query":"p99"}'] }], { turn: 1, name: 'grep' }),
  ]
}

/** The indent a tool result's header is drawn at. */
const RESULT_INDENT = '  '

describe('the turn panel\'s styling', () => {
  /** A palette that emits its sequences, so a spec can read where each role lands. */
  const COLOR = createPalette(true)

  /** A truecolor ramp from black to a light gray foreground. */
  const TRUECOLOR: FadeStyle = { capability: 'truecolor', ramp: [{ r: 8, g: 8, b: 8 }, { r: 220, g: 220, b: 220 }] }

  /**
   * Draw the styled transcript's turn.
   * @param cursor - the section the reader holds.
   * @param extra - the bands and the reveal.
   * @param palette - the palette the frame is drawn with.
   * @returns the lines.
   */
  function draw(cursor: TranscriptCursor, extra: Pick<ReaderRender, 'tints' | 'reveal'> = {}, palette = PLAIN): string[] {
    const blocks = styled()
    const groups = turnGroups(blocks)
    return readerRows({ cursor, column: 'pane', offset: 0 }, groups, {
      palette,
      blocks,
      width: 95,
      rows: 30,
      minColumns: READER_MIN_COLUMNS,
      totalTurns: groups.length,
      ...extra,
    })
  }

  it('draws a reply as Markdown with its bullets as bullets and drops a call row its header already names', () => {
    const pane = draw({ block: 1, part: 0 }).map(line => panel(stripTerminalSequences(line)))
    expect(pane.slice(1, 18)).toEqual([
      '  ❯ patch checkout',
      '    and keep the tests',
      '',
      '┃ ¶ Reply',
      '┃   • first',
      '┃       • nested',
      '┃',
      '┃   plain - dash',
      '',
      '  ◆ edit src/api/checkout.ts',
      '    {"path":"src/api/checkout.ts"}',
      '',
      '    ⎿ Result',
      '      @@ -1 +1 @@',
      '      - old line',
      '      + new line',
      '        same',
    ])
    // A tool whose result has not landed says it is still running.
    expect(pane[19]).toBe('  ◆ grep · running')
  })

  it('paints a diff\'s rows green and red, on bands the width of the panel', () => {
    const bare = draw({ block: 2, part: 1 }, {}, COLOR)
    expect(bare.find(line => line.includes('+ new line'))).toContain('\u001b[32m+ new line\u001b[39m')
    expect(bare.find(line => line.includes('- old line'))).toContain('\u001b[31m- old line\u001b[39m')
    const tints = readerTints(TRUECOLOR, { r: 0, g: 0, b: 0 })
    expect(tints).toBeDefined()
    const banded = draw({ block: 2, part: 1 }, { tints }, COLOR)
    const added = banded.find(line => line.includes('+ new line'))
    expect(added).toMatch(/\u001b\[48;2;\d+;\d+;\d+m\u001b\[32m\+ new line\u001b\[39m {50}\u001b\[49m \u001b\[\d+m│\u001b\[39m$/)
    expect(banded.find(line => line.includes('- old line'))).toContain('\u001b[48;2;')
    // The prompt band spans the whole panel.
    const prompt = banded.find(line => line.includes('patch checkout'))
    expect(prompt).toMatch(/\u001b\[48;2;\d+;\d+;\d+m.*patch checkout.* {48}\u001b\[49m \u001b\[\d+m│\u001b\[39m$/)
    // Every banded row still fits the frame exactly.
    for (const line of banded) expect(visibleWidth(line)).toBeLessThanOrEqual(95)
  })

  it('draws a reply\'s Markdown and fenced code, a tool\'s code rows, and reasoning in the conversation\'s colors', () => {
    const asked: (string | undefined)[] = []
    const highlight: CodeHighlighter = {
      lines: (code, lang) => {
        asked.push(lang)
        return code.split('\n').map(line => `\u001b[35m${line}\u001b[39m`)
      },
    }
    const blocks = [
      source('user', [{ kind: 'user', rows: ['explain'] }], { turn: 0 }),
      source('assistant', [
        { kind: 'reasoning', rows: ['weighing it'] },
        { kind: 'reply', rows: ['# Plan', 'use **bold** and `code`', '', '1. step', '', '```ts', 'const a = 1', '```'] },
      ], { turn: 1 }),
      source('tool', [
        { kind: 'call', rows: ['a.ts'] },
        { kind: 'result', rows: ['   1│ let b'], code: [{ lang: 'ts', prefix: '   1│ ', source: 'let b' }] },
      ], { turn: 1, name: 'read', title: 'a.ts' }),
    ]
    const groups = turnGroups(blocks)
    const render = (palette: typeof COLOR, withHighlight: boolean): string[] => readerRows({ cursor: { block: 1, part: 1 }, column: 'pane', offset: 0 }, groups, {
      palette,
      blocks,
      width: 95,
      rows: 30,
      minColumns: READER_MIN_COLUMNS,
      totalTurns: groups.length,
      ...withHighlight ? { highlight } : {},
    })
    const lines = render(COLOR, true).join('\n')
    expect(lines).toMatch(/\u001b\[38;5;215m\S*Plan/)
    expect(lines).toContain(COLOR.bold('bold'))
    expect(lines).toContain(COLOR.link('code'))
    expect(lines).toContain('\u001b[35mconst a = 1\u001b[39m')
    expect(lines).toContain('   1│ \u001b[35mlet b\u001b[39m')
    expect(lines).toContain(COLOR.dim(COLOR.italic('weighing it')))
    // An ordered list keeps its numbers; only an unordered marker becomes `•`.
    expect(lines).toContain(`${COLOR.heading('1. ')}step`)
    expect(asked).toEqual(['ts', 'ts'])
    // Colour never moves a row: the plain drawing has the same text in every row.
    expect(render(COLOR, true).map(stripTerminalSequences)).toEqual(render(PLAIN, false))
  })

  it('accents the section the reader holds and draws the rest the way the conversation does', () => {
    const lines = draw({ block: 2, part: 1 }, {}, COLOR).join('\n')
    expect(lines).toContain(`${COLOR.accent('┃ ')}${RESULT_INDENT}${COLOR.bold(COLOR.accent('⎿ Result'))}`)
    // A call's glyph takes its status color: green once answered, yellow while it runs.
    expect(lines).toContain(`${COLOR.success('◆')} ${COLOR.bold('edit')}${COLOR.link(' src/api/checkout.ts')}`)
    expect(lines).toContain(`${COLOR.warning('◆')} ${COLOR.bold('grep')}${COLOR.link(' · running')}`)
    expect(lines).toContain(`${COLOR.accent('¶')} Reply`)
    expect(lines).toContain(`${COLOR.accent('❯')} ${COLOR.bold('patch checkout')}`)
    const prompt = draw({ block: 0, part: 0 }, {}, COLOR).join('\n')
    expect(prompt).toContain(`${COLOR.bold(COLOR.accent('❯'))} ${COLOR.bold('patch checkout')}`)
    expect(draw({ block: 0, part: 0 }, {}, COLOR).join('\n')).toContain(COLOR.dim('⎿ Result'))
  })

  it('floats out the whole turn, or only the section a step landed on, without moving a row', () => {
    const settled = draw({ block: 2, part: 1 }, {}, COLOR)
    const whole = draw({ block: 2, part: 1 }, { reveal: { age: 0, style: TRUECOLOR } }, COLOR)
    const section = draw({ block: 2, part: 1 }, { reveal: { age: 0, style: TRUECOLOR, section: { block: 2, part: 1 } } }, COLOR)
    expect(whole).toHaveLength(settled.length)
    expect(whole.map(stripTerminalSequences)).toEqual(settled.map(stripTerminalSequences))
    const changed = (lines: readonly string[]): string[] =>
      lines.filter((line, index) => line !== settled[index]).map(stripTerminalSequences)
    expect(changed(whole).some(line => line.includes('patch checkout'))).toBe(true)
    expect(changed(whole).some(line => line.includes('clean') || line.includes('+ new line'))).toBe(true)
    // A section reveal leaves every other section's rows byte for byte.
    const moved = changed(section)
    expect(moved.some(line => line.includes('+ new line'))).toBe(true)
    expect(moved.some(line => line.includes('patch checkout') || line.includes('• first'))).toBe(false)
    // At the end of the ramp the reveal draws exactly the settled turn.
    expect(draw({ block: 2, part: 1 }, { reveal: { age: 2, style: TRUECOLOR } }, COLOR)).toEqual(settled)
  })
})

describe('readerTints', () => {
  const background = { r: 16, g: 16, b: 16 }
  const ramp = [{ r: 30, g: 30, b: 30 }, { r: 220, g: 220, b: 220 }]

  it('mixes the bands from the background under a color capability', () => {
    const truecolor = readerTints({ capability: 'truecolor', ramp }, background)
    expect(truecolor?.prompt('x')).toMatch(/^\u001b\[48;2;\d+;\d+;\d+mx\u001b\[49m$/)
    const indexed = readerTints({ capability: 'ansi256', ramp }, background)
    expect(indexed?.added('x')).toMatch(/^\u001b\[48;5;\d+mx\u001b\[49m$/)
    expect(indexed?.removed('x')).toMatch(/^\u001b\[48;5;\d+mx\u001b\[49m$/)
  })

  it('draws no band where no color can be mixed', () => {
    expect(readerTints({ capability: 'dim', ramp }, background)).toBeUndefined()
    expect(readerTints({ capability: 'none', ramp: [] }, background)).toBeUndefined()
    expect(readerTints({ capability: 'truecolor', ramp }, undefined)).toBeUndefined()
    expect(readerTints({ capability: 'truecolor', ramp: [] }, background)).toBeUndefined()
  })
})
