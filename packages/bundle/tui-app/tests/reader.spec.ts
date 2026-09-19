/** The reader as plain data: how it splits a terminal, what one key moves, and the lines it draws. */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { turnGroups, type SectionSource, type TranscriptCursor } from '../src/navigation.ts'
import {
  READER_MIN_COLUMNS,
  TOO_SMALL,
  filterTurns,
  measurePane,
  readerClosesOnEscape,
  readerGeometry,
  readerGeometryFor,
  readerRows,
  reduceReader,
  type ReaderState,
} from '../src/reader.ts'
import { GONE, transcript } from './section-source.ts'
import { createPalette } from '../src/style.ts'

/** A palette that returns its text unchanged, so a spec reads the drawn columns. */
const PLAIN = createPalette(false)

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
    expect(readerGeometry(95, 40, state, 60)).toMatchObject({ list: 26, pane: 65, body: 37, tiny: false })
    // The share is clamped at both ends: 18 columns at 60, 30 at 200.
    expect(readerGeometry(60, 40, state, 60)).toMatchObject({ list: 18, pane: 38 })
    expect(readerGeometry(200, 40, state, 60)).toMatchObject({ list: 30, pane: 166 })
  })

  it('draws one panel at a time below the configured width', () => {
    expect(readerGeometry(59, 20, state, 60)).toMatchObject({ list: 0, pane: 57 })
    expect(readerGeometry(59, 20, { ...state, column: 'list' }, 60)).toMatchObject({ list: 57, pane: 0 })
    // The query line narrows the list, so it is the list that stays drawn.
    expect(readerGeometry(59, 20, { ...state, column: 'filter' }, 60)).toMatchObject({ list: 57, pane: 0 })
    // A wider setting keeps one panel on a terminal two would cramp.
    expect(readerGeometry(95, 40, state, 120)).toMatchObject({ list: 0, pane: 93 })
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
    // The prompt, the reasoning, the reply, and the tool's two sections, each
    // under one header row.
    expect(measurePane(group!, blocks, 60)).toEqual({ headers: [0, 2, 4, 45, 47], total: 49 })
  })

  it('reports nothing for a section the transcript no longer carries', () => {
    expect(measurePane(GONE, transcript(), 60)).toEqual({ headers: [0], total: 1 })
  })
})

describe('reduceReader over the turn list', () => {
  it('steps one turn either way and stops at both ends', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 }, { column: 'list' })
    const back = reduceReader(state, { kind: 'turn', to: 'previous' }, groups, geometry)
    expect(back.cursor).toEqual({ block: 0, part: 0 })
    expect(reduceReader(back, { kind: 'turn', to: 'previous' }, groups, geometry).cursor).toEqual({ block: 0, part: 0 })
    const on = reduceReader(state, { kind: 'turn', to: 'next' }, groups, geometry)
    expect(on.cursor).toEqual({ block: 4, part: 0 })
    expect(reduceReader(on, { kind: 'turn', to: 'next' }, groups, geometry).cursor).toEqual({ block: 4, part: 0 })
  })

  it('reaches either end of the list in one press', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 }, { column: 'list' })
    expect(reduceReader(state, { kind: 'turn', to: 'first' }, groups, geometry).cursor).toEqual({ block: 0, part: 0 })
    expect(reduceReader(state, { kind: 'turn', to: 'last' }, groups, geometry).cursor).toEqual({ block: 4, part: 0 })
  })

  it('opens each turn at its first section, whatever of it was read before', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 }, { column: 'list', offset: 30 })
    expect(reduceReader(state, { kind: 'turn', to: 'first' }, groups, geometry)).toMatchObject({
      cursor: { block: 0, part: 0 },
      offset: 0,
    })
  })

  it('pages the list by a bodyful of turns', () => {
    const { groups, state, geometry } = reader({ block: 0, part: 0 }, { column: 'list' })
    expect(reduceReader(state, { kind: 'page', step: 1 }, groups, geometry).cursor).toEqual({ block: 4, part: 0 })
    expect(reduceReader(state, { kind: 'page', step: -1 }, groups, geometry).cursor).toEqual({ block: 0, part: 0 })
  })

  it('hands the keyboard to the turn beside it and takes it back', () => {
    const { groups, state, geometry } = reader({ block: 1, part: 0 }, { column: 'list' })
    const opened = reduceReader(state, { kind: 'column', to: 'pane' }, groups, geometry)
    // The turn the list holds is what the panel was already showing, so the
    // keyboard moves and nothing else does.
    expect(opened).toMatchObject({ column: 'pane', cursor: { block: 1, part: 0 }, offset: 0 })
    expect(reduceReader(opened, { kind: 'column', to: 'list' }, groups, geometry).column).toBe('list')
  })

  it('leaves the reading where it is on a transcript with no listed turn', () => {
    const { state, geometry } = reader({ block: 2, part: 1 }, { column: 'list' })
    for (const intent of [
      { kind: 'turn', to: 'next' },
      { kind: 'page', step: 1 },
      { kind: 'anchor' },
    ] as const) {
      expect(reduceReader(state, intent, [], geometry)).toBe(state)
    }
    expect(reduceReader(state, { kind: 'scroll', to: 'next' }, [], geometry).cursor).toEqual({ block: 2, part: 1 })
  })
})

describe('reduceReader over the turn panel', () => {
  it('scrolls one row and stops at both ends', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 })
    expect(reduceReader(state, { kind: 'scroll', to: 'previous' }, groups, geometry).offset).toBe(0)
    expect(reduceReader(state, { kind: 'scroll', to: 'next' }, groups, geometry).offset).toBe(1)
    const end = reduceReader(state, { kind: 'scroll', to: 'last' }, groups, geometry)
    expect(end.offset).toBe(geometry.measure.total - geometry.body)
    expect(reduceReader(end, { kind: 'scroll', to: 'next' }, groups, geometry).offset).toBe(end.offset)
    expect(reduceReader(end, { kind: 'scroll', to: 'first' }, groups, geometry).offset).toBe(0)
  })

  it('reads the cursor off the row the scroll landed on', () => {
    const { groups, state, geometry } = reader({ block: 1, part: 0 })
    // The turn opens on its prompt, with the reasoning two rows down and the
    // reply four: the section under the top row is where the transcript
    // resumes, so the reading itself moves it.
    expect(reduceReader(state, { kind: 'scroll', to: 'next' }, groups, geometry).cursor).toEqual({ block: 1, part: 0 })
    expect(reduceReader({ ...state, offset: 1 }, { kind: 'scroll', to: 'next' }, groups, geometry).cursor).toEqual({ block: 2, part: 0 })
    const reply = reduceReader({ ...state, offset: 3 }, { kind: 'scroll', to: 'next' }, groups, geometry)
    expect(reply.cursor).toEqual({ block: 2, part: 1 })
    expect(reduceReader(reply, { kind: 'scroll', to: 'first' }, groups, geometry).cursor).toEqual({ block: 1, part: 0 })
    // The reply is the turn's longest section, so its last page starts in it.
    expect(reduceReader(reply, { kind: 'scroll', to: 'last' }, groups, geometry).cursor).toEqual({ block: 2, part: 1 })
  })

  it('pages the turn with one row of overlap', () => {
    const blocks = transcript()
    const groups = turnGroups(blocks)
    const state: ReaderState = { cursor: { block: 2, part: 1 }, column: 'pane', offset: 0 }
    const geometry = readerGeometryFor(state, groups, blocks, 95, 12, READER_MIN_COLUMNS)
    const page = reduceReader(state, { kind: 'page', step: 1 }, groups, geometry)
    expect(page.offset).toBe(geometry.body - 1)
    expect(reduceReader(page, { kind: 'page', step: -1 }, groups, geometry).offset).toBe(0)
    // The last page stops at the panel's own end rather than past it.
    const far = reduceReader({ ...state, offset: geometry.measure.total }, { kind: 'page', step: 1 }, groups, geometry)
    expect(far.offset).toBe(geometry.measure.total - geometry.body)
  })

  it('re-anchors on the turn\'s first section when the one it read is gone', () => {
    const { groups, geometry } = reader({ block: 2, part: 1 })
    // The block is still listed, so its turn is found and the reading comes
    // back to the top of it.
    const state: ReaderState = { cursor: { block: 2, part: 9 }, column: 'pane', offset: 30 }
    expect(reduceReader(state, { kind: 'anchor' }, groups, geometry).offset).toBe(0)
  })

  it('re-anchors on the section being read after the panel was rewrapped', () => {
    const blocks = transcript()
    const groups = turnGroups(blocks)
    const state: ReaderState = { cursor: { block: 2, part: 1 }, column: 'pane', offset: 0 }
    const wide = readerGeometryFor(state, groups, blocks, 95, 40, READER_MIN_COLUMNS)
    // The reply is the turn's third section, which starts four rows down.
    expect(reduceReader(state, { kind: 'anchor' }, groups, wide).offset).toBe(4)
    // A terminal with no panel at all has no row to anchor on.
    const narrow = readerGeometryFor({ ...state, column: 'list' }, groups, blocks, 50, 20, READER_MIN_COLUMNS)
    expect(reduceReader(state, { kind: 'anchor' }, groups, narrow).offset).toBe(0)
  })
})

describe('reduceReader over the query line', () => {
  it('opens, extends, erases, and commits the query', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 })
    const open = reduceReader(state, { kind: 'filter' }, groups, geometry)
    expect(open).toMatchObject({ column: 'filter', query: '' })
    const typed = reduceReader(reduceReader(open, { kind: 'query', text: 'te' }, groups, geometry), { kind: 'query', text: 'sts' }, groups, geometry)
    expect(typed.query).toBe('tests')
    expect(reduceReader(typed, { kind: 'erase', all: false }, groups, geometry).query).toBe('test')
    expect(reduceReader(typed, { kind: 'erase', all: true }, groups, geometry).query).toBe('')
    expect(reduceReader(typed, { kind: 'commit' }, groups, geometry)).toMatchObject({ column: 'list', query: 'tests' })
  })

  it('erases and extends a query line that was never typed into', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 })
    expect(reduceReader(state, { kind: 'erase', all: false }, groups, geometry).query).toBe('')
    expect(reduceReader(state, { kind: 'query', text: 'a' }, groups, geometry).query).toBe('a')
  })

  it('walks the Escape chain: the query, then the query line, then the reader itself', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 })
    const typed = reduceReader(reduceReader(state, { kind: 'filter' }, groups, geometry), { kind: 'query', text: 'tests' }, groups, geometry)
    expect(readerClosesOnEscape(typed)).toBe(false)
    const cleared = reduceReader(typed, { kind: 'escape' }, groups, geometry)
    expect(cleared).toMatchObject({ column: 'filter', query: '' })
    const closed = reduceReader(cleared, { kind: 'escape' }, groups, geometry)
    expect(closed).toMatchObject({ column: 'list' })
    expect(closed.query).toBeUndefined()
    // Both panels answer the key the same way: it leaves the reader.
    expect(readerClosesOnEscape(closed)).toBe(true)
    expect(readerClosesOnEscape(state)).toBe(true)
  })

  it('keeps the query while the query line closes and reopens', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 }, { query: 'tests' })
    expect(reduceReader(state, { kind: 'filter' }, groups, geometry).query).toBe('tests')
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

  const held: ReaderState = { cursor: { block: 2, part: 1 }, column: 'pane', offset: 4 }

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
    expect(lines).toContain('▸ 1  [fix the fade a…]')
    expect(lines).toContain('⬡1')
    expect(lines).toContain('✻¶⚒1')
    expect(lines).toContain('── ¶ reply · turn 1 ')
    expect(lines).toContain('reply row 0')
    expect(lines).toContain('↑↓ scrolls · PgUp PgDn pages · ← turns · Esc closes')
    expect(lines).toContain('turn 2/3 · row 5/49')
  })

  it('marks every kind of section with its own glyph', () => {
    const lines = draw({ ...held, cursor: { block: 0, part: 0 }, offset: 0 }, 95, 40).join('\n')
    expect(lines).toContain('── ⬡ system prompt · turn 0 ')
    const turn = draw({ ...held, cursor: { block: 2, part: 0 }, offset: 0 }, 95, 40).join('\n')
    expect(turn).toContain('── you · turn 0 ')
    expect(turn).toContain('── ✻ reasoning · turn 1 ')
    // The tool's own sections sit past the reply, which the reading scrolls to.
    const tool = draw({ ...held, cursor: { block: 3, part: 1 }, offset: 45 }, 95, 40).join('\n')
    expect(tool).toContain('── ⚒ bash git status · call · turn 1 ')
    expect(tool).toContain('── ⚒ bash git status · result · turn 1 ')
  })

  it('names the list\'s own keys while the list holds the keyboard', () => {
    expect(draw({ ...held, column: 'list' }, 95, 40).join('\n'))
      .toContain('↑↓ turns · → opens · / filters · Esc closes')
    // The readout is reserved first, so a narrower rule drops legend words
    // rather than the position.
    const narrow = draw({ ...held, column: 'list' }, 60, 20).join('\n')
    expect(narrow).toContain('↑↓ turns · → opens · Esc closes')
    expect(narrow).toContain('turn 2/3 · row 5/49')
  })

  it('shows the query line and how much of the transcript it kept', () => {
    const lines = draw({ ...held, column: 'filter', query: 'green' }, 95, 40, 'green').join('\n')
    expect(lines).toContain('/ green')
    expect(lines).toContain('1/3 turns')
    expect(lines).toContain('▸ 2  [run the tests]')
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
    })
    expect(lines).toHaveLength(40)
    expect(lines.join('\n')).toContain('▸ 9  [gone]')
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
    expect(list).toContain('▸ 1  [fix the fade at the top]')
    expect(list).not.toContain('reply row 0')
  })

  it('cuts a listed prompt the width cannot hold, keeping both brackets and its markers', () => {
    const lines = draw({ ...held, column: 'list' }, 60, 20).join('\n')
    expect(lines).toContain('✻¶⚒1')
    expect(lines).toContain('▸ 1  [fix th…]')
    expect(lines).toContain('Esc closes')
  })
})
