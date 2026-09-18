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

/** A pane with nothing in it, for the geometry tests that measure no rows. */
const NO_PANE = { headers: [], total: 0 }

/**
 * The reader over a scripted transcript.
 * @param cursor - the section the reader holds.
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

  it('gives the rail a share of the terminal between its two bounds', () => {
    expect(readerGeometry(95, 40, state, 80, NO_PANE)).toMatchObject({ rail: 26, panes: [65], body: 37, tiny: false })
    // The share is clamped at both ends: 18 columns at 60, 30 at 200.
    expect(readerGeometry(60, 40, state, 80, NO_PANE).rail).toBe(18)
    expect(readerGeometry(200, 40, state, 80, NO_PANE).rail).toBe(30)
  })

  it('splits the body in two once a section is pinned and the width holds it', () => {
    const pinned: ReaderState = { ...state, pinned: { block: 1, part: 0 } }
    expect(readerGeometry(95, 40, pinned, 80, NO_PANE)).toMatchObject({ rail: 26, panes: [31, 31], refusal: '' })
  })

  it('refuses compare below the configured width and keeps one pane', () => {
    const pinned: ReaderState = { ...state, pinned: { block: 1, part: 0 } }
    expect(readerGeometry(72, 40, pinned, 80, NO_PANE)).toMatchObject({ rail: 20, panes: [48], refusal: 'compare needs 80 columns' })
  })

  it('drops the rail rather than the second pane when both cannot fit', () => {
    const pinned: ReaderState = { ...state, pinned: { block: 1, part: 0 } }
    expect(readerGeometry(80, 40, pinned, 60, NO_PANE)).toMatchObject({ rail: 22, panes: [26, 26] })
    // 72 columns leave the rail and two panes 23 each, which is below the
    // width a pane is worth drawing at, so the rail goes instead.
    expect(readerGeometry(72, 40, pinned, 60, NO_PANE)).toMatchObject({ rail: 0, panes: [34, 34], refusal: '' })
  })

  it('draws one column at a time below sixty columns', () => {
    expect(readerGeometry(59, 20, state, 80, NO_PANE)).toMatchObject({ rail: 0, panes: [57] })
    expect(readerGeometry(59, 20, { ...state, column: 'rail' }, 80, NO_PANE)).toMatchObject({ rail: 57, panes: [] })
    // The query line narrows the rail, so it is the rail that stays drawn.
    expect(readerGeometry(59, 20, { ...state, column: 'filter' }, 80, NO_PANE)).toMatchObject({ rail: 57, panes: [] })
  })

  it('reports a pin a single column cannot draw beside the walk', () => {
    const pinned: ReaderState = { ...state, pinned: { block: 1, part: 0 } }
    expect(readerGeometry(50, 20, pinned, 80, NO_PANE)).toMatchObject({ rail: 0, panes: [48], refusal: 'compare needs 80 columns' })
    expect(readerGeometry(50, 20, { ...pinned, column: 'rail' }, 80, NO_PANE)).toMatchObject({ rail: 48, panes: [], refusal: 'compare needs 80 columns' })
    // Compare also needs a body that splits at all, so the narrowest reader
    // that could hold two panes is what a lower setting is answered with.
    expect(readerGeometry(50, 20, pinned, 40, NO_PANE).refusal).toBe('compare needs 60 columns')
    expect(readerGeometry(50, 20, state, 40, NO_PANE).refusal).toBe('')
  })

  it('refuses a terminal the frame does not fit in', () => {
    expect(readerGeometry(20, 40, state, 80, NO_PANE).tiny).toBe(true)
    expect(readerGeometry(95, 6, state, 80, NO_PANE).tiny).toBe(true)
  })
})

describe('measurePane', () => {
  it('reports where each section starts and how many rows the pane has', () => {
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

describe('reduceReader over the turn rail', () => {
  it('steps one turn either way and stops at both ends', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 }, { column: 'rail' })
    const back = reduceReader(state, { kind: 'turn', to: 'previous' }, groups, geometry)
    expect(back.cursor).toEqual({ block: 0, part: 0 })
    expect(reduceReader(back, { kind: 'turn', to: 'previous' }, groups, geometry).cursor).toEqual({ block: 0, part: 0 })
    const on = reduceReader(state, { kind: 'turn', to: 'next' }, groups, geometry)
    expect(on.cursor).toEqual({ block: 4, part: 0 })
    expect(reduceReader(on, { kind: 'turn', to: 'next' }, groups, geometry).cursor).toEqual({ block: 4, part: 0 })
  })

  it('reaches either end of the rail in one press', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 }, { column: 'rail' })
    expect(reduceReader(state, { kind: 'turn', to: 'first' }, groups, geometry).cursor).toEqual({ block: 0, part: 0 })
    expect(reduceReader(state, { kind: 'turn', to: 'last' }, groups, geometry).cursor).toEqual({ block: 4, part: 0 })
  })

  it('pages the rail by a bodyful of turns', () => {
    const { groups, state, geometry } = reader({ block: 0, part: 0 }, { column: 'rail' })
    expect(reduceReader(state, { kind: 'page', step: 1 }, groups, geometry).cursor).toEqual({ block: 4, part: 0 })
    expect(reduceReader(state, { kind: 'page', step: -1 }, groups, geometry).cursor).toEqual({ block: 0, part: 0 })
  })

  it('enters the sections on the turn\'s first one and returns to the rail', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 }, { column: 'rail' })
    const opened = reduceReader(state, { kind: 'column', to: 'pane' }, groups, geometry)
    expect(opened).toMatchObject({ column: 'pane', cursor: { block: 1, part: 0 }, offset: 0 })
    expect(reduceReader(opened, { kind: 'column', to: 'rail' }, groups, geometry).column).toBe('rail')
  })

  it('holds a turn whose section the walk no longer names', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 9 }, { column: 'rail' })
    // The block is still listed, so the turn is found and the walk resumes
    // from the turn's own first section.
    expect(reduceReader(state, { kind: 'section', to: 'next' }, groups, geometry).cursor).toEqual({ block: 2, part: 0 })
  })

  it('scrolls to nothing while no pane is drawn to scroll', () => {
    const blocks = transcript()
    const groups = turnGroups(blocks)
    const state: ReaderState = { cursor: { block: 2, part: 1 }, column: 'rail', offset: 4 }
    // A narrow terminal draws the rail alone, so the pane has no rows at all.
    const geometry = readerGeometryFor(state, groups, blocks, 50, 20, READER_MIN_COLUMNS)
    expect(reduceReader(state, { kind: 'section-at', index: 1 }, groups, geometry).offset).toBe(0)
    expect(reduceReader(state, { kind: 'anchor' }, groups, geometry).offset).toBe(0)
  })

  it('leaves every movement alone on a transcript with no listed turn', () => {
    const { state, geometry } = reader({ block: 2, part: 1 }, { column: 'rail' })
    for (const intent of [
      { kind: 'turn', to: 'next' },
      { kind: 'section', to: 'next' },
      { kind: 'section-at', index: 1 },
      { kind: 'column', to: 'pane' },
      { kind: 'page', step: 1 },
      { kind: 'anchor' },
    ] as const) {
      expect(reduceReader(state, intent, [], geometry)).toBe(state)
    }
  })
})

describe('reduceReader over the sections', () => {
  it('steps one section either way, stopping at the turn\'s ends', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 0 })
    const on = reduceReader(state, { kind: 'section', to: 'next' }, groups, geometry)
    expect(on.cursor).toEqual({ block: 2, part: 1 })
    const back = reduceReader(state, { kind: 'section', to: 'previous' }, groups, geometry)
    expect(back.cursor).toEqual({ block: 1, part: 0 })
    expect(reduceReader(back, { kind: 'section', to: 'previous' }, groups, geometry).cursor).toEqual({ block: 1, part: 0 })
    expect(reduceReader(state, { kind: 'section', to: 'last' }, groups, geometry).cursor).toEqual({ block: 3, part: 1 })
    expect(reduceReader(state, { kind: 'section', to: 'first' }, groups, geometry).cursor).toEqual({ block: 1, part: 0 })
  })

  it('scrolls a section that starts below the window into view', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 })
    const result = reduceReader(state, { kind: 'section', to: 'last' }, groups, geometry)
    // The reply is 40 rows, so the tool's result starts well past one body.
    expect(result.offset).toBeGreaterThan(0)
    expect(result.offset).toBeLessThanOrEqual(geometry.pane.total - geometry.body)
  })

  it('picks a section of the turn by position and clamps a number past its end', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 0 })
    expect(reduceReader(state, { kind: 'section-at', index: 2 }, groups, geometry).cursor).toEqual({ block: 2, part: 1 })
    expect(reduceReader(state, { kind: 'section-at', index: 8 }, groups, geometry).cursor).toEqual({ block: 3, part: 1 })
  })

  it('scrolls one row and stops at both ends', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 })
    expect(reduceReader(state, { kind: 'scroll', step: -1 }, groups, geometry).offset).toBe(0)
    const down = reduceReader(state, { kind: 'scroll', step: 1 }, groups, geometry)
    expect(down.offset).toBe(1)
    const end = { ...state, offset: geometry.pane.total }
    expect(reduceReader(end, { kind: 'scroll', step: 1 }, groups, geometry).offset).toBe(geometry.pane.total - geometry.body)
  })

  it('pages the sections with one row of overlap', () => {
    const blocks = transcript()
    const groups = turnGroups(blocks)
    const state: ReaderState = { cursor: { block: 2, part: 1 }, column: 'pane', offset: 0 }
    const geometry = readerGeometryFor(state, groups, blocks, 95, 12, READER_MIN_COLUMNS)
    const page = reduceReader(state, { kind: 'page', step: 1 }, groups, geometry)
    expect(page.offset).toBe(geometry.body - 1)
    expect(reduceReader(page, { kind: 'page', step: -1 }, groups, geometry).offset).toBe(0)
    // The last page stops at the pane's own end rather than past it.
    const far = reduceReader({ ...state, offset: geometry.pane.total }, { kind: 'page', step: 1 }, groups, geometry)
    expect(far.offset).toBe(geometry.pane.total - geometry.body)
  })

  it('pins the held section beside the walk and unpins the same one', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 })
    const pinned = reduceReader(state, { kind: 'pin' }, groups, geometry)
    expect(pinned.pinned).toEqual({ block: 2, part: 1 })
    const moved = reduceReader(pinned, { kind: 'section', to: 'next' }, groups, geometry)
    // Another section pins in place of the first one; the same section unpins.
    expect(reduceReader(moved, { kind: 'pin' }, groups, geometry).pinned).toEqual({ block: 3, part: 0 })
    expect(reduceReader(pinned, { kind: 'pin' }, groups, geometry).pinned).toBeUndefined()
  })

  it('re-anchors on the held section after the geometry changed, and leaves a visible one alone', () => {
    const blocks = transcript()
    const groups = turnGroups(blocks)
    const state: ReaderState = { cursor: { block: 2, part: 1 }, column: 'pane', offset: 0 }
    const wide = readerGeometryFor(state, groups, blocks, 95, 40, READER_MIN_COLUMNS)
    expect(reduceReader(state, { kind: 'anchor' }, groups, wide).offset).toBe(0)
    const scrolled = { ...state, offset: 30 }
    const narrow = readerGeometryFor(scrolled, groups, blocks, 95, 12, READER_MIN_COLUMNS)
    // The reply's header is above the window now, so the reader comes back to it.
    expect(reduceReader(scrolled, { kind: 'anchor' }, groups, narrow).offset).toBe(4)
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
    expect(reduceReader(typed, { kind: 'commit' }, groups, geometry)).toMatchObject({ column: 'rail', query: 'tests' })
  })

  it('erases and extends a query line that was never typed into', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 })
    expect(reduceReader(state, { kind: 'erase', all: false }, groups, geometry).query).toBe('')
    expect(reduceReader(state, { kind: 'query', text: 'a' }, groups, geometry).query).toBe('a')
  })

  it('walks the Escape chain: query, then query line, then the pin', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 })
    const typed = reduceReader(reduceReader(state, { kind: 'filter' }, groups, geometry), { kind: 'query', text: 'tests' }, groups, geometry)
    expect(readerClosesOnEscape(typed, geometry)).toBe(false)
    const cleared = reduceReader(typed, { kind: 'escape' }, groups, geometry)
    expect(cleared).toMatchObject({ column: 'filter', query: '' })
    const closed = reduceReader(cleared, { kind: 'escape' }, groups, geometry)
    expect(closed).toMatchObject({ column: 'rail' })
    expect(closed.query).toBeUndefined()
    expect(readerClosesOnEscape(closed, geometry)).toBe(true)

    const pinned = reduceReader(state, { kind: 'pin' }, groups, geometry)
    expect(readerClosesOnEscape(pinned, geometry)).toBe(false)
    expect(reduceReader(pinned, { kind: 'escape' }, groups, geometry).pinned).toBeUndefined()
  })

  it('steps the sections back to the rail before closing on a terminal that draws one column', () => {
    const { blocks, groups, state } = reader({ block: 2, part: 1 })
    const narrow = readerGeometryFor(state, groups, blocks, 50, 20, READER_MIN_COLUMNS)
    // The rail is not drawn beside the sections there, so it is the step the
    // chain still has before the reader closes.
    expect(readerClosesOnEscape(state, narrow)).toBe(false)
    const railed = reduceReader(state, { kind: 'escape' }, groups, narrow)
    expect(railed.column).toBe('rail')
    expect(readerClosesOnEscape(railed, readerGeometryFor(railed, groups, blocks, 50, 20, READER_MIN_COLUMNS))).toBe(true)
  })

  it('keeps the query while the query line closes and reopens', () => {
    const { groups, state, geometry } = reader({ block: 2, part: 1 }, { query: 'tests' })
    expect(reduceReader(state, { kind: 'filter' }, groups, geometry).query).toBe('tests')
    // A pin leaves the query alone, and a query leaves the pin alone.
    const both = reduceReader({ ...state, pinned: { block: 1, part: 0 } }, { kind: 'filter' }, groups, geometry)
    expect(both).toMatchObject({ query: 'tests', pinned: { block: 1, part: 0 } })
    const cleared = reduceReader(both, { kind: 'escape' }, groups, geometry)
    expect(cleared.query).toBe('')
    // Closing the query line keeps the pin, and unpinning keeps the query.
    const closed = reduceReader(cleared, { kind: 'escape' }, groups, geometry)
    expect(closed).toMatchObject({ column: 'rail', pinned: { block: 1, part: 0 } })
    expect(closed.query).toBeUndefined()
    const unpinned = reduceReader({ ...state, pinned: { block: 1, part: 0 }, query: 'tests' }, { kind: 'escape' }, groups, geometry)
    expect(unpinned.pinned).toBeUndefined()
    expect(unpinned.query).toBe('tests')
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
   * @param query - a query narrowing the rail.
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

  const held: ReaderState = { cursor: { block: 2, part: 1 }, column: 'pane', offset: 0 }

  it('fills exactly the rows it was given at every size', () => {
    for (const [width, rows] of [[95, 40], [80, 24], [59, 20], [40, 12], [20, 6]] as const) {
      const lines = draw(held, width, rows)
      expect(lines).toHaveLength(rows)
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  it('names the mode, the turn, the position, and the keys', () => {
    const lines = draw(held, 95, 40).join('\n')
    expect(lines).toContain(' ● READER ')
    // The rule states where the walk is in the rail, which is what the
    // readout under it states too: the blocks before the first prompt are a
    // row of the rail, so a turn's own number sits one behind its position.
    expect(lines).toContain('turn 2 of 3')
    expect(lines).toContain('3/6')
    expect(lines).toContain('▸ 1  [fix the fade a…]')
    expect(lines).toContain('⬡1')
    expect(lines).toContain('✻¶⚒1')
    expect(lines).toContain('── ¶ reply · turn 1 ')
    expect(lines).toContain('▌reply row 0')
    expect(lines).toContain('↑↓ sections · Enter pins · Esc back')
    expect(lines).toContain('turn 2/3 · section 3/5 · row 1/49')
  })

  it('marks every kind of section with its own glyph', () => {
    const lines = draw({ ...held, cursor: { block: 0, part: 0 } }, 95, 40).join('\n')
    expect(lines).toContain('── ⬡ system prompt · turn 0 ')
    const turn = draw({ ...held, cursor: { block: 2, part: 0 } }, 95, 40).join('\n')
    expect(turn).toContain('── you · turn 0 ')
    expect(turn).toContain('── ✻ reasoning · turn 1 ')
    // The tool's own sections sit past the reply, which the walk scrolls to.
    const tool = draw({ ...held, cursor: { block: 3, part: 1 }, offset: 45 }, 95, 40).join('\n')
    expect(tool).toContain('── ⚒ bash git status · call · turn 1 ')
    expect(tool).toContain('── ⚒ bash git status · result · turn 1 ')
  })

  it('names the rail\'s own keys while the rail holds the keyboard', () => {
    expect(draw({ ...held, column: 'rail' }, 140, 40).join('\n'))
      .toContain('↑↓ turns · → sections · Enter opens · / filters · Esc closes')
    // The readout is reserved first, so a narrower rule drops legend words
    // rather than the position.
    const narrow = draw({ ...held, column: 'rail' }, 95, 40).join('\n')
    expect(narrow).toContain('↑↓ turns · → sections · Esc closes')
    expect(narrow).toContain('turn 2/3 · section 3/5 · row 1/49')
  })

  it('draws the pinned section beside the walking one', () => {
    const lines = draw({ ...held, pinned: { block: 5, part: 0 } }, 95, 40).join('\n')
    expect(lines).toContain('all green')
    expect(lines).toContain('▌reply row 0')
  })

  it('says how many columns compare would need on a terminal that cannot split', () => {
    const lines = draw({ ...held, pinned: { block: 5, part: 0 } }, 72, 24).join('\n')
    expect(lines).toContain('compare needs 80 columns')
    expect(lines).not.toContain('all green')
  })

  it('shows the query line and how much of the transcript it kept', () => {
    const lines = draw({ ...held, column: 'filter', query: 'green' }, 95, 40, 'green').join('\n')
    expect(lines).toContain('/ green')
    expect(lines).toContain('1/3 turns')
    expect(lines).toContain('▸ 2  [run the tests]')
  })

  it('says so when no turn matches', () => {
    const lines = draw({ ...held, column: 'rail', query: 'zzzz' }, 95, 40, 'zzzz').join('\n')
    expect(lines).toContain('no turn matches "zzzz"')
    // A rail listing no turn holds the walk at no position in it.
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
    expect(empty).toContain('turn 0/0 · section 0/0 · row 0/0')
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

  it('draws the sections alone on a narrow terminal, and the rail alone the other way', () => {
    expect(draw(held, 59, 20).join('\n')).toContain('▌reply row 0')
    const rail = draw({ ...held, column: 'rail' }, 59, 20).join('\n')
    expect(rail).toContain('▸ 1  [fix the fade at the top]')
    expect(rail).not.toContain('reply row 0')
  })

  it('cuts a rail row the width cannot hold, keeping both brackets and its markers', () => {
    const lines = draw({ ...held, column: 'rail' }, 60, 20).join('\n')
    expect(lines).toContain('✻¶⚒1')
    expect(lines).toContain('▸ 1  [fix th…]')
    expect(lines).toContain('Esc closes')
  })
})
