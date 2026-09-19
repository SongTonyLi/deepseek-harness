/** The reader as a mounted overlay: what it re-reads per render, what each key means, and how it settles. */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import type { SectionSource } from '../src/navigation.ts'
import { READER_MIN_COLUMNS } from '../src/reader.ts'
import { ReaderPane, type ReaderExit } from '../src/reader-overlay.ts'
import { KEY } from './bench.ts'
import { source, transcript } from './section-source.ts'
import { createPalette } from '../src/style.ts'

/** A palette that returns its text unchanged, so a spec reads the drawn columns. */
const PLAIN = createPalette(false)

/**
 * A mounted reader over a transcript a spec can grow under it.
 * @param options - the section to open on and the terminal size.
 * @returns the pane, the blocks it reads, and helpers to draw and type.
 */
function mounted(options: { block?: number; part?: number; rows?: number; width?: number } = {}): {
  pane: ReaderPane
  blocks: SectionSource[]
  exit: Promise<ReaderExit>
  draw(): string
  type(data: string): string
} {
  const blocks = transcript()
  const rows = options.rows ?? 40
  const width = options.width ?? 95
  const pane = new ReaderPane({
    palette: PLAIN,
    blocks: () => blocks,
    rows: () => rows,
    minColumns: READER_MIN_COLUMNS,
    cursor: { block: options.block ?? 2, part: options.part ?? 1 },
  })
  const draw = (): string => pane.render(width).map(stripTerminalSequences).join('\n')
  // The overlay renders before the first key reaches it, as pi-tui does.
  draw()
  return {
    pane,
    blocks,
    exit: pane.settled,
    draw,
    type(data: string): string {
      pane.handleInput(data)
      return draw()
    },
  }
}

describe('the reader pane', () => {
  it('re-reads the transcript on every render, so a section that lands shows up', () => {
    const test = mounted()
    expect(test.draw()).not.toContain('landed after opening')
    test.blocks.push(source('assistant', [{ kind: 'reply', rows: ['landed after opening'] }], { turn: 3 }))
    // The reply joined the newest turn, which the list renumbers at once.
    expect(test.draw()).toContain('3  run the tests')
    test.pane.handleInput(KEY.left)
    test.pane.handleInput(KEY.end)
    expect(test.type(KEY.right)).toContain('landed after opening')
  })

  it('walks every turn\'s sections in the list and opens the turn beside it', () => {
    const test = mounted()
    // The list opens on the section the reader was reading, with that turn's
    // own sections under it and every other turn still one row each.
    const listed = test.type(KEY.left)
    expect(listed).toContain('↑↓ sections')
    expect(listed).toContain('  1  [fix the fade a…]')
    expect(listed).toContain('▸   ¶ reply')
    // Up and Down walk the sections, crossing into the turn either side.
    expect(test.type(KEY.up)).toContain('▸   ✻ reasoning')
    expect(test.type(KEY.up)).toContain('▸   you')
    const crossed = test.type(KEY.up)
    expect(crossed).toContain('▸   ⬡ system prompt')
    expect(crossed).toContain('  0  [session start]')
    // Page steps a whole turn, and Home and End reach the conversation's ends.
    expect(test.type(KEY.pageDown)).toContain('  1  [fix the fade a…]')
    expect(test.type(KEY.end)).toContain('  2  [run the tests]')
    expect(test.type(KEY.home)).toContain('  0  [session start]')
    // Right opens the turn the list holds; Tab and Enter cross the same way.
    const opened = test.type(KEY.right)
    expect(opened).toContain('── ⬡ system prompt · turn 0 ')
    expect(opened).toContain('↑↓ scrolls')
    expect(test.type(KEY.tab)).toContain('↑↓ sections')
    expect(test.type(KEY.enter)).toContain('↑↓ scrolls')
    expect(test.type(KEY.shiftTab)).toContain('↑↓ sections')
    // A printable key the list claims nothing for leaves it where it was.
    expect(test.type('z')).toContain('↑↓ sections')
  })

  it('scrolls and pages the turn it opened on', () => {
    const test = mounted()
    // The reader opens on the reply, which starts four rows into its turn.
    expect(test.draw()).toContain('row 5/49')
    expect(test.type(KEY.down)).toContain('row 6/49')
    expect(test.type(KEY.up)).toContain('row 5/49')
    // A page stops at the panel's own end, which is twelve rows down here.
    expect(test.type(KEY.pageDown)).toContain('row 13/49')
    expect(test.type(KEY.pageUp)).toContain('row 1/49')
    expect(test.type(KEY.end)).toContain('row 13/49')
    expect(test.type(KEY.home)).toContain('row 1/49')
    // A key the panel claims nothing for leaves it exactly where it was.
    expect(test.type('z')).toContain('row 1/49')
  })

  it('narrows the list with a query and clears it again', () => {
    const test = mounted()
    test.pane.handleInput(KEY.left)
    expect(test.type(KEY.slash)).toContain('/ ')
    expect(test.type('green')).toContain('/ green')
    expect(test.draw()).toContain('1/3 turns')
    expect(test.type(KEY.backspace)).toContain('/ gree')
    expect(test.type(KEY.ctrlU)).toContain('/ ')
    expect(test.type('green')).toContain('/ green')
    // Enter keeps the narrowed list and closes the query line.
    expect(test.type(KEY.enter)).toContain('↑↓ sections')
    expect(test.draw()).toContain('1/3 turns')
    test.pane.handleInput(KEY.slash)
    // A key the query line types nothing for leaves the query alone.
    expect(test.type(KEY.up)).toContain('/ ')
    expect(test.type(KEY.escape)).toContain('/ ')
    expect(test.type(KEY.escape)).toContain('↑↓ sections')
    expect(test.draw()).not.toContain('turns ┤')
  })

  it('closes on Escape from the turn it was reading and from the list', async () => {
    const reading = mounted()
    reading.pane.handleInput(KEY.escape)
    await expect(reading.exit).resolves.toMatchObject({ target: 'transcript' })

    const listed = mounted()
    listed.pane.handleInput(KEY.left)
    listed.pane.handleInput(KEY.escape)
    await expect(listed.exit).resolves.toMatchObject({ target: 'transcript' })
  })

  it('draws one panel at a time on a terminal too narrow for both', () => {
    const test = mounted({ width: 50 })
    expect(test.draw()).toContain('reply row 0')
    // Left gives the keyboard back to the list, which takes the whole body.
    const listed = test.type(KEY.left)
    expect(listed).toContain('  1  [fix the fade at the top]')
    expect(listed).not.toContain('reply row 0')
    expect(test.type(KEY.right)).toContain('reply row 0')
  })

  it('re-anchors on the section being read when the terminal is rewrapped', () => {
    const blocks = transcript()
    let rows = 40
    const pane = new ReaderPane({
      palette: PLAIN,
      blocks: () => blocks,
      rows: () => rows,
      minColumns: READER_MIN_COLUMNS,
      cursor: { block: 3, part: 1 },
    })
    const drawn = pane.render(95).map(stripTerminalSequences).join('\n')
    // The tool result is the turn's last section, far past one body of rows.
    expect(drawn).toContain('clean tree')
    rows = 12
    expect(pane.render(95).map(stripTerminalSequences).join('\n')).toContain('clean tree')
    expect(pane.render(60).map(stripTerminalSequences).join('\n')).toContain('clean tree')
  })

  it('answers only the keys that leave on a terminal it cannot draw in', async () => {
    const test = mounted({ rows: 6, width: 20 })
    expect(test.draw()).toContain('terminal too small')
    // Nothing else moves, and Escape still brings the keyboard back.
    expect(test.type(KEY.down)).toContain('terminal too small')
    test.pane.handleInput(KEY.escape)
    await expect(test.exit).resolves.toMatchObject({ target: 'transcript' })
  })

  it('closes to the input on Ctrl+G and on withdrawal, and settles only once', async () => {
    const test = mounted()
    test.pane.handleInput(KEY.ctrlG)
    test.pane.withdraw()
    await expect(test.exit).resolves.toMatchObject({ target: 'editor' })
    // A key after the settlement changes nothing.
    expect(test.type(KEY.down)).toContain(' ● READER ')

    const withdrawn = mounted()
    withdrawn.pane.withdraw()
    await expect(withdrawn.exit).resolves.toMatchObject({ target: 'editor' })
  })

  it('settles itself when the transcript it was reading is gone', async () => {
    const blocks: SectionSource[] = transcript()
    const pane = new ReaderPane({
      palette: PLAIN,
      blocks: () => blocks,
      rows: () => 40,
      minColumns: READER_MIN_COLUMNS,
      cursor: { block: 2, part: 1 },
    })
    expect(pane.render(95)).toHaveLength(40)
    blocks.length = 0
    expect(pane.render(95)).toEqual(Array.from({ length: 40 }, () => ''))
    await expect(pane.settled).resolves.toMatchObject({ target: 'editor' })
  })

  it('falls back to the newest section when the remembered one carries nothing', () => {
    const blocks = [source('assistant', [], { turn: 1 }), source('user', [{ kind: 'user', rows: ['still here'] }], { turn: 1 })]
    const pane = new ReaderPane({
      palette: PLAIN,
      blocks: () => blocks,
      rows: () => 40,
      minColumns: READER_MIN_COLUMNS,
      cursor: { block: 0, part: 0 },
    })
    expect(pane.render(95).map(stripTerminalSequences).join('\n')).toContain('still here')
  })

  it('draws nothing of its own state when invalidated', () => {
    const test = mounted()
    test.pane.invalidate()
    expect(test.draw()).toContain(' ● READER ')
  })

  it('draws the share of its rows a reveal asks for, counted from the bottom rule up', () => {
    const blocks = transcript()
    let reveal = 1
    const pane = new ReaderPane({
      palette: PLAIN,
      blocks: () => blocks,
      rows: () => 40,
      minColumns: READER_MIN_COLUMNS,
      cursor: { block: 2, part: 1 },
      reveal: () => reveal,
    })
    const whole = pane.render(95)
    expect(whole).toHaveLength(40)
    // The overlay is anchored at the bottom of the viewport, so a partial
    // reveal keeps every line it draws on the row it settles on: the bottom
    // rule arrives first and the title last.
    reveal = 0
    expect(pane.render(95)).toEqual(whole.slice(39))
    reveal = 0.5
    expect(pane.render(95)).toEqual(whole.slice(20))
    // A reveal past either end asks for no fewer than one row and no more
    // rows than the frame has.
    reveal = 2
    expect(pane.render(95)).toEqual(whole)
  })
})
